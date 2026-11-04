// fleet.dispatch — orchestrate: resolve worker → worktree → brief → validate → run →
// collect artifacts → scope check (Layer 4) → task record (episodic-lite, rule B4)
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
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
  /** P5.5: model override — undefined = use the policy binding */
  model?: string;
  wallMs?: number;
  tags?: string[];
  /** P6.2: resume session (retry without losing context) */
  resumeSession?: string;
  /** P5.4: disable the guard hook (from VS Code settings) */
  hooksEnabled?: boolean;
  /** skills handed to the worker (validated names) — project overrides global; filtered by frontmatter workers */
  skills?: string[];
  projectId?: string | null;
  /** P5: live transcript hook */
  onEvent?: (e: import('./types.js').FleetEvent) => void;
  /** P3: reuse an existing worktree (verify/review/fix run on the implement worktree) */
  reuseWorktree?: { path: string; branch: string };
  /** P3: orchestrator builds the prompt per node — overrides the default buildPrompt */
  promptOverride?: string;
  /** P3: distinct_worker_from constraint — exclude workers used on other nodes */
  excludeWorkers?: string[];
  /** user clicks Stop → kill worker (kill_reason 'aborted') */
  signal?: AbortSignal;
  /** R2a: Orchestra router — CLI runs through the router instead of its own auth */
  router?: import('./types.js').RouterInfo;
  /** user-attached reference images (absolute source paths) — copied into the worktree, git-ignored */
  images?: string[];
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

/** Only code-writing nodes (implement + fixer running the implement node) commit; verify has a
 *  worktree-write sandbox to run tests but must not create commits (plan/review are read-only). */
export function shouldCommit(node: NodeType): boolean {
  return node === 'implement';
}

// simple dependency-free glob: ** → .*  |  * → [^\/]*
export function globToRegex(pattern: string): RegExp {
  // ** = .*, * = [^/]*, {a,b} = (?:a|b) (nestable); everything else escaped
  let body = '';
  let depth = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*') {
      if (pattern[i + 1] === '*') { body += '.*'; i++; } else body += '[^/]*';
    } else if (c === '{') { depth++; body += '(?:'; }
    else if (c === '}' && depth) { depth--; body += ')'; }
    else if (c === ',' && depth) body += '|';
    else body += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${body}${')'.repeat(depth)}$`);
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

// Prompt skeleton — "the frame is code" (Worker Protocol §7): the real orchestrator fills
// the slots; the prototype assembles directly from the brief.
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

/** copy reference images into <worktree>/.orchestra/images/ (git-ignored → never in the diff/scope check) */
export function deliverImages(wtPath: string, images: string[]): { rel: string[]; abs: string[] } {
  if (!images.length) return { rel: [], abs: [] };
  const dir = path.join(wtPath, '.orchestra', 'images');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '.gitignore'), '*\n', 'utf8');
  const rel = images.map((src) => {
    copyFileSync(src, path.join(dir, path.basename(src)));
    return `.orchestra/images/${path.basename(src)}`;
  });
  return { rel, abs: rel.map((r) => path.join(wtPath, r)) };
}

export async function dispatch(o: DispatchOptions): Promise<DispatchResult> {
  const taskId = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  // 1. Resolve worker (Role Policy from file + track record — P4)
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
  const resolvedModel = o.model ?? routing.model; // explicit > policy binding > CLI default
  const manifest = getManifest(routing.pick);
  if (!manifest) return { ok: false, taskId, stage: 'routing', reason: t('core.dispatch.noManifest', { id: routing.pick }) };

  // 2. TaskBrief + validate (rule B1)
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

  // Memory tier 3: capped KB recall (memory-interface §5) — injected for content-producing nodes
  const kb = recallKB(o.repo, brief.files_in_scope);
  brief.memory = { hits: kb.entries.map((e) => e.id), dropped: kb.dropped };
  const v = validateBrief(brief);
  if (!v.ok) {
    return { ok: false, taskId, stage: 'brief-validation', reason: v.errors.join('; ') };
  }

  // 3. Worktree isolation (Layer 2) — or reuse the previous node's worktree (P3)
  const wt = o.reuseWorktree ?? createWorktree(o.repo, taskId);
  brief.worktree = wt.path;

  // 4. Permission per node (Layer 1) + run
  const perm = permissionFor(o.node);
  let prompt = o.promptOverride ?? (o.node === 'plan' ? buildPlanPrompt(brief) : buildPrompt(brief));
  // language follows the user's task itself, not the UI locale (fixed tokens like VERDICT kept verbatim)
  prompt += '\n\nLANGUAGE: write your answer in the same language as the task/goal text above; keep required fixed tokens (e.g. "VERDICT: ...") verbatim.';
  if (kb.injected && ['plan', 'implement'].includes(o.node)) {
    prompt += `\n\nPROJECT KNOWLEDGE (repo memory — follow the conventions below):\n${kb.injected}`;
  }
  // skills: claude → .claude/skills/ in the worktree; codex → prompt section + support files (all git-ignored)
  const skills = o.skills?.length ? deliverSkills(wt.path, routing.pick, o.skills, o.projectId) : undefined;
  if (skills) prompt += skills.prompt;
  const imgs = deliverImages(wt.path, o.images ?? []);
  if (imgs.rel.length) {
    prompt += `\n\nREFERENCE IMAGES from the user (screenshots/mockups — look at them before working; they are the source of truth for visual details):\n${imgs.rel.map((r) => `- ${r}`).join('\n')}`
      + (routing.pick === 'claude' ? '\nOpen each one with the Read tool.' : '');
  }
  const started = Date.now();
  const run = await runHeadless(manifest, prompt, {
    cwd: wt.path,
    rawDir: path.join(o.repo, '.orchestra', 'raw'),
    wallMs: o.wallMs ?? (brief.budget?.minutes ? brief.budget.minutes * 60_000 : 300_000),
    headless: { sandbox: perm.sandbox, scope: o.node === 'implement' ? o.scope : undefined, model: resolvedModel, images: imgs.abs.length ? imgs.abs : undefined },
    onEvent: o.onEvent,
    watchDir: wt.path, // P6 Layer 3 — Observed vs Reported
    netOff: !perm.net, // P6.2 — guard hook blocks network patterns when net is off
    resumeSession: o.resumeSession,
    hooksEnabled: o.hooksEnabled,
    signal: o.signal,
    router: o.router,
  });
  const durationMs = Date.now() - started;

  // 5. Collect artifacts (Layer 4 — trust git status, not the worker's word)
  stageAll(wt.path);
  const files = changedFiles(wt.path);
  const patch = diffPatch(wt.path);
  const scopeCheck = checkScope(files, o.scope);

  // 6. Task record — episodic-lite (rule B4: brief snapshot + routing log + artifacts)
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
  // implement (incl. fixer) changing no files = failure, even with exit 0 — e.g. sandbox blocked the shell
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

  // P3: commit changes to the worktree branch so the merge gate can merge — including reused worktrees (fixer)
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
