import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, createWriteStream, watch, existsSync, writeFileSync, realpathSync, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FleetEvent, HeadlessOpts, Manifest, RouterInfo } from './types.js';
import { protoAsset } from './paths.js';
import { t } from './i18n/index.js';
import { changedFiles as gitChangedFiles, isGitRepo } from './worktree.js';

// ---------- Supervisor Layer 3 helpers (Worker Protocol §9b) ----------

/** Livestock: same tool_use repeated ≥ N times with the same result → stuck (§9b signal 3) */
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
 * Cross-check Observed vs Reported (§9b): a file changed in the worktree (Observed — fs.watch)
 * that no tool_use mentions (Reported) = anomaly.
 * Match heuristic: the changed file's basename appears in some tool_use target.
 * Bash can write files whose name isn't in the target → possible false positives; used as
 * a flag signal (no auto-kill) — per spec: "flag immediately, don't wait for the gate".
 */
export function computeFsCrossCheck(changed: string[], targets: string[]): { ok: boolean; unreported: string[] } {
  const baselines = targets.map((t) => t.replace(/\\/g, '/').toLowerCase());
  const unreported = changed.filter((f) => {
    const norm = f.replace(/\\/g, '/');
    const base = path.basename(norm).toLowerCase();
    if (!base.includes('.')) return false; // directory / path without extension — settle event, not a written file
    return !baselines.some((t) => t.includes(base));
  });
  return { ok: unreported.length === 0, unreported };
}

/**
 * fs.watch also fires for files git just checked out when creating the worktree → keep only files git sees as really changed
 * (porcelain before stageAll: modified + untracked; untracked dirs show as `dir/`). Not git → unchanged.
 */
export function filterRealChanges(watchDir: string, fsChanged: string[]): string[] {
  if (!isGitRepo(watchDir)) return fsChanged;
  const real = gitChangedFiles(watchDir).map((f) => f.replace(/\\/g, '/'));
  return fsChanged.filter((f) => real.some((g) => g === f || (g.endsWith('/') && f.startsWith(g))));
}

/**
 * Find guard.cjs: prototype/dist → prototype/hooks; <pkg>/out/prototype/src → repo/prototype/hooks
 * (extension/desktop dev) — same path for packaged desktop: resources/app.asar/out/prototype/src
 * → resources/prototype/hooks (extraResources, outside asar since the hook is run by an external `node`).
 */
export function resolveGuardHook(fromFile = fileURLToPath(import.meta.url)): string | undefined {
  return protoAsset(path.join('hooks', 'guard.cjs'), fromFile);
}

/**
 * args + env spawn: PreToolUse hook (manifest.hookArgs codex -c | claude --settings) + router (manifest.routerArgs).
 * claude: hooks + router env merged into EXACTLY 1 `--settings`; with router → inline JSON (token never written to disk),
 * hooks only → file as before. Prompt is always the last arg — insert before it.
 */
export function spawnArgs(
  m: Manifest,
  args: string[],
  o: { hookScript?: string; rawDir: string; router?: RouterInfo; model?: string },
): { args: string[]; env: Record<string, string> } {
  const rt = o.router && m.routerArgs ? m.routerArgs(o.router, o.model) : {};
  const extra: string[] = [];
  const settings: Record<string, unknown> = {};
  if (o.hookScript && m.hookArgs) extra.push(...m.hookArgs(`node "${o.hookScript.replace(/\\/g, '/')}"`));
  else if (o.hookScript) {
    settings.hooks = {
      PreToolUse: [{ matcher: 'Bash|Write|Edit|MultiEdit', hooks: [{ type: 'command', command: `node "${o.hookScript}"` }] }],
    };
  }
  if (rt.settingsEnv) {
    settings.env = rt.settingsEnv;
    extra.push('--settings', JSON.stringify(settings));
  } else if (settings.hooks) {
    const settingsPath = path.join(o.rawDir, `guard-settings-${Date.now()}.json`);
    mkdirSync(o.rawDir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings), 'utf8');
    extra.push('--settings', settingsPath);
  }
  extra.push(...(rt.args ?? []));
  return { args: [...args.slice(0, -1), ...extra, args[args.length - 1]!], env: rt.env ?? {} };
}

export interface RunOptions {
  cwd: string;
  rawDir: string;
  silenceMs?: number; // default 120s — no line from the CLI
  wallMs?: number; // default 300s — total time
  headless?: HeadlessOpts;
  /** P5: callback per normalized event — used for the live transcript in the IDE */
  onEvent?: (e: FleetEvent) => void;
  /** P6: directory to fs.watch (Observed) — usually the worktree */
  watchDir?: string;
  /** P6.2: net off → guard hook blocks network patterns (case 8) */
  netOff?: boolean;
  /** P6.2: resume a CLI session */
  resumeSession?: string;
  /** P5.4: disable the guard hook (setting orchestra.hooksEnabled) */
  hooksEnabled?: boolean;
  /** abort (user clicks Stop) → kill the process tree, kill_reason 'aborted' */
  signal?: AbortSignal;
  /** R2a: set → CLI runs through the Orchestra router; unset → CLI uses its own auth */
  router?: RouterInfo;
}

export interface RunResult {
  exitCode: number | null;
  killed: boolean;
  killReason?: string;
  stderrTail: string;
  events: FleetEvent[];
  rawPath: string;
  rawLines: number;
  unmappedLines: number; // valid raw JSONL the adapter doesn't recognize — conformance signal
  /** P6.2: session id from the first session event — used for resume */
  session?: string;
  /** P6 — Supervisor Layer 3 */
  fsChanged: string[]; // Observed: files changed in watchDir
  toolTargets: string[]; // Reported: targets of every tool_use
  fsCrossCheck: { ok: boolean; unreported: string[] };
}

function killTree(child: ChildProcess, reason: string): void {
  (child as ChildProcess & { __killReason?: string }).__killReason = reason;
  if (process.platform === 'win32' && child.pid) {
    // Job Objects aren't in Node core yet → taskkill /T kills child processes too
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

  // P6.2 — hooks pre-execution + R2a router: splice into args before the prompt
  const extraEnv: Record<string, string> = {};
  let guardMissing: FleetEvent | undefined;
  let hookScript: string | undefined;
  if (m.hooksSupport && opts.hooksEnabled !== false) {
    hookScript = resolveGuardHook();
    if (!hookScript) {
      guardMissing = { t: 'error', worker: m.id, ts: new Date().toISOString(), code: 'guard_missing', detail: t('core.runner.guardMissing') };
    } else {
      extraEnv['ORCH_GUARD_ROOT'] = opts.cwd;
      if (opts.netOff) extraEnv['ORCH_GUARD_NET'] = 'off';
    }
  }
  const sp = spawnArgs(m, spec.args, { hookScript, rawDir: opts.rawDir, router: opts.router, model: headless.model });
  spec.args = sp.args;
  Object.assign(extraEnv, sp.env);

  mkdirSync(opts.rawDir, { recursive: true });
  const rawPath = path.join(opts.rawDir, `${Date.now()}-${m.id}.jsonl`);
  const raw = createWriteStream(rawPath, { encoding: 'utf8' });

  let child: ChildProcess;
  try {
    child = spawn(spec.cmd, spec.args, {
      cwd: opts.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], // prompt via args, stdin closed — CLI doesn't wait on the pipe
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
  if (guardMissing) {
    events.push(guardMissing);
    opts.onEvent?.(guardMissing);
  }
  let rawLines = 0;
  let unmappedLines = 0;
  let killed = false;
  let capturedSession: string | undefined;
  const stderrChunks: string[] = [];

  // P6 — Layer 3: Observed (fs.watch) + Reported (tool_use) + livelock
  const changedFiles = new Set<string>();
  const toolTargets: string[] = [];
  const livelock = new LivelockDetector(5);
  let fsWatcher: FSWatcher | undefined;
  if (opts.watchDir && existsSync(opts.watchDir)) {
    try {
      // realpath: 8.3 paths (NITROV~1) make libuv fs-event assert → crashes the whole process (seen on Windows)
      fsWatcher = watch(realpathSync.native(opts.watchDir), { recursive: true }, (_ev, filename) => {
        if (!filename) return;
        const rel = path.relative(opts.watchDir!, path.join(opts.watchDir!, filename.toString()));
        if (rel && !rel.startsWith('.git') && !rel.includes('node_modules')) changedFiles.add(rel.replace(/\\/g, '/'));
        resetSilence();
      });
    } catch {
      /* watch failed — Observed unavailable, only Reported remains */
    }
  }

  const resetSilence = () => {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => killTree(child, 'silence_timeout'), silenceMs);
  };
  let silenceTimer: NodeJS.Timeout = setTimeout(() => {}, 0);
  const wallTimer = setTimeout(() => killTree(child, 'wall_clock_exceeded'), wallMs);
  const onAbort = () => killTree(child, 'aborted');
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener('abort', onAbort, { once: true });

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
      unmappedLines++; // non-JSON line (banner, warning…) — raw is still kept
      return;
    }
    const { events: mapped, known } = m.mapEvent(parsed, m.id);
    if (!known) unmappedLines++;
    // P6.2: capture session id for resume
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
        // Layer 3 signal 3: livelock — kill + blocked event
        if (livelock.feed(String(e['tool'] ?? '?'), target)) {
          events.push({ t: 'blocked', worker: m.id, ts: new Date().toISOString(), code: 'livelock_stuck', detail: t('core.runner.livelock', { target: target.slice(0, 120) }) });
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
      opts.signal?.removeEventListener('abort', onAbort);
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
        const fsChanged = opts.watchDir ? filterRealChanges(opts.watchDir, [...changedFiles]) : [...changedFiles];
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
