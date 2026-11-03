// fleet.dispatch — orchestrate: resolve worker → worktree → brief → validate → run →
// collect artifacts → scope check (Lớp 4) → task record (episodic-lite, luật B4)
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getManifest } from './manifests.js';
import { t } from './i18n/index.js';
import { runHeadless } from './runner.js';
import { permissionFor } from './permissions.js';
import { DEFAULT_ARTIFACTS, validateBrief, type NodeType, type TaskBrief } from './brief.js';
import { resolveWorker, loadPolicy } from './policy.js';
import { buildFleetStats, recallKB } from './memory.js';
import { changedFiles, commitAll, createWorktree, diffPatch, stageAll } from './worktree.js';
import { deliverSkills } from './skills.js';

export interface DispatchOptions {
  repo: string;
  node: NodeType;
  role: string;
  goal: string;
  scope: string[];
  constraints: string[];
  acceptance: string[];
  workerPin?: string;
  /** P5.5: model override — undefined = theo binding trong policy */
  model?: string;
  wallMs?: number;
  tags?: string[];
  /** P6.2: resume session (retry không mất context) */
  resumeSession?: string;
  /** P5.4: tắt guard hook (từ VS Code settings) */
  hooksEnabled?: boolean;
  /** skill giao cho worker (tên đã validate) — project đè global; lọc theo frontmatter workers */
  skills?: string[];
  projectId?: string | null;
  /** P5: live transcript hook */
  onEvent?: (e: import('./types.js').FleetEvent) => void;
  /** P3: tái dùng worktree đã có (verify/review/fix chạy trên worktree của implement) */
  reuseWorktree?: { path: string; branch: string };
  /** P3: orchestrator tự lắp prompt theo node — đè buildPrompt mặc định */
  promptOverride?: string;
  /** P3: ràng buộc distinct_worker_from — loại worker đã dùng ở node khác */
  excludeWorkers?: string[];
  /** user bấm Dừng → kill worker (kill_reason 'aborted') */
  signal?: AbortSignal;
  /** R2a: Orchestra router — CLI chạy qua router thay vì auth riêng */
  router?: import('./types.js').RouterInfo;
}

export interface ScopeCheck {
  ok: boolean;
  violations: { file: string; matched: string }[];
}

export interface DispatchResult {
  ok: boolean;
  taskId: string;
  stage: string;
  reason?: string;
  recordPath?: string;
  record?: Record<string, unknown>;
}

/** Chỉ node ghi code (implement + fixer chạy node implement) mới commit; verify có sandbox
 *  worktree-write để chạy test nhưng không được tạo commit (plan/review read-only). */
export function shouldCommit(node: NodeType): boolean {
  return node === 'implement';
}

// glob đơn giản không dependency: ** → .*  |  * → [^\/]*
export function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = escaped.replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*');
  return new RegExp(`^${body}$`);
}

export function checkScope(files: string[], patterns: string[]): ScopeCheck {
  const violations: ScopeCheck['violations'] = [];
  for (const f of files) {
    const norm = f.replace(/\\/g, '/');
    const matched = patterns.some((p) => globToRegex(p).test(norm));
    if (!matched) violations.push({ file: norm, matched: 'none' });
  }
  return { ok: violations.length === 0, violations };
}

// Prompt skeleton — "khung là code" (Worker Protocol §7): orchestrator thật sẽ điền
// nội dung vào slot; prototype lắp thẳng từ brief.
export function buildPrompt(b: TaskBrief): string {
  const lines: string[] = [
    'You are working in a SEPARATE git worktree — make all file changes only inside this worktree.',
    '',
    `GOAL: ${b.goal}`,
    '',
  ];
  if (b.files_in_scope.length) {
    lines.push(`FILE SCOPE (only create/edit files matching these patterns):`, ...b.files_in_scope.map((p) => `- ${p}`), '');
  }
  if (b.constraints.length) {
    lines.push('CONSTRAINTS:', ...b.constraints.map((c) => `- ${c}`), '');
  }
  if (b.forbidden_actions.length) {
    lines.push('FORBIDDEN:', ...b.forbidden_actions.map((c) => `- ${c}`), '');
  }
  if (b.acceptance_criteria.length) {
    lines.push('ACCEPTANCE CRITERIA (used for grading):', ...b.acceptance_criteria.map((c) => `- ${c}`), '');
  }
  lines.push('REQUEST: do the work in this worktree, then reply with a summary of what changed.');
  return lines.join('\n');
}

function buildPlanPrompt(b: TaskBrief): string {
  return [
    'You are in READ-ONLY (plan) mode — do not create or edit any file.',
    '',
    `TASK: ${b.goal}`,
    '',
    'Required output:',
    '1. Plan of at most 8 steps',
    '2. files_touched: list of files that will need changes (glob)',
    '3. risks: risks to watch out for',
    'Be concise and structured.',
  ].join('\n');
}

export async function dispatch(o: DispatchOptions): Promise<DispatchResult> {
  const taskId = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  // 1. Resolve worker (Role Policy từ file + track record — P4)
  const pol = loadPolicy(o.repo);
  const stats = buildFleetStats(path.join(o.repo, '.orchestra', 'tasks'), pol.policy?.routing?.decay_days ?? 30);
  const routing = resolveWorker(o.role, {
    pin: o.workerPin,
    exclude: o.excludeWorkers,
    tags: o.tags,
    policy: pol.policy,
    stats,
    router: o.router,
  });
  if (!routing.pick) {
    return { ok: false, taskId, stage: 'routing', reason: routing.reason };
  }
  const resolvedModel = o.model ?? routing.model; // explicit > policy binding > CLI mặc định
  const manifest = getManifest(routing.pick);
  if (!manifest) return { ok: false, taskId, stage: 'routing', reason: t('core.dispatch.noManifest', { id: routing.pick }) };

  // 2. TaskBrief + validate (luật B1)
  const brief: TaskBrief = {
    task_id: taskId,
    node: o.node,
    role: o.role,
    goal: o.goal,
    files_in_scope: o.scope,
    constraints: o.constraints,
    forbidden_actions: o.node === 'implement' ? ['git push', 'installing new packages', 'network'] : [],
    acceptance_criteria: o.acceptance,
    artifacts_out: DEFAULT_ARTIFACTS[o.node],
    worker: routing.pick,
    model: resolvedModel,
    tags: o.tags,
  };

  // Memory tầng 3: KB recall có trần (memory-interface §5) — inject cho node sinh nội dung
  const kb = recallKB(o.repo, brief.files_in_scope);
  brief.memory = { hits: kb.entries.map((e) => e.id), dropped: kb.dropped };
  const v = validateBrief(brief);
  if (!v.ok) {
    return { ok: false, taskId, stage: 'brief-validation', reason: v.errors.join('; ') };
  }

  // 3. Worktree isolation (Lớp 2) — hoặc tái dùng worktree của node trước (P3)
  const wt = o.reuseWorktree ?? createWorktree(o.repo, taskId);
  brief.worktree = wt.path;

  // 4. Permission theo node (Lớp 1) + chạy
  const perm = permissionFor(o.node);
  let prompt = o.promptOverride ?? (o.node === 'plan' ? buildPlanPrompt(brief) : buildPrompt(brief));
  // ngôn ngữ theo chính task của user, không theo locale UI (giữ nguyên token cố định như VERDICT)
  prompt += '\n\nLANGUAGE: write your answer in the same language as the task/goal text above; keep required fixed tokens (e.g. "VERDICT: ...") verbatim.';
  if (kb.injected && ['plan', 'implement'].includes(o.node)) {
    prompt += `\n\nPROJECT KNOWLEDGE (repo memory — follow the conventions below):\n${kb.injected}`;
  }
  // skills: claude → .claude/skills/ trong worktree; codex → section trong prompt + file phụ trợ (đều git-ignored)
  const skills = o.skills?.length ? deliverSkills(wt.path, routing.pick, o.skills, o.projectId) : undefined;
  if (skills) prompt += skills.prompt;
  const started = Date.now();
  const run = await runHeadless(manifest, prompt, {
    cwd: wt.path,
    rawDir: path.join(o.repo, '.orchestra', 'raw'),
    wallMs: o.wallMs ?? (brief.budget?.minutes ? brief.budget.minutes * 60_000 : 300_000),
    headless: { sandbox: perm.sandbox, scope: o.node === 'implement' ? o.scope : undefined, model: resolvedModel },
    onEvent: o.onEvent,
    watchDir: wt.path, // P6 Lớp 3 — Observed vs Reported
    netOff: !perm.net, // P6.2 — guard hook chặn pattern network khi net off
    resumeSession: o.resumeSession,
    hooksEnabled: o.hooksEnabled,
    signal: o.signal,
    router: o.router,
  });
  const durationMs = Date.now() - started;

  // 5. Collect artifacts (Lớp 4 — tin git status, không tin lời worker)
  stageAll(wt.path);
  const files = changedFiles(wt.path);
  const patch = diffPatch(wt.path);
  const scopeCheck = checkScope(files, o.scope);

  // 6. Task record — episodic-lite (luật B4: brief snapshot + routing log + artifacts)
  const tasksDir = path.join(o.repo, '.orchestra', 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  const patchPath = path.join(tasksDir, `${taskId}.patch`);
  if (patch) writeFileSync(patchPath, patch, 'utf8');

  const usageEvents = run.events.filter((e) => e.t === 'usage');
  const lastUsage = usageEvents[usageEvents.length - 1] ?? null;
  const eventCounts: Record<string, number> = {};
  for (const e of run.events) eventCounts[e.t] = (eventCounts[e.t] ?? 0) + 1;
  const msgEvents = run.events.filter((e) => e.t === 'message' && typeof e['text'] === 'string');
  const lastMessage = msgEvents.length ? (msgEvents[msgEvents.length - 1]!['text'] as string) : undefined;
  // implement (kể cả fixer) không đổi file nào = thất bại, dù exit 0 — vd sandbox chặn shell
  const noChange = o.node === 'implement' && files.length === 0;

  const record = {
    id: taskId,
    ts: new Date().toISOString(),
    node: o.node,
    role: o.role,
    routing: { pick: routing.pick, model: resolvedModel ?? null, reason: routing.reason },
    brief, // B4 snapshot
    permission: perm,
    worktree: wt,
    run: {
      exit: run.exitCode,
      killed: run.killed,
      kill_reason: run.killReason ?? null,
      duration_ms: durationMs,
      raw_ref: run.rawPath,
      unmapped_lines: run.unmappedLines,
      event_counts: eventCounts,
      stderr_tail: run.stderrTail.slice(0, 500),
    },
    usage: lastUsage
      ? { tokens_in: lastUsage['tokens_in'] ?? null, tokens_out: lastUsage['tokens_out'] ?? null, usd: lastUsage['usd'] ?? null }
      : null,
    artifacts: { files_changed: files, patch_ref: patch ? patchPath : null },
    ...(skills ? { skills: { delivered: skills.delivered, skipped: skills.skipped } } : {}),
    ...(noChange ? { outcome: 'no_change' } : {}),
    last_message: lastMessage,
    session: run.session ?? null,
    fs_cross_check: run.fsCrossCheck,
    scope_check: scopeCheck,
    acceptance_note: 'P2 does not run gates itself — acceptance_criteria stored in the record for the P3 gate runner',
  };
  const recordPath = path.join(tasksDir, `${taskId}.json`);
  writeFileSync(recordPath, JSON.stringify(record, null, 2), 'utf8');

  // P3: commit thay đổi lên branch của worktree để merge gate merge được — kể cả worktree tái dùng (fixer)
  if (shouldCommit(o.node)) {
    commitAll(wt.path, `orchestra: ${o.node} ${taskId}`);
  }

  if (noChange) {
    return {
      ok: false,
      taskId,
      stage: 'no_change',
      reason: t('core.dispatch.noChange', { exit: String(run.exitCode), message: (lastMessage ?? '').slice(0, 300), stderr: run.stderrTail.slice(0, 300) }),
      recordPath,
      record,
    };
  }
  return {
    ok: !run.killed && run.exitCode === 0 && scopeCheck.ok,
    taskId,
    stage: 'done',
    recordPath,
    record,
  };
}
