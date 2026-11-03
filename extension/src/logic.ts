// Logic thuần — KHÔNG import vscode (test được bằng node thường, P5 gate)
import { MANIFESTS } from '../../prototype/src/manifests.js';
import { checkStatus } from '../../prototype/src/registry.js';
import { loadPolicy, resolveWorker, DEFAULT_BINDINGS, type PolicyFile } from '../../prototype/src/policy.js';
import { buildFleetStats, loadKB, addFeedback, recallKB } from '../../prototype/src/memory.js';
import { routerModelOk, type ProviderConfig } from '../../prototype/src/router/providers.js';
import type { RouterInfo } from '../../prototype/src/types.js';
import { protoAsset } from '../../prototype/src/paths.js';
import { mergeBranch } from '../../prototype/src/worktree.js';
import { globToRegex } from '../../prototype/src/dispatch.js';
import { t } from '../../prototype/src/i18n/index.js';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as yaml from 'js-yaml';
import path from 'node:path';

export const FALLBACK_REPO = 'C:/Users/Nitro V 15/Desktop/Source/Orchestra/prototype/demo-repo';

/** router = CLI có routerArgs (auth đi qua Orchestra router) */
export function fleetSnapshot(): { id: string; display: string; installed: boolean; version?: string; auth: string; router: boolean }[] {
  return MANIFESTS.map((m) => {
    const s = checkStatus(m);
    return { id: m.id, display: m.display, installed: s.installed, version: s.version, auth: s.auth, router: !!m.routerArgs };
  });
}

/** R2a: model của router (/v1/models) + worker nào chạy được model nào (routerModelOk) */
export function modelsList(ids: string[], providers: ProviderConfig[]): {
  models: string[];
  byWorker: Record<string, { id: string; ok: boolean; reason: string }[]>;
} {
  return {
    models: ids,
    byWorker: Object.fromEntries(MANIFESTS.map((m) => [m.id, ids.map((id) => ({ id, ...routerModelOk(m.id, id, providers) }))])),
  };
}

/** limit: chỉ đọc N file mới nhất (tên file sort được theo thời gian) — không parse hết rồi bỏ */
export function tasksSnapshot(repo = FALLBACK_REPO, limit = 20): { id: string; node: string; worker: string; exit: number | null; scopeOk: boolean; files: number }[] {
  const dir = path.join(repo, '.orchestra', 'tasks');
  if (!existsSync(dir)) return [];
  const n = Math.min(Math.max(Math.trunc(Number(limit)) || 20, 1), 200); // limit đến từ IPC → clamp
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

/** Task có worktree-branch chưa merge vào main — ứng viên cho Review & Merge */
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
      if (ancestor.ok) continue; // đã merge rồi
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
      /* bỏ qua */
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

// ---------- Policy editable (P5.3): click cell = promote worker lên #1 ----------
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

// ---------- Override tracking (P5.3): user chọn worker khác auto-pick ----------
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
  o: { node: 'implement'; role: string; goal: string; scope: string[]; acceptance: string[]; pin?: string; model?: string; onEvent?: (e: { t: string; [k: string]: unknown }) => void; hooksEnabled?: boolean; skillSync?: boolean; signal?: AbortSignal; router?: RouterInfo },
): Promise<{ autoPick?: string; result: Awaited<ReturnType<typeof import('../../prototype/src/dispatch.js').dispatch>>; override: string }> {
  const pol = loadPolicy(repo);
  const stats = buildFleetStats(path.join(repo, '.orchestra', 'tasks'), pol.policy?.routing?.decay_days ?? 30);
  const auto = resolveWorker(o.role, { policy: pol.policy, stats, router: o.router });
  const { dispatch } = await import('../../prototype/src/dispatch.js');
  const result = await dispatch({
    repo, node: o.node, role: o.role, goal: o.goal, scope: o.scope,
    constraints: [], acceptance: o.acceptance, workerPin: o.pin, model: o.model,
    hooksEnabled: o.hooksEnabled, skillSync: o.skillSync, signal: o.signal, router: o.router,
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
  // CLI update mà chưa chạy conformance lại → badge vàng 'stale'
  const anyForId = readdirSync(dir).some((f) => f.startsWith(`${id}-`) && f.endsWith('.json'));
  return anyForId ? 'stale' : null;
}

// ---------- Chat với Orchestrator (P5.6) ----------
// Brain = 1 CLI trong fleet (mặc định claude) chạy read-only + session resume để nhớ hội thoại.
// Orchestrator KHÔNG tự làm việc — nó phát hành action ```orchestra {json}``` và extension thực thi
// qua đường dispatch/pipeline có đầy đủ guard. Kết quả được feedback lại vào session.

export const ORCHESTRATOR_SYSTEM_PROMPT = `You are Orchestra Orchestrator — an IDE agent that coordinates agent CLIs (claude, codex, ...) as workers in a gated pipeline.
You are chatting with the user in VS Code. Mandatory rules:
1. Reply BRIEFLY, in the language the user writes in.
2. You are in read-only (plan) mode — do NOT edit files, do NOT write code yourself. You MAY use Glob/Grep/Read to survey the repo before answering.
3. When the user asks for work in the repo (add a feature, fix a bug, run a pipeline, sync skills, check status...), issue an action in a fenced block with exactly this syntax:
\`\`\`orchestra
{"action":"dispatch","goal":"<goal>","scope":["src/**"],"worker":"codex|claude|auto","model":"optional"}
\`\`\`
or:
- {"action":"pipeline","template":"feature-dev|hotfix","goal":"...","scope":["..."]}
- {"action":"status"}  — show fleet + recent tasks
- {"action":"sync_skills"} — sync KB to AGENTS.md/CLAUDE.md
4. EVERY dispatch/pipeline action MUST have a scope (list of globs). Determine scope in this order:
   a. the PROJECT KNOWLEDGE provided below (project memory) — if a module matches, use its scope;
   b. none → survey the repo with Glob/Grep/Read to find the relevant module (e.g. grep the feature name);
   c. still unsure → ASK the user for the scope, do not guess. A dispatch without scope is rejected by the system (mandatory guardrail).
5. A message should contain at most 1-2 actions. Wait for the [orchestra-runner] result before the next action.
6. For advisory/conceptual questions answer directly, no action needed.`;

export interface OrchestraAction {
  action: 'dispatch' | 'pipeline' | 'status' | 'sync_skills';
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
      /* block JSON lỗi — bỏ qua, không crash chat */
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
  // P5.7: bơm project memory vào chat brain — worker-agnostic (codex brain không đọc CLAUDE.md)
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

export async function executeAction(repo: string, a: OrchestraAction, opts: { hooksEnabled?: boolean; skillSync?: boolean } = {}): Promise<string> {
  switch (a.action) {
    case 'status': {
      const fleet = fleetSnapshot().map((f) => `${f.id}@${f.version ?? '?'}${f.installed ? '' : ' (not installed)'}`).join(', ');
      const tasks = tasksSnapshot(repo).slice(0, 5).map((t) => `${t.id} ${t.node}/${t.worker} exit=${t.exit}`);
      return `Fleet: ${fleet}\nRecent tasks:\n${tasks.map((t) => `- ${t}`).join('\n') || '(none)'}`;
    }
    case 'sync_skills': {
      const { syncSkills } = await import('../../prototype/src/skillsync.js');
      const r = syncSkills(repo);
      return `synced ${r.entries} KB (${r.pinned} pinned) → ${r.files.join(' + ')}`;
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
        skillSync: opts.skillSync ?? true,
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
        autoYes: true, // chat là context async — không có stdin để hỏi
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
 * D1 — chatExchange: vòng lặp chat hoàn chỉnh (turn → parse action → execute → feedback).
 * Dùng chung cho extension ChatView + Desktop chat page — không còn 2 bản.
 */
export interface ChatMessage {
  kind: 'orch' | 'result';
  text: string;
}

export async function chatExchange(
  repo: string,
  userText: string,
  sessionId: string | undefined,
  opts: { workerId?: string; model?: string; notify?: (m: ChatMessage) => void; hooksEnabled?: boolean; skillSync?: boolean },
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

// ---------- M1: tool cho Orchestra brain (brain.ts) — worker chỉ chạm qua fleet_dispatch/fleet_pipeline ----------
// Tier: T0 khảo sát (auto) · T1 đường guarded sẵn có (auto) · T2 cần user duyệt (approve)

export const BRAIN_SYSTEM_PROMPT = `You are Orchestra — the coordinating agent. You talk to the user directly; the agent CLIs (claude, codex, ...) are only workers you drive via tools.
Rules:
1. Reply BRIEFLY.
2. You do NOT edit code yourself. For repo work: survey first (repo_glob/repo_grep/repo_read/git_diff), then fleet_dispatch or fleet_pipeline with an explicit glob scope.
3. Scope unclear → ASK the user, do not guess.
4. Merging / changing policy needs user approval — the system asks automatically when you call the tool.
5. Before fleet_merge you must call task_diff and read the diff; state what you checked.
6. Report results briefly: worker, task id, files changed, ok/fail. Never tell the user to talk to a worker themselves.`;

// ngôn ngữ do chính user quyết (theo tin nhắn), KHÔNG theo locale UI/i18n
const BRAIN_LANGUAGE = `\nLANGUAGE: always reply in the same language as the user's latest message. When you dispatch work, write goal/acceptance in the user's own words and language — do not translate them.`;
export function brainSystemPrompt(repo: string): string {
  const kb = recallKB(repo, ['**'], 1500);
  return BRAIN_SYSTEM_PROMPT + BRAIN_LANGUAGE + (kb.injected ? `\n\nPROJECT KNOWLEDGE (project memory — use it to determine scope):\n${kb.injected}` : '');
}

const strArr = { type: 'array', items: { type: 'string' } };
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
export const BRAIN_TOOLS: { name: string; description: string; input_schema: Record<string, unknown> }[] = [
  { name: 'repo_glob', description: 'List repo files matching a glob (e.g. src/**/*.ts). Max 200.', input_schema: obj({ pattern: { type: 'string' } }, ['pattern']) },
  { name: 'repo_grep', description: 'Search a (JS) regex in repo text files, optionally filtered by glob. Returns path:line. Max 100.', input_schema: obj({ pattern: { type: 'string' }, glob: { type: 'string' } }, ['pattern']) },
  { name: 'repo_read', description: 'Read a repo file (relative path). offset = start line (1-based), limit = number of lines (≤2000).', input_schema: obj({ path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, ['path']) },
  { name: 'git_diff', description: 'git diff (stat + content, truncated) against an optional ref (default: working tree vs HEAD). ref = task id (t-…) → same as task_diff.', input_schema: obj({ ref: { type: 'string' } }) },
  { name: 'task_diff', description: 'Show a task result: worker, changed files, scope check, outcome + patch. Call before fleet_merge.', input_schema: obj({ taskId: { type: 'string' } }, ['taskId']) },
  { name: 'fleet_status', description: 'Fleet worker status + 5 most recent tasks.', input_schema: obj({}) },
  { name: 'fleet_dispatch', description: 'Assign one coding task to a worker (own worktree, guarded + scope check). scope is REQUIRED.', input_schema: obj({ goal: { type: 'string' }, scope: strArr, worker: { type: 'string', description: 'worker id, or empty = auto by policy' }, model: { type: 'string' }, acceptance: strArr }, ['goal', 'scope']) },
  { name: 'fleet_pipeline', description: 'Run a pipeline template (feature-dev | hotfix): plan → implement → verify → review → merge.', input_schema: obj({ template: { type: 'string' }, goal: { type: 'string' }, scope: strArr, model: { type: 'string' } }, ['template', 'goal', 'scope']) },
  { name: 'skills_sync', description: 'Sync project KB to AGENTS.md + CLAUDE.md.', input_schema: obj({}) },
  { name: 'fleet_merge', description: "Merge a task's branch into main (REQUIRES user approval). The system checks the task + runs tests before asking.", input_schema: obj({ taskId: { type: 'string' } }, ['taskId']) },
  { name: 'policy_promote', description: 'Move a worker to #1 for a role in the policy (REQUIRES user approval).', input_schema: obj({ role: { type: 'string' }, cli: { type: 'string' } }, ['role', 'cli']) },
];

export interface BrainToolDeps {
  /** T2: hỏi user — false = từ chối */
  approve: (question: string) => Promise<boolean>;
  /** pipeline plan approval */
  askUser?: (q: string) => Promise<string>;
  hooksEnabled?: boolean;
  skillSync?: boolean;
  templatesDir?: string;
  autoApprovePlan?: boolean;
  onLog?: (line: string) => void;
  /** user bấm Dừng → kill worker đang chạy */
  signal?: AbortSignal;
  /** R2a: worker chạy qua Orchestra router */
  router?: RouterInfo;
}
type ToolOut = { ok: boolean; content: string };

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

/** patch của task (patch_ref) hoặc diff <nhánh hiện tại>...<branch task>; stat = diffstat */
function taskPatch(repo: string, rec: Record<string, any>): { patch: string; stat: string } {
  const ref = rec.artifacts?.patch_ref;
  if (typeof ref === 'string' && existsSync(ref)) {
    const st = git(repo, ['apply', '--stat', ref]);
    // patch cũ (trước fix diffPatch trim) có thể corrupt → rơi xuống diff branch
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
/** chạy `npm test` trong worktree nếu có scripts.test; null = không có test command */
// async — không chặn Electron main; signal (Dừng) kill test
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
// ponytail: walk đồng bộ, trần 20k file — repo khổng lồ cần index/ripgrep
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

// globToRegex: '**/' cần ≥1 thư mục; khảo sát thì cho '**/' khớp cả 0 thư mục (src/**/*.ts ⊇ src/a.ts)
function globMatcher(p: string): (f: string) => boolean {
  const a = globToRegex(p);
  const b = globToRegex(p.replace(/\*\*\//g, ''));
  return (f) => a.test(f) || b.test(f);
}

/** path tương đối nằm trong repo → absolute; thoát ra ngoài → null */
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
      case 'skills_sync':
        return { ok: true, content: await executeAction(repo, { action: 'sync_skills' }) };
      case 'fleet_dispatch': {
        if (!isStr(i.goal)) return bad('goal must be a non-empty string');
        if (!isStrArr(i.scope) || !i.scope.length) return bad('scope is required: non-empty array of globs');
        if (!optStr(i.worker) || !optStr(i.model)) return bad('worker/model must be strings');
        if (i.acceptance !== undefined && !isStrArr(i.acceptance)) return bad('acceptance must be an array of strings');
        const r = await dispatchTracked(repo, {
          node: 'implement', role: 'coder', goal: i.goal, scope: i.scope,
          acceptance: (i.acceptance as string[] | undefined) ?? [],
          pin: isStr(i.worker) && i.worker !== 'auto' ? i.worker : undefined,
          model: isStr(i.model) ? i.model : undefined,
          hooksEnabled: deps.hooksEnabled ?? true, skillSync: deps.skillSync ?? true, signal: deps.signal, router: deps.router,
          onEvent: deps.onLog
            ? (e) => deps.onLog!(e.t === 'tool_use' ? `[tool_use] ${e.tool} ${e.target}` : e.t === 'message' ? `[message] ${e.text}` : `[${e.t}] ${JSON.stringify(e).slice(0, 160)}`)
            : undefined,
        });
        const rec = r.result.record as Record<string, any> | undefined;
        return {
          ok: r.result.ok,
          content: `dispatch ${r.result.ok ? 'OK' : 'FAILED'} task=${r.result.taskId} stage=${r.result.stage}${r.result.reason ? ` reason=${r.result.reason}` : ''} worker=${rec ? pickOf(rec) : '?'} files=[${(rec?.artifacts?.files_changed ?? []).join(', ')}] scope_ok=${rec?.scope_check?.ok !== false}`,
        };
      }
      case 'fleet_pipeline': {
        if (!isStr(i.template) || !/^[\w-]+$/.test(i.template)) return bad('template must be a name (e.g. feature-dev, hotfix)');
        if (!isStr(i.goal)) return bad('goal must be a non-empty string');
        if (!isStrArr(i.scope) || !i.scope.length) return bad('scope is required: non-empty array of globs');
        if (!optStr(i.model)) return bad('model must be a string');
        const dir = deps.templatesDir || protoAsset('templates');
        const tpl = dir && path.join(dir, `${i.template}.yml`);
        if (!tpl || !existsSync(tpl)) return bad(`no template ${i.template}`);
        const { runPipeline } = await import('../../prototype/src/orchestrator.js');
        const r = await runPipeline({
          repo, templatePath: tpl, goal: i.goal, scope: i.scope, acceptance: [],
          model: isStr(i.model) ? i.model : undefined, signal: deps.signal, router: deps.router,
          autoYes: deps.autoApprovePlan ?? false, askUser: deps.askUser, onLog: deps.onLog ?? (() => {}),
        });
        const nodes = Object.entries(r.nodes).map(([k, n]) => `${k}:${n.status}${n.worker ? `/${n.worker}` : ''}`).join(' ');
        return { ok: r.ok, content: `pipeline ${r.runId} ${r.ok ? 'OK' : 'FAILED'} merged=${r.merged}${r.mergeConflict ? ' (conflict)' : ''} ${nodes}` };
      }
      case 'fleet_merge': {
        if (!isStr(i.taskId)) return bad('taskId must be a string');
        // gate trong code — brain không merge được task rỗng / ngoài scope / test đỏ
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
        if (!(await deps.approve(q))) return bad('user declined');
        const r = reviewMerge(repo, i.taskId, 'merge');
        return { ok: r.ok, content: r.detail };
      }
      case 'policy_promote': {
        if (!isStr(i.role) || !isStr(i.cli)) return bad('role and cli must be strings');
        if (!(await deps.approve(t('ext.promote.ask', { cli: i.cli, role: i.role })))) return bad('user declined');
        const r = promoteWorker(repo, i.role, i.cli);
        return { ok: r.ok, content: r.detail };
      }
      default:
        return bad(`unknown tool: ${name}`);
    }
  };
}

/** dữ liệu Role × Worker matrix — Desktop render bằng CSS của app, VS Code dùng policyMatrixHtml */
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
      // host-agnostic: VS Code webview dùng acquireVsCodeApi; Desktop iframe dùng parent.postMessage
      const vscode = window.acquireVsCodeApi ? window.acquireVsCodeApi() : { postMessage: (m) => window.parent.postMessage(m, '*') };
      document.querySelectorAll('td[data-role]').forEach((td) => {
        td.addEventListener('click', () => {
          vscode.postMessage({ kind: 'promote', role: td.dataset.role, cli: td.dataset.cli });
        });
      });
    </script>` : ''}
  </body></html>`;
}
