import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, createWriteStream, watch, existsSync, writeFileSync, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { FleetEvent, HeadlessOpts, Manifest } from './types.js';
import { resolveVaultEnv } from './vault.js';

// ---------- Supervisor Lớp 3 helpers (Worker Protocol §9b) ----------

/** Livestock: cùng tool_use lặp ≥ N lần cùng kết quả → stuck (§9b tín hiệu 3) */
export class LivelockDetector {
  private lastKey = '';
  private count = 0;
  constructor(private threshold = 5) {}
  feed(tool: string, target: string): boolean {
    const key = `${tool}::${target}`;
    if (key === this.lastKey) this.count++;
    else {
      this.lastKey = key;
      this.count = 1;
    }
    return this.count >= this.threshold;
  }
}

/**
 * Cross-check Observed vs Reported (§9b): file đổi trong worktree (Observed — fs.watch)
 * mà không có tool_use nào nhắc tới (Reported) = bất thường.
 * Heuristic khớp: basename của file đổi xuất hiện trong target của tool_use nào đó.
 * Bash có thể ghi file mà target không chứa tên file → có thể false-positive; dùng làm
 * tín hiệu đánh dấu (không auto-kill) — đúng spec: "đánh dấu ngay, không chờ gate".
 */
export function computeFsCrossCheck(changed: string[], targets: string[]): { ok: boolean; unreported: string[] } {
  const baselines = targets.map((t) => t.replace(/\\/g, '/').toLowerCase());
  const unreported = changed.filter((f) => {
    const norm = f.replace(/\\/g, '/');
    const base = path.basename(norm).toLowerCase();
    if (!base.includes('.')) return false; // thư mục / path không đuôi file — event settle, không phải file ghi
    return !baselines.some((t) => t.includes(base));
  });
  return { ok: unreported.length === 0, unreported };
}

export interface RunOptions {
  cwd: string;
  rawDir: string;
  silenceMs?: number; // mặc định 120s — không có dòng nào từ CLI
  wallMs?: number; // mặc định 300s — tổng thời gian
  headless?: HeadlessOpts;
  /** P5: callback từng event chuẩn hoá — dùng cho live transcript trong IDE */
  onEvent?: (e: FleetEvent) => void;
  /** P6: thư mục để fs.watch (Observed) — thường là worktree */
  watchDir?: string;
  /** P6.2: net off → guard hook chặn pattern network (case 8) */
  netOff?: boolean;
  /** P6.2: resume session của CLI */
  resumeSession?: string;
  /** P5.4: tắt guard hook (setting orchestra.hooksEnabled) */
  hooksEnabled?: boolean;
}

export interface RunResult {
  exitCode: number | null;
  killed: boolean;
  killReason?: string;
  stderrTail: string;
  events: FleetEvent[];
  rawPath: string;
  rawLines: number;
  unmappedLines: number; // raw JSONL hợp lệ nhưng adapter không nhận diện — conformance signal
  /** P6.2: session id từ event session đầu tiên — dùng cho resume */
  session?: string;
  /** P6 — Supervisor Lớp 3 */
  fsChanged: string[]; // Observed: file đổi trong watchDir
  toolTargets: string[]; // Reported: target của mọi tool_use
  fsCrossCheck: { ok: boolean; unreported: string[] };
}

function killTree(child: ChildProcess, reason: string): void {
  (child as ChildProcess & { __killReason?: string }).__killReason = reason;
  if (process.platform === 'win32' && child.pid) {
    // Job Object chưa có trong Node core → taskkill /T giết cả tiến trình con
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGKILL');
  }
}

export async function runHeadless(m: Manifest, prompt: string, opts: RunOptions): Promise<RunResult> {
  const silenceMs = opts.silenceMs ?? 120_000;
  const wallMs = opts.wallMs ?? 300_000;
  const headless: HeadlessOpts = { sandbox: 'read-only', ...(opts.headless ?? {}) };
  if (opts.resumeSession) headless.resume = opts.resumeSession;
  const spec = m.headless(prompt, headless);

  // P6.2 — hooks pre-execution: CLI hỗ trợ → sinh settings file + splice vào args
  const extraEnv: Record<string, string> = {};
  if (m.hooksSupport && opts.hooksEnabled !== false) {
    const hookScript = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'hooks', 'guard.cjs');
    if (existsSync(hookScript)) {
      const settingsPath = path.join(opts.rawDir, `guard-settings-${Date.now()}.json`);
      mkdirSync(opts.rawDir, { recursive: true });
      writeFileSync(
        settingsPath,
        JSON.stringify({
          hooks: {
            PreToolUse: [
              { matcher: 'Bash|Write|Edit|MultiEdit', hooks: [{ type: 'command', command: `node "${hookScript}"` }] },
            ],
          },
        }),
        'utf8',
      );
      // prompt luôn là arg cuối — chèn --settings trước nó
      const last = spec.args[spec.args.length - 1]!;
      spec.args = [...spec.args.slice(0, -1), '--settings', settingsPath, last];
      extraEnv['ORCH_GUARD_ROOT'] = opts.cwd;
      if (opts.netOff) extraEnv['ORCH_GUARD_NET'] = 'off';
    }
  }
  if (m.vault) {
    // P6.4: vault entry {secret, base_url} → env key + env base_url (custom provider)
    Object.assign(extraEnv, resolveVaultEnv(m));
  }

  mkdirSync(opts.rawDir, { recursive: true });
  const rawPath = path.join(opts.rawDir, `${Date.now()}-${m.id}.jsonl`);
  const raw = createWriteStream(rawPath, { encoding: 'utf8' });

  let child: ChildProcess;
  try {
    child = spawn(spec.cmd, spec.args, {
      cwd: opts.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], // prompt qua args, đóng stdin — CLI không chờ pipe
      env: Object.keys(extraEnv).length ? { ...process.env, ...extraEnv } : process.env,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const failEv: FleetEvent = { t: 'error', worker: m.id, ts: new Date().toISOString(), code: 'spawn_failed', detail: msg };
    return {
      exitCode: -1,
      killed: false,
      stderrTail: msg,
      events: [failEv, { t: 'done', worker: m.id, ts: new Date().toISOString(), exit: -1 }],
      rawPath,
      rawLines: 0,
      unmappedLines: 0,
      fsChanged: [],
      toolTargets: [],
      fsCrossCheck: { ok: true, unreported: [] },
    };
  }

  const events: FleetEvent[] = [];
  let rawLines = 0;
  let unmappedLines = 0;
  let killed = false;
  let capturedSession: string | undefined;
  const stderrChunks: string[] = [];

  // P6 — Lớp 3: Observed (fs.watch) + Reported (tool_use) + livelock
  const changedFiles = new Set<string>();
  const toolTargets: string[] = [];
  const livelock = new LivelockDetector(5);
  let fsWatcher: FSWatcher | undefined;
  if (opts.watchDir && existsSync(opts.watchDir)) {
    try {
      fsWatcher = watch(opts.watchDir, { recursive: true }, (_ev, filename) => {
        if (!filename) return;
        const rel = path.relative(opts.watchDir!, path.join(opts.watchDir!, filename.toString()));
        if (rel && !rel.startsWith('.git') && !rel.includes('node_modules')) changedFiles.add(rel.replace(/\\/g, '/'));
        resetSilence();
      });
    } catch {
      /* watch fail — Observed không khả dụng, chỉ còn Reported */
    }
  }

  const resetSilence = () => {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => killTree(child, 'silence_timeout'), silenceMs);
  };
  let silenceTimer: NodeJS.Timeout = setTimeout(() => {}, 0);
  const wallTimer = setTimeout(() => killTree(child, 'wall_clock_exceeded'), wallMs);

  const handleRawLine = (line: string) => {
    rawLines++;
    raw.write(line + '\n');
    resetSilence();
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      unmappedLines++; // dòng không phải JSON (banner, warning…) — raw vẫn được giữ
      return;
    }
    const { events: mapped, known } = m.mapEvent(parsed, m.id);
    if (!known) unmappedLines++;
    // P6.2: capture session id cho resume
    if (!capturedSession) {
      const sess = mapped.find((e) => e.t === 'session' && typeof e['session'] === 'string');
      if (sess) capturedSession = sess['session'] as string;
    }
    events.push(...mapped);
    if (opts.onEvent) for (const e of mapped) opts.onEvent(e);
    for (const e of mapped) {
      if (e.t === 'tool_use') {
        const target = typeof e['target'] === 'string' ? (e['target'] as string) : JSON.stringify(e['target'] ?? '');
        toolTargets.push(target);
        // Lớp 3 tín hiệu 3: livelock — kill + blocked event
        if (livelock.feed(String(e['tool'] ?? '?'), target)) {
          events.push({ t: 'blocked', worker: m.id, ts: new Date().toISOString(), code: 'livelock_stuck', detail: `cùng tool_use lặp ≥5: ${target.slice(0, 120)}` });
          killTree(child, 'livelock_stuck');
        }
      }
    }
  };

  const stdoutRl = createInterface({ input: child.stdout! });
  stdoutRl.on('line', handleRawLine);
  child.stderr?.on('data', (d: Buffer) => {
    stderrChunks.push(d.toString());
    if (stderrChunks.length > 64) stderrChunks.shift();
    resetSilence();
  });

  const result = await new Promise<RunResult>((resolve) => {
    const finish = (exitCode: number | null) => {
      clearTimeout(silenceTimer);
      clearTimeout(wallTimer);
      fsWatcher?.close();
      raw.end(() => {
        const killReason = (child as ChildProcess & { __killReason?: string }).__killReason;
        killed = killReason !== undefined;
        const doneEv: FleetEvent = {
          t: 'done',
          worker: m.id,
          ts: new Date().toISOString(),
          exit: exitCode,
          ...(killed ? { kill_reason: killReason } : {}),
        };
        events.push(doneEv);
        opts.onEvent?.(doneEv);
        const fsChanged = [...changedFiles];
        resolve({
          exitCode,
          killed,
          killReason,
          stderrTail: stderrChunks.join('').slice(-2000),
          events,
          rawPath,
          rawLines,
          unmappedLines,
          session: capturedSession,
          fsChanged,
          toolTargets,
          fsCrossCheck: computeFsCrossCheck(fsChanged, toolTargets),
        });
      });
    };
    child.on('error', (err) => {
      events.push({ t: 'error', worker: m.id, ts: new Date().toISOString(), code: 'process_error', detail: err.message });
    });
    child.on('close', (code) => finish(code));
  });

  return result;
}
