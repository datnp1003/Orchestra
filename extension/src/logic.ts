// Pure logic — does NOT import vscode (testable with plain node, P5 gate)
import { MANIFESTS } from '../../prototype/src/manifests.js';
import { checkStatus, checkStatusAsync, type WorkerStatus } from '../../prototype/src/registry.js';
import { loadPolicy, resolveWorker, DEFAULT_BINDINGS, type PolicyFile } from '../../prototype/src/policy.js';
import { buildFleetStats, loadKB, addFeedback, recallKB } from '../../prototype/src/memory.js';
import { routerModelOk, type ProviderConfig } from '../../prototype/src/router/providers.js';
import type { RouterInfo } from '../../prototype/src/types.js';
import { protoAsset } from '../../prototype/src/paths.js';
import { mergeBranch } from '../../prototype/src/worktree.js';
import { globToRegex } from '../../prototype/src/dispatch.js';
import { t } from '../../prototype/src/i18n/index.js';
import { renderMemoryBlock, writeMemoryOps, type CallModel, type ScopedOp } from '../../prototype/src/agentMemory.js';
import { availableSkills } from '../../prototype/src/skills.js';
import { needsApproval, MODE_PROMPT, PLAN_BLOCKED, isPermissionMode, type ApprovalAction, type ApprovalKind, type PermissionMode } from '../../prototype/src/permissions.js';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as yaml from 'js-yaml';
import path from 'node:path';

export const FALLBACK_REPO = 'C:/Users/Nitro V 15/Desktop/Source/Orchestra/prototype/demo-repo';

/** router = CLI with routerArgs (auth goes through Orchestra router) */
export function fleetSnapshot(): FleetRow[] {
  return MANIFESTS.map((m) => fleetRow(m, checkStatus(m)));
}
/** Desktop main: probe all CLIs in parallel, no spawnSync (doesn't block IPC/UI) */
export const fleetSnapshotAsync = (): Promise<FleetRow[]> => Promise.all(MANIFESTS.map(async (m) => fleetRow(m, await checkStatusAsync(m))));
type FleetRow = { id: string; display: string; installed: boolean; version?: string; auth: string; router: boolean };
const fleetRow = (m: (typeof MANIFESTS)[number], s: WorkerStatus): FleetRow =>
  ({ id: m.id, display: m.display, installed: s.installed, version: s.version, auth: s.auth, router: !!m.routerArgs });

/** R2a: router models (/v1/models) + which worker can run which model (routerModelOk) */
export function modelsList(ids: string[], providers: ProviderConfig[]): {
  models: string[];
  byWorker: Record<string, { id: string; ok: boolean; reason: string }[]>;
} {
  return {
    models: ids,
    byWorker: Object.fromEntries(MANIFESTS.map((m) => [m.id, ids.map((id) => ({ id, ...routerModelOk(m.id, id, providers) }))])),
  };
}

/** limit: read only the N newest files (file names sort by time) — don't parse everything then discard */
export function tasksSnapshot(repo = FALLBACK_REPO, limit = 20): { id: string; node: string; worker: string; exit: number | null; scopeOk: boolean; files: number }[] {
  const dir = path.join(repo, '.orchestra', 'tasks');
  if (!existsSync(dir)) return [];
  const n = Math.min(Math.max(Math.trunc(Number(limit)) || 20, 1), 200); // limit comes from IPC → clamp
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, n)
    .map((f) => {
      try {
        const r = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
        return {
          id: String(r.id ?? f),
          node: String(r.node ?? '?'),
          worker: String(r.routing?.pick ?? r.brief?.worker ?? '?'),
          exit: r.run?.exit ?? null,
          scopeOk: r.scope_check?.ok !== false,
          files: r.artifacts?.files_changed?.length ?? 0,
        };
      } catch {
        return null;
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

// ---------- Review & Merge (P5.2) ----------
export interface MergeableTask {
  id: string;
  node: string;
  worker: string;
  branch: string;
  worktreePath?: string;
  patchRef?: string | null;
  files: string[];
}

function git(repo: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

/** Tasks with a worktree branch not yet merged into main — Review & Merge candidates */
export function mergeableTasks(repo = FALLBACK_REPO): MergeableTask[] {
  const dir = path.join(repo, '.orchestra', 'tasks');
  if (!existsSync(dir)) return [];
  const out: MergeableTask[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort().reverse()) {
    try {
      const r = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
      const branch = r.worktree?.branch as string | undefined;
      if (!branch) continue;
      const exists = git(repo, ['rev-parse', '--verify', `refs/heads/${branch}`]);
      if (!exists.ok) continue;
      const ancestor = git(repo, ['merge-base', '--is-ancestor', branch, 'HEAD']);
      if (ancestor.ok) continue; // already merged
      out.push({
        id: String(r.id ?? f),
        node: String(r.node ?? '?'),
        worker: String(r.routing?.pick ?? '?'),
        branch,
        worktreePath: r.worktree?.path,
        patchRef: r.artifacts?.patch_ref ?? null,
        files: r.artifacts?.files_changed ?? [],
      });
    } catch {
      /* ignore */
    }
  }
  return out;
}

export function reviewMerge(repo: string, taskId: string, action: 'merge' | 'reject'): { ok: boolean; detail: string } {
  const task = mergeableTasks(repo).find((t) => t.id === taskId);
  if (!task) return { ok: false, detail: t('ext.review.notMergeable', { id: taskId }) };
  if (action === 'merge') {
    const m = mergeBranch(repo, task.branch);
    return { ok: m.ok, detail: m.ok ? `merged ${task.branch}` : `merge conflict: ${m.out.slice(-200)}` };
  }
  addFeedback(repo, { type: 'verdict_rejected', taskId, worker: task.worker, detail: 'user rejected in Review & Merge UI' });
  return { ok: true, detail: t('ext.review.rejected', { worker: task.worker }) };
}

// ---------- Policy editable (P5.3): click cell = promote worker to #1 ----------
export function promoteWorker(repo: string, role: string, cli: string): { ok: boolean; detail: string } {
  const lp = loadPolicy(repo);
  const basePolicy: PolicyFile = lp.policy ?? { version: 1 };
  const bindings: PolicyFile['bindings'] = {};
  for (const [r, binds] of Object.entries(basePolicy.bindings ?? {})) {
    bindings[r] = binds.map((b) => ({ worker: { ...b.worker }, ...(b.boost_when ? { boost_when: b.boost_when } : {}) }));
  }
  for (const [r, ids] of Object.entries(DEFAULT_BINDINGS)) {
    if (!bindings[r]) bindings[r] = ids.map((cli2) => ({ worker: { cli: cli2 } }));
  }
  if (!bindings[role]) return { ok: false, detail: t('ext.promote.noBindings', { role }) };
  const idx = bindings[role]!.findIndex((b) => b.worker.cli === cli);
  if (idx < 0) return { ok: false, detail: t('ext.promote.notInBindings', { cli, role }) };
  if (idx === 0) return { ok: true, detail: t('ext.promote.already', { cli, role }) };

  const moved = bindings[role]!.splice(idx, 1)[0]!;
  bindings[role]!.unshift(moved);

  const out: PolicyFile = { ...basePolicy, version: basePolicy.version ?? 1, bindings };
  mkdirSync(path.join(repo, '.orchestra'), { recursive: true });
  const file = path.join(repo, '.orchestra', 'policy.yml');
  writeFileSync(file, yaml.dump(out, { lineWidth: 120 }), 'utf8');

  const check = loadPolicy(repo);
  return {
    ok: check.source === 'project' && check.errors.length === 0,
    detail: t('ext.promote.done', { cli, role, file, source: check.source, errors: check.errors.length ? `, errors: ${check.errors.join('; ')}` : '' }),
  };
}

export function restoreDefaultPolicy(repo: string): boolean {
  const f = path.join(repo, '.orchestra', 'policy.yml');
  if (!existsSync(f)) return false;
  rmSync(f);
  return true;
}

// ---------- Override tracking (P5.3): user picked a worker other than auto-pick ----------
export function trackOverride(
  repo: string,
  o: { autoPick?: string; pin?: string; taskId?: string; ok: boolean },
): { tracked: boolean; detail: string } {
  if (!o.ok) return { tracked: false, detail: t('ext.override.failed') };
  if (!o.pin || !o.autoPick || o.pin === o.autoPick) return { tracked: false, detail: t('ext.override.none') };
  addFeedback(repo, {
    type: 'task_reassigned',
    taskId: o.taskId,
    worker: o.pin,
    detail: `user override from auto-pick '${o.autoPick}'`,
  });
  return { tracked: true, detail: t('ext.override.tracked', { from: o.autoPick, to: o.pin }) };
}

export async function dispatchTracked(
  repo: string,
  o: { node: 'implement' | 'plan'; role: string; goal: string; scope: string[]; acceptance: string[]; pin?: string; model?: string; onEvent?: (e: { t: string; [k: string]: unknown }) => void; hooksEnabled?: boolean; skills?: string[]; projectId?: string | null; signal?: AbortSignal; router?: RouterInfo; promptOverride?: string },
): Promise<{ autoPick?: string; result: Awaited<ReturnType<typeof import('../../prototype/src/dispatch.js').dispatch>>; override: string }> {
  const pol = loadPolicy(repo);
  const stats = buildFleetStats(path.join(repo, '.orchestra', 'tasks'), pol.policy?.routing?.decay_days ?? 30);
  const auto = resolveWorker(o.role, { policy: pol.policy, stats, router: o.router });
  const { dispatch } = await import('../../prototype/src/dispatch.js');
  const result = await dispatch({
    repo, node: o.node, role: o.role, goal: o.goal, scope: o.scope,
    constraints: [], acceptance: o.acceptance, workerPin: o.pin, model: o.model,
    hooksEnabled: o.hooksEnabled, skills: o.skills, projectId: o.projectId, signal: o.signal, router: o.router, promptOverride: o.promptOverride,
    onEvent: o.onEvent as ((e: { t: string; [k: string]: unknown }) => void) | undefined,
  });
  const tr = trackOverride(repo, { autoPick: auto.pick, pin: o.pin, taskId: result.taskId, ok: result.ok });
  return { autoPick: auto.pick, result, override: tr.detail };
}

// ---------- Conformance badge cho Fleet panel (P6: + stale khi CLI update) ----------
export function conformanceBadge(repo: string, id: string, version?: string): string | null {
  const dir = path.join(repo, '.orchestra', 'conformance');
  if (!version || !existsSync(dir)) return null;
  const exact = path.join(dir, `${id}-${version}.json`);
  if (existsSync(exact)) {
    try {
      return JSON.parse(readFileSync(exact, 'utf8')).badge ?? null;
    } catch {
      return null;
    }
  }
  // CLI updated but conformance not re-run → yellow 'stale' badge
  const anyForId = readdirSync(dir).some((f) => f.startsWith(`${id}-`) && f.endsWith('.json'));
  return anyForId ? 'stale' : null;
}

// ---------- Chat with Orchestrator (P5.6) ----------
// Brain = 1 CLI in the fleet (default claude) running read-only + session resume to remember the conversation.
// Orchestrator does NOT do the work itself — it emits ```orchestra {json}``` actions and the extension executes them
// via the fully guarded dispatch/pipeline path. Results are fed back into the session.

export const ORCHESTRATOR_SYSTEM_PROMPT = `You are Orchestra Orchestrator — an IDE agent that coordinates agent CLIs (claude, codex, ...) as workers in a gated pipeline.
You are chatting with the user in VS Code. Mandatory rules:
1. Reply BRIEFLY, in the language the user writes in.
2. You are in read-only (plan) mode — do NOT edit files, do NOT write code yourself. You MAY use Glob/Grep/Read to survey the repo before answering.
3. When the user asks for work in the repo (add a feature, fix a bug, run a pipeline, check status...), issue an action in a fenced block with exactly this syntax:
\`\`\`orchestra
{"action":"dispatch","goal":"<goal>","scope":["src/**"],"worker":"codex|claude|auto","model":"optional"}
\`\`\`
or:
- {"action":"pipeline","template":"feature-dev|hotfix","goal":"...","scope":["..."]}
- {"action":"status"}  — show fleet + recent tasks
4. EVERY dispatch/pipeline action MUST have a scope (list of globs). Determine scope in this order:
   a. the PROJECT KNOWLEDGE provided below (project memory) — if a module matches, use its scope;
   b. none → survey the repo with Glob/Grep/Read to find the relevant module (e.g. grep the feature name);
   c. still unsure → ASK the user for the scope, do not guess. A dispatch without scope is rejected by the system (mandatory guardrail).
5. A message should contain at most 1-2 actions. Wait for the [orchestra-runner] result before the next action.
6. For advisory/conceptual questions answer directly, no action needed.`;

export interface OrchestraAction {
  action: 'dispatch' | 'pipeline' | 'status';
  goal?: string;
  scope?: string[];
  worker?: string;
  model?: string;
  template?: string;
}

export function parseOrchestraActions(text: string): OrchestraAction[] {
  const out: OrchestraAction[] = [];
  const re = /```orchestra\s*\r?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[1]!.trim()) as OrchestraAction;
      if (obj && typeof obj.action === 'string') out.push(obj);
    } catch {
      /* invalid JSON block — skip, don't crash chat */
    }
  }
  return out;
}

export async function orchestratorTurn(
  repo: string,
  message: string,
  sessionId?: string,
  workerId = 'claude',
  model?: string,
): Promise<{ text: string; session?: string; rawLines: number }> {
  const m = MANIFESTS.find((x) => x.id === workerId) ?? MANIFESTS[0]!;
  // P5.7: inject project memory into chat brain — worker-agnostic (codex brain doesn't read CLAUDE.md)
  const kb = recallKB(repo, ['**'], 1500);
  const kbBlock = kb.injected ? `\n\nPROJECT KNOWLEDGE (project memory — use it to determine scope):\n${kb.injected}` : '';
  const { runHeadless } = await import('../../prototype/src/runner.js');
  const r = await runHeadless(m, message, {
    cwd: repo,
    rawDir: path.join(repo, '.orchestra', 'raw'),
    silenceMs: 90_000,
    wallMs: 240_000,
    netOff: true,
    headless: { sandbox: 'read-only', resume: sessionId, systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT + kbBlock, model },
  });
  const texts = r.events
    .filter((e) => e.t === 'message' && typeof e['text'] === 'string')
    .map((e) => String(e['text']));
  return { text: texts.join('\n\n') || r.stderrTail || t('ext.chat.noReply'), session: r.session, rawLines: r.rawLines };
}

export async function executeAction(repo: string, a: OrchestraAction, opts: { hooksEnabled?: boolean } = {}): Promise<string> {
  switch (a.action) {
    case 'status': {
      const fleet = fleetSnapshot().map((f) => `${f.id}@${f.version ?? '?'}${f.installed ? '' : ' (not installed)'}`).join(', ');
      const tasks = tasksSnapshot(repo).slice(0, 5).map((t) => `${t.id} ${t.node}/${t.worker} exit=${t.exit}`);
      return `Fleet: ${fleet}\nRecent tasks:\n${tasks.map((t) => `- ${t}`).join('\n') || '(none)'}`;
    }
    case 'dispatch': {
      if (!a.goal) return 'dispatch is missing goal';
      const r = await dispatchTracked(repo, {
        node: 'implement',
        role: 'coder',
        goal: a.goal,
        scope: a.scope ?? [],
        acceptance: [],
        pin: a.worker && a.worker !== 'auto' ? a.worker : undefined,
        model: a.model,
        hooksEnabled: opts.hooksEnabled ?? true,
      });
      const files = r.result.record ? (r.result.record as Record<string, any>).artifacts?.files_changed ?? [] : [];
      return `dispatch ${r.result.ok ? 'OK' : 'FAILED'} ${r.result.taskId} worker=${r.result.record ? pickOf(r.result.record) : '?'} files=[${files.join(', ')}] record=${r.result.recordPath ?? ''}`;
    }
    case 'pipeline': {
      if (!a.goal) return 'pipeline is missing goal';
      const templates = protoAsset('templates');
      if (!templates) return 'pipeline: prototype/templates directory not found';
      const { runPipeline } = await import('../../prototype/src/orchestrator.js');
      const r = await runPipeline({
        repo,
        templatePath: path.join(templates, `${a.template ?? 'feature-dev'}.yml`),
        goal: a.goal,
        scope: a.scope ?? [],
        acceptance: [],
        autoYes: true, // chat is an async context — no stdin to prompt
        onLog: () => {},
      });
      return `pipeline ${r.runId}: ${r.ok ? 'OK' : 'FAILED'} merged=${r.merged}`;
    }
    default:
      return `unsupported action: ${JSON.stringify(a)}`;
  }
}

function pickOf(rec: Record<string, unknown>): string {
  const r = rec['routing'] as { pick?: string } | undefined;
  return r?.pick ?? '?';
}

/**
 * D1 — chatExchange: full chat loop (turn → parse action → execute → feedback).
 * Shared by extension ChatView + Desktop chat page — no more 2 copies.
 */
export interface ChatMessage {
  kind: 'orch' | 'result';
  text: string;
}

export async function chatExchange(
  repo: string,
  userText: string,
  sessionId: string | undefined,
  opts: { workerId?: string; model?: string; notify?: (m: ChatMessage) => void; hooksEnabled?: boolean },
): Promise<{ session?: string }> {
  const emit = (m: ChatMessage) => opts.notify?.(m);
  const turn = await orchestratorTurn(repo, userText, sessionId, opts.workerId ?? 'claude', opts.model);
  emit({ kind: 'orch', text: turn.text });

  const actions = parseOrchestraActions(turn.text);
  if (!actions.length) return { session: turn.session };

  const results: string[] = [];
  for (const a of actions) {
    try {
      results.push(await executeAction(repo, a, opts));
    } catch (err) {
      results.push(`${a.action} error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const summary = `[orchestra-runner] Action results:\n${results.map((r, i) => `${i + 1}. ${r}`).join('\n')}`;
  emit({ kind: 'result', text: summary });
  const follow = await orchestratorTurn(repo, summary, turn.session, opts.workerId ?? 'claude', opts.model);
  if (follow.text.trim()) emit({ kind: 'orch', text: follow.text });
  return { session: follow.session };
}

// ---------- M1: tools for Orchestra brain (brain.ts) — workers reached only via fleet_dispatch/fleet_pipeline ----------
// Tier: T0 survey (auto) · T1 existing guarded path (auto) · T2 needs user approval (approve)

export const BRAIN_SYSTEM_PROMPT = `You are Orchestra — the coordinating agent. You talk to the user directly; the agent CLIs (claude, codex, ...) are only workers you drive via tools.
Rules:
1. Reply BRIEFLY.
2. You do NOT edit code yourself. For repo work: survey first (repo_glob/repo_grep/repo_read/git_diff), then fleet_dispatch or fleet_pipeline with an explicit glob scope.
3. Scope unclear → ASK the user, do not guess.
4. Approvals follow PERMISSION MODE below — the system asks the user (or refuses) automatically when you call the tool.
5. Before fleet_merge you must call task_diff and read the diff; state what you checked.
6. Report results briefly: worker, task id, files changed, ok/fail. Never tell the user to talk to a worker themselves.
7. fleet_dispatch with readonly:true for tasks that only read/survey/list/explain/review; NEVER readonly for code changes.`;

// language is decided by the user (from their messages), NOT by UI locale/i18n
const BRAIN_LANGUAGE = `\nLANGUAGE: always reply in the same language as the user's latest message. When you dispatch work, write goal/acceptance in the user's own words and language — do not translate them.`;
const MEMORY_RULE = `\nMEMORY: save durable facts proactively and silently with memory_update — no permission needed. User preferences/style → scope "global"; project facts (decisions, conventions, architecture, repo roles, recurring pitfalls) → scope "project". One short line per fact; replace outdated entries instead of adding duplicates. Never store secrets or transient task progress.`;
const PROJECT_RULES = `\n8. This project may span several repos (microservices). Repo tools take \`repo\` = a name from REPOS (required when there is more than one). Work that touches several services = one fleet_dispatch per repo, each with its own scope.`;
const WORKSPACE_RULES = `\n8. This chat is NOT inside a project — that is fine, never ask the user to create one. When the user mentions a local folder or repo path, call repo_attach with that absolute path (the user approves once), then work on it directly with the repo/worker tools (\`repo\` = a name returned by repo_attach). Without an attached repo, tools run in the scratch WORKSPACE below (Orchestra's private git repo, for experiments/throwaway scripts/fleet tests).\nOnly scope "global" exists for memory_update in this chat.`;
const GLOBAL_PROMPT = `You are Orchestra — the coordinating agent of an AI coding fleet. You talk to the user directly.
This chat is NOT inside a project: you have no repo or worker tools here. Reply BRIEFLY. For code work, ask the user to open a chat inside a project (sidebar → Projects) so you can see its repos.
Only scope "global" exists for memory_update in this chat.`;

export interface RepoRef {
  name: string;
  path: string;
}
/** repo name = basename; duplicates → append -2, -3… (stable by repo order in the project) */
export function repoRefs(paths: string[]): RepoRef[] {
  const seen = new Set<string>();
  return paths.map((p) => {
    const base = path.basename(path.resolve(p)) || 'repo';
    let name = base;
    for (let n = 2; seen.has(name); n++) name = `${base}-${n}`;
    seen.add(name);
    return { name, path: path.resolve(p) };
  });
}

/** skill list for brain (max 40) — chat outside a project can only view, not dispatch */
function skillsBlock(skills: { name: string; description: string }[] | undefined, canDispatch: boolean): string {
  if (!skills?.length) return '';
  const list = skills.slice(0, 40).map((s) => `- ${s.name} — ${s.description}`).join('\n');
  const more = skills.length > 40 ? `\n…(+${skills.length - 40} more)` : '';
  return canDispatch
    ? `\n\nSKILLS (attach with fleet_dispatch/fleet_pipeline \`skills\` — ONLY the ones clearly relevant to that task, usually 0-2):\n${list}${more}`
    : `\n\nSKILLS installed (informational — skills can only be attached to work inside a project):\n${list}${more}`;
}

/** project = undefined → chat outside a project: global memory only, no repo/KB/project memory */
export function brainSystemPrompt(o: { project?: { name: string; repos: RepoRef[] }; workspace?: RepoRef; attached?: RepoRef[]; globalMemory: string; projectMemory?: string; skills?: { name: string; description: string }[]; mode?: PermissionMode }): string {
  const p = o.project;
  const m = isPermissionMode(o.mode) ? o.mode : 'ask';
  const mode = `\nPERMISSION MODE: ${m} — ${MODE_PROMPT[m]}`;
  // chat outside a project: can still call workers — repo the user mentioned (repo_attach) or scratch repo ~/.orchestra/workspace
  const att = o.attached?.length ? `\nATTACHED REPOS:\n${o.attached.map((r) => `- ${r.name}: ${r.path}`).join('\n')}` : '';
  if (!p && o.workspace) return BRAIN_SYSTEM_PROMPT + WORKSPACE_RULES + mode + MEMORY_RULE + BRAIN_LANGUAGE + `\nWORKSPACE: ${o.workspace.path}` + att + skillsBlock(o.skills, true) + `\n\n${renderMemoryBlock(o.globalMemory)}`;
  if (!p) return GLOBAL_PROMPT + MEMORY_RULE + BRAIN_LANGUAGE + skillsBlock(o.skills, false) + `\n\n${renderMemoryBlock(o.globalMemory)}`;
  const budget = Math.floor(1500 / Math.max(p.repos.length, 1));
  const kb = p.repos.flatMap((r) => {
    const k = recallKB(r.path, ['**'], budget);
    return k.injected ? [`[${r.name}]\n${k.injected}`] : [];
  });
  return BRAIN_SYSTEM_PROMPT + PROJECT_RULES + mode + MEMORY_RULE + BRAIN_LANGUAGE
    + `\nPROJECT: ${p.name}\nREPOS:\n${p.repos.map((r) => `- ${r.name}: ${r.path}`).join('\n') || '(none yet — ask the user to add repos on the Project page)'}`
    + (kb.length ? `\n\nPROJECT KNOWLEDGE (repo KB — use it to determine scope):\n${kb.join('\n\n')}` : '')
    + skillsBlock(o.skills, true)
    + `\n\n${renderMemoryBlock(o.globalMemory, { name: p.name, text: o.projectMemory ?? '' })}`;
}

const strArr = { type: 'array', items: { type: 'string' } };
const skillsArr = { ...strArr, description: 'skill names from SKILLS — only those relevant to this task' };
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
export const BRAIN_TOOLS: { name: string; description: string; input_schema: Record<string, unknown> }[] = [
  { name: 'repo_glob', description: 'List repo files matching a glob (e.g. src/**/*.ts). Max 200.', input_schema: obj({ pattern: { type: 'string' } }, ['pattern']) },
  { name: 'repo_grep', description: 'Search a (JS) regex in repo text files, optionally filtered by glob. Returns path:line. Max 100.', input_schema: obj({ pattern: { type: 'string' }, glob: { type: 'string' } }, ['pattern']) },
  { name: 'repo_read', description: 'Read a repo file (relative path). offset = start line (1-based), limit = number of lines (≤2000).', input_schema: obj({ path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, ['path']) },
  { name: 'git_diff', description: 'git diff (stat + content, truncated) against an optional ref (default: working tree vs HEAD). ref = task id (t-…) → same as task_diff.', input_schema: obj({ ref: { type: 'string' } }) },
  { name: 'task_diff', description: 'Show a task result: worker, changed files, scope check, outcome + patch. Call before fleet_merge.', input_schema: obj({ taskId: { type: 'string' } }, ['taskId']) },
  { name: 'fleet_status', description: 'Fleet worker status + 5 most recent tasks.', input_schema: obj({}) },
  { name: 'fleet_dispatch', description: 'Assign one task to a worker (own worktree, guarded + scope check). scope is REQUIRED. Coding by default; readonly:true runs it read-only and returns the worker answer.', input_schema: obj({ goal: { type: 'string' }, scope: strArr, worker: { type: 'string', description: 'worker id, or empty = auto by policy' }, model: { type: 'string' }, acceptance: strArr, readonly: { type: 'boolean', description: 'true for survey/list/explain/review tasks that must not modify files' }, skills: skillsArr }, ['goal', 'scope']) },
  { name: 'fleet_pipeline', description: 'Run a pipeline template (feature-dev | hotfix): plan → implement → verify → review → merge.', input_schema: obj({ template: { type: 'string' }, goal: { type: 'string' }, scope: strArr, model: { type: 'string' }, skills: skillsArr }, ['template', 'goal', 'scope']) },
  { name: 'fleet_merge', description: "Merge a task's branch into main (REQUIRES user approval). The system checks the task + runs tests before asking.", input_schema: obj({ taskId: { type: 'string' } }, ['taskId']) },
  { name: 'policy_promote', description: 'Move a worker to #1 for a role in the policy (REQUIRES user approval).', input_schema: obj({ role: { type: 'string' }, cli: { type: 'string' } }, ['role', 'cli']) },
];
export const MEMORY_TOOL = {
  name: 'memory_update',
  description: 'Update long-term memory (no approval needed). scope global = user preferences/general facts; project = facts about this project. add needs text; replace needs old_text (unique substring of one entry) + text; remove needs old_text.',
  input_schema: obj({ scope: { type: 'string', enum: ['global', 'project'] }, action: { type: 'string', enum: ['add', 'replace', 'remove'] }, text: { type: 'string' }, old_text: { type: 'string' } }, ['scope', 'action']),
};
/** repos = null → memory_update only; attach = chat outside a project → add repo_attach, `repo` not an enum (list changes mid-turn) */
export function brainTools(repos: RepoRef[] | null, opts: { attach?: boolean } = {}): typeof BRAIN_TOOLS {
  if (!repos) return [MEMORY_TOOL];
  const repo = { type: 'string', description: 'repo name from REPOS (required when the project has more than one repo)', ...(repos.length && !opts.attach ? { enum: repos.map((r) => r.name) } : {}) };
  return [...BRAIN_TOOLS.map((d) => ({ ...d, input_schema: { ...d.input_schema, properties: { ...(d.input_schema.properties as object), repo } } })), MEMORY_TOOL, ...(opts.attach ? [ATTACH_TOOL] : [])];
}
export const ATTACH_TOOL = {
  name: 'repo_attach',
  description: 'Attach a local folder the user mentioned so the repo/worker tools can work on it (the user approves once). path = absolute path. A git repo attaches as one repo; a folder containing several git repos (microservices) attaches each of them. Returns the repo names to pass as `repo`.',
  input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
};

const FIND_SKIP = new Set(['node_modules', '.git', '.orchestra', 'bin', 'obj', 'dist', 'out', 'build', '.vs', '.idea']);
/** child git repos in dir (dir is a repo → [dir]); .git is a directory or file (worktree). Stops at the first repo on each branch. */
export function findRepos(dir: string, maxDepth = 3, max = 40): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (out.length >= max) return;
    if (existsSync(path.join(d, '.git'))) { out.push(d); return; }
    if (depth >= maxDepth) return;
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) if (e.isDirectory() && !FIND_SKIP.has(e.name) && !e.name.startsWith('.')) walk(path.join(d, e.name), depth + 1);
  };
  walk(path.resolve(dir), 0);
  return out.sort();
}

export interface BrainToolDeps {
  /** T2: ask the user — false = rejected; kind = approval card badge */
  approve: (question: string, kind?: ApprovalKind) => Promise<boolean>;
  /** chat permission mode — missing = 'ask' */
  mode?: PermissionMode;
  /** pipeline plan approval */
  askUser?: (q: string) => Promise<string>;
  hooksEnabled?: boolean;
  /** skills = global + this project (project overrides global) */
  projectId?: string | null;
  templatesDir?: string;
  autoApprovePlan?: boolean;
  onLog?: (line: string) => void;
  /** user clicked Stop → kill the running worker */
  signal?: AbortSignal;
  /** R2a: worker runs through Orchestra router */
  router?: RouterInfo;
  /** test seam — defaults to dispatchTracked */
  dispatch?: typeof dispatchTracked;
}
type ToolOut = { ok: boolean; content: string };

/** permission mode gate: null = allowed; ToolOut = blocked (plan mode) or user rejected */
async function gate(deps: BrainToolDeps, action: ApprovalAction, kind: ApprovalKind, question: () => string): Promise<ToolOut | null> {
  const need = needsApproval(deps.mode, action);
  if (need === 'block') return bad(PLAN_BLOCKED);
  if (need === 'ask' && !(await deps.approve(question(), kind))) return bad('user declined');
  return null;
}

const TASK_ID = /^t-[a-z0-9-]+$/;
const cap = (s: string, n = 15_000) => (s.length > n ? `${s.slice(0, n)}\n…(truncated)` : s);

function loadTask(repo: string, taskId: string): Record<string, any> | string {
  if (!TASK_ID.test(taskId)) return `invalid taskId: ${taskId}`;
  try {
    return JSON.parse(readFileSync(path.join(repo, '.orchestra', 'tasks', `${taskId}.json`), 'utf8'));
  } catch {
    return `no task record ${taskId}`;
  }
}

/** task patch (patch_ref) or diff <current branch>...<task branch>; stat = diffstat */
function taskPatch(repo: string, rec: Record<string, any>): { patch: string; stat: string } {
  const ref = rec.artifacts?.patch_ref;
  if (typeof ref === 'string' && existsSync(ref)) {
    const st = git(repo, ['apply', '--stat', ref]);
    // old patches (before the diffPatch trim fix) may be corrupt → fall back to branch diff
    if (st.ok) return { patch: readFileSync(ref, 'utf8'), stat: st.out };
  }
  const base = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const range = `${base.ok ? base.out : 'main'}...${rec.worktree?.branch ?? `orchestra/task-${rec.id}`}`;
  return { patch: git(repo, ['diff', range]).out, stat: git(repo, ['diff', '--stat', range]).out };
}

function taskDiff(repo: string, taskId: string): ToolOut {
  const rec = loadTask(repo, taskId);
  if (typeof rec === 'string') return bad(rec);
  const { patch, stat } = taskPatch(repo, rec);
  return {
    ok: true,
    content: [
      `task ${taskId} worker=${pickOf(rec)} outcome=${rec.outcome ?? 'ok'}`,
      `files_changed: ${(rec.artifacts?.files_changed ?? []).join(', ') || '(none)'}`,
      `scope_check: ${JSON.stringify(rec.scope_check ?? null)}`,
      stat,
      '',
      cap(patch) || '(no patch)',
    ].join('\n'),
  };
}

const NPM_DEFAULT_TEST = /no test specified/;
/** run `npm test` in the worktree if scripts.test exists; null = no test command */
// async — doesn't block Electron main; signal (Stop) kills the test
async function runTaskTests(dir: string | undefined, signal?: AbortSignal): Promise<{ ok: boolean; line: string } | null> {
  if (!dir) return null;
  let script: unknown;
  try {
    script = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts?.test;
  } catch {
    return null;
  }
  if (typeof script !== 'string' || NPM_DEFAULT_TEST.test(script)) return null;
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn('npm test', { cwd: dir, shell: true, windowsHide: true, timeout: 180_000, signal });
    let out = '';
    child.stdout?.on('data', (d) => (out = (out + d).slice(-4000)));
    child.stderr?.on('data', (d) => (out = (out + d).slice(-4000)));
    child.on('error', (err) => resolve({ ok: false, line: `test error: ${err.message}` }));
    child.on('close', (code) => resolve(code === 0 ? { ok: true, line: 'test pass (npm test)' } : { ok: false, line: `test fail (exit ${code}): ${out.slice(-500)}` }));
  });
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.orchestra']);
// ponytail: synchronous walk, capped at 20k files — huge repos need an index/ripgrep
function walkRepo(root: string, max = 20_000): string[] {
  const out: string[] = [];
  const stack = [''];
  while (stack.length && out.length < max) {
    const rel = stack.pop()!;
    let ents;
    try {
      ents = readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(r);
      } else if (e.isFile()) out.push(r);
    }
  }
  return out.sort();
}

// globToRegex: '**/' needs ≥1 directory; for surveying let '**/' also match 0 directories (src/**/*.ts ⊇ src/a.ts)
function globMatcher(p: string): (f: string) => boolean {
  const a = globToRegex(p);
  const b = globToRegex(p.replace(/\*\*\//g, ''));
  return (f) => a.test(f) || b.test(f);
}

/** relative path inside the repo → absolute; escapes the repo → null */
export function resolveInRepo(root: string, p: string): string | null {
  if (path.isAbsolute(p) || /^[a-zA-Z]:/.test(p)) return null;
  const abs = path.resolve(root, p);
  const rel = path.relative(path.resolve(root), abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? abs : null;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const optStr = (v: unknown) => v === undefined || v === null || typeof v === 'string';
const bad = (content: string): ToolOut => ({ ok: false, content });

/** skills from brain: undefined → []; unknown name → error string with the valid list */
function checkSkills(v: unknown, projectId?: string | null): string[] | string {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return 'skills must be an array of skill names';
  const valid = availableSkills(projectId).map((s) => s.name);
  const unknown = v.filter((x) => !valid.includes(x));
  return unknown.length ? `unknown skill(s): ${unknown.join(', ')} — available: ${valid.join(', ') || '(none installed)'}` : [...new Set(v as string[])];
}

export function brainToolExecutor(repo: string, deps: BrainToolDeps): (name: string, input: unknown) => Promise<ToolOut> {
  return async (name, raw) => {
    const i = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    switch (name) {
      case 'repo_glob': {
        if (!isStr(i.pattern)) return bad('pattern must be a non-empty string');
        const hits = walkRepo(repo).filter(globMatcher(i.pattern));
        return { ok: true, content: hits.slice(0, 200).join('\n') + (hits.length > 200 ? `\n…(+${hits.length - 200})` : '') || '(no matching files)' };
      }
      case 'repo_grep': {
        if (!isStr(i.pattern) || !optStr(i.glob)) return bad('pattern must be a string; glob (optional) must be a string');
        let re: RegExp;
        try {
          re = new RegExp(i.pattern);
        } catch (err) {
          return bad(`invalid regex: ${(err as Error).message}`);
        }
        const g = isStr(i.glob) ? globMatcher(i.glob) : null;
        const hits: string[] = [];
        for (const f of walkRepo(repo)) {
          if (hits.length >= 100) break;
          if (g && !g(f)) continue;
          const abs = path.join(repo, f);
          if (statSync(abs).size > 1_000_000) continue;
          const txt = readFileSync(abs, 'utf8');
          if (txt.includes('\0')) continue; // binary
          txt.split(/\r?\n/).forEach((l, n) => {
            if (hits.length < 100 && re.test(l)) hits.push(`${f}:${n + 1}: ${l.trim().slice(0, 200)}`);
          });
        }
        return { ok: true, content: hits.join('\n') || '(no matches)' };
      }
      case 'repo_read': {
        if (!isStr(i.path)) return bad('path must be a string');
        const abs = resolveInRepo(repo, i.path);
        if (!abs) return bad(`path outside repo: ${i.path}`);
        if (!existsSync(abs) || !statSync(abs).isFile()) return bad(`no such file: ${i.path}`);
        const offset = Number.isInteger(i.offset) && (i.offset as number) > 0 ? (i.offset as number) : 1;
        const limit = Math.min(Number.isInteger(i.limit) && (i.limit as number) > 0 ? (i.limit as number) : 2000, 2000);
        const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
        const body = lines.slice(offset - 1, offset - 1 + limit).map((l, n) => `${offset + n}\t${l}`).join('\n');
        const capped = body.length > 100_000 ? `${body.slice(0, 100_000)}\n…(truncated at 100KB)` : body;
        return { ok: true, content: `${capped}\n(${lines.length} lines total)` };
      }
      case 'git_diff': {
        if (!optStr(i.ref) || (isStr(i.ref) && i.ref.startsWith('-'))) return bad('invalid ref');
        if (isStr(i.ref) && TASK_ID.test(i.ref)) return taskDiff(repo, i.ref);
        const ref = isStr(i.ref) ? [i.ref] : [];
        const stat = git(repo, ['diff', '--stat', ...ref]);
        if (!stat.ok) return bad(stat.out.slice(0, 500));
        const d = git(repo, ['diff', ...ref]).out;
        return { ok: true, content: `${stat.out || '(no changes)'}\n\n${cap(d)}` };
      }
      case 'task_diff':
        return isStr(i.taskId) ? taskDiff(repo, i.taskId) : bad('taskId must be a string');
      case 'fleet_status':
        return { ok: true, content: await executeAction(repo, { action: 'status' }) };
      case 'fleet_dispatch': {
        if (!isStr(i.goal)) return bad('goal must be a non-empty string');
        if (!isStrArr(i.scope) || !i.scope.length) return bad('scope is required: non-empty array of globs');
        if (!optStr(i.worker) || !optStr(i.model)) return bad('worker/model must be strings');
        if (i.acceptance !== undefined && !isStrArr(i.acceptance)) return bad('acceptance must be an array of strings');
        if (i.readonly !== undefined && typeof i.readonly !== 'boolean') return bad('readonly must be a boolean');
        const skills = checkSkills(i.skills, deps.projectId);
        if (typeof skills === 'string') return bad(skills);
        const ro = i.readonly === true;
        const acceptance = (i.acceptance as string[] | undefined) ?? [];
        const scope = i.scope;
        const g = ro ? null : await gate(deps, 'dispatch_write', 'risk', () => t('ext.dispatch.ask', { goal: i.goal as string, scope: scope.join(', '), worker: isStr(i.worker) ? i.worker : 'auto' }));
        if (g) return g;
        // read-only: plan node (read-only sandbox, no no_change, not counted in coder EMA) — prompt answers directly, no plan required
        const r = await (deps.dispatch ?? dispatchTracked)(repo, {
          node: ro ? 'plan' : 'implement', role: ro ? 'planner' : 'coder', goal: i.goal, scope: i.scope, acceptance,
          promptOverride: ro
            ? ['You are in READ-ONLY mode — do not create or edit any file.', '', `TASK: ${i.goal}`, '', 'FOCUS (globs):', ...i.scope.map((p) => `- ${p}`),
              ...(acceptance.length ? ['', 'ACCEPTANCE:', ...acceptance.map((c) => `- ${c}`)] : []), '', 'Answer the task directly and concisely.'].join('\n')
            : undefined,
          pin: isStr(i.worker) && i.worker !== 'auto' ? i.worker : undefined,
          model: isStr(i.model) ? i.model : undefined,
          hooksEnabled: deps.hooksEnabled ?? true, skills, projectId: deps.projectId, signal: deps.signal, router: deps.router,
          onEvent: deps.onLog
            ? (e) => deps.onLog!(e.t === 'tool_use' ? `[tool_use] ${e.tool} ${e.target}` : e.t === 'message' ? `[message] ${e.text}` : `[${e.t}] ${JSON.stringify(e).slice(0, 160)}`)
            : undefined,
        });
        const rec = r.result.record as Record<string, any> | undefined;
        return {
          ok: r.result.ok,
          content: `dispatch ${r.result.ok ? 'OK' : 'FAILED'} task=${r.result.taskId} stage=${r.result.stage}${r.result.reason ? ` reason=${r.result.reason}` : ''} worker=${rec ? pickOf(rec) : '?'} files=[${(rec?.artifacts?.files_changed ?? []).join(', ')}] scope_ok=${rec?.scope_check?.ok !== false}`
            + (ro && typeof rec?.last_message === 'string' ? `\n\nworker answer:\n${cap(rec.last_message, 8000)}` : ''),
        };
      }
      case 'fleet_pipeline': {
        if (!isStr(i.template) || !/^[\w-]+$/.test(i.template)) return bad('template must be a name (e.g. feature-dev, hotfix)');
        if (!isStr(i.goal)) return bad('goal must be a non-empty string');
        if (!isStrArr(i.scope) || !i.scope.length) return bad('scope is required: non-empty array of globs');
        if (!optStr(i.model)) return bad('model must be a string');
        const skills = checkSkills(i.skills, deps.projectId);
        if (typeof skills === 'string') return bad(skills);
        const dir = deps.templatesDir || protoAsset('templates');
        const tpl = dir && path.join(dir, `${i.template}.yml`);
        if (!tpl || !existsSync(tpl)) return bad(`no template ${i.template}`);
        const scope = i.scope;
        const g = await gate(deps, 'pipeline', 'risk', () => t('ext.pipeline.ask', { template: i.template as string, goal: i.goal as string, scope: scope.join(', ') }));
        if (g) return g;
        const { runPipeline } = await import('../../prototype/src/orchestrator.js');
        const r = await runPipeline({
          repo, templatePath: tpl, goal: i.goal, scope: i.scope, acceptance: [],
          model: isStr(i.model) ? i.model : undefined, signal: deps.signal, router: deps.router, skills, projectId: deps.projectId,
          autoYes: (deps.autoApprovePlan ?? false) || needsApproval(deps.mode, 'plan_approval') === 'allow', askUser: deps.askUser, onLog: deps.onLog ?? (() => {}),
        });
        const nodes = Object.entries(r.nodes).map(([k, n]) => `${k}:${n.status}${n.worker ? `/${n.worker}` : ''}`).join(' ');
        return { ok: r.ok, content: `pipeline ${r.runId} ${r.ok ? 'OK' : 'FAILED'} merged=${r.merged}${r.mergeConflict ? ' (conflict)' : ''} ${nodes}` };
      }
      case 'fleet_merge': {
        if (!isStr(i.taskId)) return bad('taskId must be a string');
        if (needsApproval(deps.mode, 'merge') === 'block') return bad(PLAN_BLOCKED); // before running tests
        // gate in code — brain can't merge empty / out-of-scope / test-failing tasks
        const rec = loadTask(repo, i.taskId);
        if (typeof rec === 'string') return bad(rec);
        const files: string[] = rec.artifacts?.files_changed ?? [];
        if (rec.outcome === 'no_change') return bad('not merging: task outcome no_change');
        if (!files.length) return bad('not merging: task changed no files');
        if (rec.scope_check?.ok === false) return bad(`not merging: scope check failed ${JSON.stringify(rec.scope_check.violations ?? [])}`);
        const tests = await runTaskTests(rec.worktree?.path, deps.signal);
        if (tests && !tests.ok) return bad(tests.line);
        const q = [
          t('ext.merge.ask', { id: i.taskId, worker: pickOf(rec) }),
          `File: ${files.join(', ')}`,
          taskPatch(repo, rec).stat,
          tests?.line ?? t('ext.merge.noTest'),
          t('ext.merge.confirm'),
        ].join('\n');
        const g = await gate(deps, 'merge', 'merge', () => q);
        if (g) return g;
        const r = reviewMerge(repo, i.taskId, 'merge');
        return { ok: r.ok, content: r.detail };
      }
      case 'policy_promote': {
        if (!isStr(i.role) || !isStr(i.cli)) return bad('role and cli must be strings');
        const role = i.role, cli = i.cli;
        const g = await gate(deps, 'policy', 'policy', () => t('ext.promote.ask', { cli, role }));
        if (g) return g;
        const r = promoteWorker(repo, i.role, i.cli);
        return { ok: r.ok, content: r.detail };
      }
      default:
        return bad(`unknown tool: ${name}`);
    }
  };
}

export interface SessionToolDeps extends BrainToolDeps {
  /** null = chat outside a project — memory_update only accepts global scope */
  projectId: string | null;
  /** consolidate memory when over budget; missing → keep the newest entries that fit the budget */
  callModel?: CallModel;
  /** chat outside a project: repo_attach — validate + ask user, return the attached repo (caller pushes into `repos`) */
  attach?: (path: string) => Promise<{ ok: boolean; content: string }>;
}
/** tool executor for 1 session: route repo tools to the repo named by `repo` + memory_update */
export function projectToolExecutor(repos: RepoRef[], deps: SessionToolDeps): (name: string, input: unknown) => Promise<ToolOut> {
  return async (name, raw) => {
    const { repo, ...i } = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (name === 'memory_update') {
      if (!['global', 'project'].includes(i.scope as string)) return bad('scope must be "global" or "project"');
      if (!optStr(i.text) || !optStr(i.old_text)) return bad('text/old_text must be strings');
      const r = await writeMemoryOps(deps.projectId, [i as unknown as ScopedOp], deps.callModel);
      return r.errors.length ? bad(r.errors.join('; ')) : { ok: true, content: r.applied.length ? 'memory updated' : 'no change (duplicate)' };
    }
    if (name === 'repo_attach') {
      if (!deps.attach) return bad('repo_attach is only available in chats outside a project');
      if (!isStr(i.path)) return bad('path must be a non-empty string');
      return deps.attach(i.path);
    }
    if (!BRAIN_TOOLS.some((d) => d.name === name)) return bad(`unknown tool: ${name}`);
    if (!repos.length) return bad(deps.projectId ? 'this project has no repos yet — ask the user to add one on the Project page' : 'no repo in this chat — ask the user to open a chat inside a project');
    const names = repos.map((r) => r.name).join(', ');
    const target = repo === undefined || repo === null || repo === '' ? (repos.length === 1 ? repos[0] : undefined) : repos.find((r) => r.name === repo);
    if (!target) return bad(repo === undefined || repo === null || repo === '' ? `repo is required — one of: ${names}` : `unknown repo "${String(repo)}" — one of: ${names}`);
    return brainToolExecutor(target.path, deps)(name, i);
  };
}

/** Role × Worker matrix data — Desktop renders it with the app's CSS, VS Code uses policyMatrixHtml */
export function policyMatrixData(repo = FALLBACK_REPO) {
  const lp = loadPolicy(repo);
  const stats = buildFleetStats(path.join(repo, '.orchestra', 'tasks'), lp.policy?.routing?.decay_days ?? 30);
  const minSample = lp.policy?.routing?.min_sample ?? 10;
  const roles = [...new Set([...Object.keys(lp.policy?.bindings ?? {}), 'coder', 'planner', 'verifier', 'reviewer'])];
  return {
    source: lp.source,
    errors: lp.errors,
    minSample,
    workers: MANIFESTS.map((m) => ({ id: m.id, display: m.display })),
    rows: roles.map((role) => {
      const binds = lp.policy?.bindings?.[role] ?? [];
      return {
        role,
        cells: MANIFESTS.map((m) => {
          const idx = binds.findIndex((b) => b.worker.cli === m.id);
          if (idx < 0) return null;
          const s = stats.get(`${m.id}|${role}`);
          return { cli: m.id, rank: idx + 1, model: binds[idx]?.worker?.model ?? null, n: s?.dispatched ?? 0, ema: s && s.dispatched >= minSample ? s.ema : null };
        }),
      };
    }),
    kb: loadKB(repo).map((e) => ({ id: e.id, title: e.title, scope: e.scope, source: e.source, pinned: !!e.pinned })),
  };
}

export function policyMatrixHtml(repo = FALLBACK_REPO, interactive = false): string {
  const d = policyMatrixData(repo);
  const lp = { source: d.source, errors: d.errors };
  const kb = d.kb;
  const rows = d.rows
    .map(({ role, cells }) => {
      const tds = cells.map((c) => {
        if (!c) return `<td style="color:#555">—</td>`;
        const stat = c.ema !== null ? `ema ${c.ema.toFixed(2)} (n=${c.n})` : c.n ? `n=${c.n} (&lt; ${d.minSample})` : t('ext.mx.noData');
        return `<td data-role="${role}" data-cli="${c.cli}" style="${interactive ? 'cursor:pointer' : ''}" title="${interactive ? t('ext.mx.cellTip') : ''}">${c.rank === 1 ? '●' : '○'} #${c.rank}<br><small>${c.model ?? ''}</small><br><small>${stat}</small></td>`;
      }).join('');
      return `<tr><th>${role}</th>${tds}</tr>`;
    })
    .join('');
  const kbRows = kb
    .map((e) => `<tr><td>${e.id}</td><td>${e.title}</td><td>${e.scope.join(', ')}</td><td>${e.source}</td><td>${e.pinned ? '📌' : ''}</td></tr>`)
    .join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:Segoe UI,sans-serif;background:#1e1e1e;color:#d4d4d4;padding:12px}
    table{border-collapse:collapse;margin:8px 0}th,td{border:1px solid #444;padding:6px 10px;text-align:left}
    h3{color:#4fc1ff}</style></head><body>
    <h3>Role × Worker matrix</h3>
    <p>policy source: <b>${lp.source}</b>${lp.errors.length ? ` — ⚠ ${lp.errors.join('; ')}` : ` ${t('ext.mx.valid')}`}</p>
    <table><tr><th>role</th>${MANIFESTS.map((m) => `<th>${m.id}</th>`).join('')}</tr>${rows}</table>
    <h3>Project KB (${kb.length})</h3>
    <table><tr><th>id</th><th>title</th><th>scope</th><th>source</th><th>pinned</th></tr>${kbRows}</table>
    ${interactive ? `<p><small>${t('ext.mx.footer')}</small></p>
    <script>
      // host-agnostic: VS Code webview uses acquireVsCodeApi; Desktop iframe uses parent.postMessage
      const vscode = window.acquireVsCodeApi ? window.acquireVsCodeApi() : { postMessage: (m) => window.parent.postMessage(m, '*') };
      document.querySelectorAll('td[data-role]').forEach((td) => {
        td.addEventListener('click', () => {
          vscode.postMessage({ kind: 'promote', role: td.dataset.role, cli: td.dataset.cli });
        });
      });
    </script>` : ''}
  </body></html>`;
}
