// Pipeline Runner v0 — turns the DSL into a self-running workflow (P3)
// State = file directory (.orchestra/runs/<runId>/state.json) — no DB (roadmap P3)
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import * as readline from 'node:readline/promises';
import { loadPipeline, topoSort, validatePipeline, type NodeDef, type PipelineDef } from './pipeline.js';
import { evalGates, type GateContext, type GateResult } from './gates.js';
import { dispatch, type DispatchResult } from './dispatch.js';
import { mergeBranch } from './worktree.js';
import { spawnSync } from 'node:child_process';
import { t } from './i18n/index.js';

export interface RunPipelineOptions {
  repo: string;
  templatePath: string;
  goal: string;
  scope?: string[];
  acceptance?: string[];
  params?: Record<string, unknown>;
  /** auto-approve the plan (unattended demo) */
  autoYes?: boolean;
  /** P5: log hook for the IDE panel */
  onLog?: (line: string) => void;
  /** D1: ask-user callback — injected by Desktop/Extension (GUI has no stdin); defaults to readline */
  askUser?: (q: string) => Promise<string>;
  /** model override for implement + fixer — plan/verify/review keep policy (independent cross-review) */
  model?: string;
  /** user clicks Stop → kill the running worker */
  signal?: AbortSignal;
  /** R2a: Orchestra router for every node */
  router?: import('./types.js').RouterInfo;
  /** skills delivered to every node (dispatch filters by worker) */
  skills?: string[];
  projectId?: string | null;
}

export interface NodeState {
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'aborted';
  worker?: string;
  attempts: number;
  taskId?: string;
  worktree?: string;
  gates?: GateResult[];
  error?: string;
}

export interface RunSummary {
  ok: boolean;
  runId: string;
  statePath: string;
  merged: boolean;
  mergeConflict: boolean;
  nodes: Record<string, NodeState>;
}

interface Wt {
  path: string;
  branch: string;
}

async function askUser(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(q);
  rl.close();
  return a.trim().toLowerCase();
}

function lastAssistantText(events: { t: string; [k: string]: unknown }[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.t === 'message' && typeof e['text'] === 'string') return e['text'];
  }
  return undefined;
}

function pickWorker(d: DispatchResult): string | undefined {
  const r = (d.record as { routing?: { pick?: string } } | undefined)?.routing;
  return typeof r?.pick === 'string' ? r.pick : undefined;
}

export async function runPipeline(o: RunPipelineOptions): Promise<RunSummary> {
  const def: PipelineDef = loadPipeline(o.templatePath);
  const errors = validatePipeline(def);
  if (errors.length) {
    throw new Error(t('core.orchestrator.invalidPipeline', { errors: errors.join('\n  - ') }));
  }
  const order = topoSort(def.nodes);

  const runId = `r-${Date.now().toString(36)}`;
  const runsDir = path.join(o.repo, '.orchestra', 'runs', runId);
  mkdirSync(runsDir, { recursive: true });
  copyFileSync(o.templatePath, path.join(runsDir, 'pipeline.yml')); // snapshot template (spec §10)

  const params: Record<string, unknown> = {};
  for (const p of def.params ?? []) if (p.default !== undefined) params[p.name] = p.default;
  Object.assign(params, o.params ?? {});

  const nodeState: Record<string, NodeState> = {};
  for (const n of def.nodes) nodeState[n.id] = { status: 'pending', attempts: 0 };
  const workerOf: Record<string, string> = {};
  const lastMsgOf: Record<string, string> = {};
  const recordOf: Record<string, DispatchResult['record']> = {};
  let implWt: Wt | undefined;
  let lastSessionByNode: Record<string, string | undefined> = {};
  let merged = false;
  let mergeConflict = false;
  let aborted = false;

  const statePath = path.join(runsDir, 'state.json');
  const persist = () =>
    writeFileSync(
      statePath,
      JSON.stringify(
        { runId, goal: o.goal, template: o.templatePath, params, merged, aborted, nodes: nodeState },
        null,
        2,
      ),
      'utf8',
    );
  persist();

  const log = (s: string) => {
    console.log(`[run ${runId}] ${s}`);
    o.onLog?.(`[run ${runId}] ${s}`);
  };
  const ask = o.askUser ?? askUser; // D1: GUI injects IPC dialog; CLI uses readline

  const baseCtx = (): GateContext => ({
    repo: o.repo,
    wtPath: implWt?.path ?? o.repo,
    params,
    testCommand: def.test_command,
    lastMessage: (id) => (id === '__current__' ? undefined : lastMsgOf[id]),
  });

  // ----- execute a node once (excluding retries) -----
  const execNode = async (node: NodeDef): Promise<{ ok: boolean; reason?: string }> => {
    const st = nodeState[node.id]!;
    const distinct = node.distinct_worker_from ?? [];
    const exclude = distinct.map((d) => workerOf[d]).filter((w): w is string => Boolean(w));
    const scope = o.scope ?? [];

    let d: DispatchResult;
    switch (node.type) {
      case 'plan': {
        d = await dispatch({
          repo: o.repo, signal: o.signal, router: o.router, skills: o.skills, projectId: o.projectId, node:'plan', role: node.role ?? 'planner',
          goal: `Write a plan (max 8 steps, files_touched, risks) for the task: ${o.goal}`,
          scope: [], constraints: [], acceptance: [],
          excludeWorkers: exclude, wallMs: 180_000,
        });
        if (!d.ok || !d.record) return fail(d);
        const text = lastMsgFromEvents(d);
        lastMsgOf[node.id] = text ?? '';
        workerOf[node.id] = pickWorker(d) ?? '';
        recordOf[node.id] = d.record;
        log(t('core.orchestrator.planBy', { worker: workerOf[node.id]!, text: (text ?? t('core.orchestrator.noContent')).slice(0, 1500) }));
        if (node.approval === 'required') {
          const ans = o.autoYes ? 'y' : await ask(t('core.orchestrator.approvePlan'));
          if (ans !== 'y') { st.status = 'aborted'; aborted = true; persist(); return { ok: false, reason: t('core.orchestrator.planRejected') }; }
        }
        return { ok: true };
      }

      case 'implement': {
        d = await dispatch({
          repo: o.repo, signal: o.signal, router: o.router, skills: o.skills, projectId: o.projectId, node:'implement', role: node.role ?? 'coder',
          goal: o.goal, scope,
          constraints: [], acceptance: o.acceptance ?? [],
          excludeWorkers: exclude, model: o.model,
          wallMs: node.budget?.minutes ? node.budget.minutes * 60_000 : 300_000,
          resumeSession: lastSessionByNode[node.id], // P6.2 — retry resumes the previous session
        });
        if (!d.ok || !d.record) return fail(d);
        workerOf[node.id] = pickWorker(d) ?? '';
        recordOf[node.id] = d.record;
        lastMsgOf[node.id] = lastMsgFromEvents(d) ?? '';
        implWt = d.record.worktree as Wt;
        st.worktree = implWt.path;
        if (typeof d.record['session'] === 'string') lastSessionByNode[node.id] = d.record['session'];
        log(t('core.orchestrator.implementBy', { worker: workerOf[node.id]!, path: implWt.path }));
        return { ok: true };
      }

      case 'verify': {
        if (!implWt) return { ok: false, reason: t('core.orchestrator.verifyBeforeImpl') };
        d = await dispatch({
          repo: o.repo, signal: o.signal, router: o.router, skills: o.skills, projectId: o.projectId, node:'verify', role: node.role ?? 'verifier',
          goal: `Verify the changes for the task: ${o.goal}`,
          scope, constraints: [], acceptance: [],
          reuseWorktree: implWt, excludeWorkers: exclude, wallMs: 240_000,
          promptOverride: [
            `This worktree already contains changes for the task: "${o.goal}".`,
            def.test_command ? `Run '${def.test_command}' to check them.` : 'Check the changes.',
            'Read git diff --cached and report briefly: any obvious bugs, and whether the tests run.',
          ].join('\n'),
        });
        if (!d.ok || !d.record) return fail(d);
        workerOf[node.id] = pickWorker(d) ?? '';
        recordOf[node.id] = d.record;
        lastMsgOf[node.id] = lastMsgFromEvents(d) ?? '';
        return { ok: true };
      }

      case 'review': {
        if (!implWt) return { ok: false, reason: t('core.orchestrator.reviewBeforeImpl') };
        d = await dispatch({
          repo: o.repo, signal: o.signal, router: o.router, skills: o.skills, projectId: o.projectId, node:'review', role: node.role ?? 'reviewer',
          goal: `Review the changes for the task: ${o.goal}`,
          scope, constraints: [], acceptance: [],
          reuseWorktree: implWt, excludeWorkers: exclude, wallMs: 240_000,
          promptOverride: [
            `Review the changes (git diff --cached) for the task: "${o.goal}".`,
            `Allowed scope: ${scope.join(', ') || 'whole repo'}.`,
            'Checklist: meets the requirements, no edits outside scope, code quality, risks.',
            'REQUIRED: the last line of your answer must be "VERDICT: approved" or "VERDICT: changes_requested".',
          ].join('\n'),
        });
        if (!d.ok || !d.record) return fail(d);
        workerOf[node.id] = pickWorker(d) ?? '';
        recordOf[node.id] = d.record;
        lastMsgOf[node.id] = lastMsgFromEvents(d) ?? '';
        return { ok: true };
      }

      case 'run': {
        if (!node.command) return { ok: false, reason: t('core.orchestrator.runNoCommand', { id: node.id }) };
        const r = spawnSync(node.command, { cwd: implWt?.path ?? o.repo, encoding: 'utf8', shell: true, windowsHide: true, timeout: 120_000 });
        log(`run '${node.command}' → exit=${r.status}`);
        return r.status === 0 ? { ok: true } : { ok: false, reason: `${node.command} exit=${r.status}: ${String(r.stdout ?? r.stderr ?? '').slice(-300)}` };
      }

      case 'merge_gate': {
        // gate uses the implement node's record (files_changed for the whole branch, not the incremental review)
        const implNode = def.nodes.find((n) => n.type === 'implement');
        const ctx: GateContext = {
          ...baseCtx(),
          wtPath: implWt?.path ?? o.repo,
          record: implNode ? recordOf[implNode.id] : undefined,
          lastMessage: (id) => (id === '__current__' ? lastMsgOf[node.id] : lastMsgOf[id]),
        };
        const outcome = evalGates(node.gate, ctx);
        st.gates = outcome.results;
        for (const g of outcome.results) log(`gate ${g.ok ? '✓' : '✗'} ${g.gate} — ${g.detail}`);
        if (!outcome.ok) return { ok: false, reason: t('core.orchestrator.mergeGateFailed') };
        if (!implWt) return { ok: false, reason: t('core.orchestrator.noWorktree') };
        const m = mergeBranch(o.repo, implWt.branch);
        if (!m.ok) { mergeConflict = true; return { ok: false, reason: `merge conflict: ${m.out.slice(-300)}` }; }
        merged = true;
        log(t('core.orchestrator.merged', { branch: implWt.branch }));
        return { ok: true };
      }

      default:
        return { ok: false, reason: t('core.orchestrator.unsupportedType', { type: node.type }) };
    }

    function fail(dd: DispatchResult): { ok: false; reason: string } {
      return { ok: false, reason: dd.reason ?? t('core.orchestrator.dispatchFailed', { stage: String(dd.stage) }) };
    }
  };

  function lastMsgFromEvents(d: DispatchResult): string | undefined {
    // dispatch returns no detailed events — read the usage/message aggregated into the record
    const rec = d.record as Record<string, unknown> | undefined;
    if (!rec) return undefined;
    // events aren't stored in the record (counts only) → message comes from a separate run: fallback ''
    return typeof rec['last_message'] === 'string' ? (rec['last_message'] as string) : undefined;
  }

  // ----- main loop in topo order, with on_fail -----
  for (const nodeId of order) {
    const node = def.nodes.find((n) => n.id === nodeId)!;
    const st = nodeState[nodeId]!;
    if (aborted) { st.status = 'aborted'; persist(); continue; }

    // skip propagation by when.paths (matched against run scope)
    if (node.when?.paths && o.scope && o.scope.length) {
      const overlap = node.when.paths.some((p) => o.scope!.includes(p));
      if (!overlap) { st.status = 'skipped'; log(t('core.orchestrator.skip', { id: nodeId })); persist(); continue; }
    }

    log(`▶ node ${nodeId} (${node.type})`);
    st.status = 'running';
    persist();

    let attempt = 0;
    let nodeDone = false;
    let fixAttempts = 0;

    while (!nodeDone && !aborted) {
      attempt++;
      st.attempts = attempt;
      const res = await execNode(node);

      // Deterministic gate evaluated AFTER the node finishes (merge_gate evaluates itself in execNode)
      if (res.ok && node.gate && node.type !== 'merge_gate') {
        const gctx: GateContext = {
          ...baseCtx(),
          wtPath: implWt?.path ?? o.repo,
          record: recordOf[node.id],
          lastMessage: (id) => (id === '__current__' ? lastMsgOf[node.id] : lastMsgOf[id]),
        };
        const outcome = evalGates(node.gate, gctx);
        st.gates = outcome.results;
        for (const g of outcome.results) log(`gate ${g.ok ? '✓' : '✗'} ${g.gate} — ${g.detail}`);
        if (!outcome.ok) {
          res.ok = false;
          res.reason = t('core.orchestrator.gateFailed', { gates: outcome.results.filter((r) => !r.ok).map((r) => r.gate).join(', ') });
        }
      }

      persist();

      if (res.ok) {
        st.status = 'done';
        nodeDone = true;
        persist();
        break;
      }

      st.error = res.reason;
      log(t('core.orchestrator.nodeFailed', { id: nodeId, attempt, reason: String(res.reason) }));

      const of = node.on_fail;
      if (!of) { st.status = 'failed'; aborted = true; persist(); break; }

      if (of.action === 'retry') {
        if (attempt > (of.max_retries ?? 0)) { await thenAction(of.then); break; }
        log(`retry ${nodeId} (${attempt}/${of.max_retries})`);
        continue;
      }

      if (of.action === 'spawn_fix') {
        if (fixAttempts >= (of.max_retries ?? 0)) { await thenAction(of.then); break; }
        fixAttempts++;
        log(`spawn fix #${fixAttempts} for ${nodeId}`);
        const fix = await dispatch({
          repo: o.repo, signal: o.signal, router: o.router, skills: o.skills, projectId: o.projectId, node:'implement', role: 'fixer',
          goal: `Fix according to feedback: ${res.reason ?? ''}`,
          scope: o.scope ?? [], constraints: [], acceptance: [],
          reuseWorktree: implWt, wallMs: 240_000, model: o.model,
          promptOverride: [
            `Feedback from the check step: "${lastMsgOf[nodeId] ?? res.reason ?? ''}"`,
            `Original task: "${o.goal}". Scope: ${(o.scope ?? []).join(', ')}.`,
            'Fix in the current worktree until the feedback is addressed.',
          ].join('\n'),
        });
        if (!fix.ok) log(t('core.orchestrator.fixFailed', { reason: String(fix.reason) }));
        continue; // re-run the node (e.g. review re-evaluates)
      }

      if (of.action === 'ask_user') {
        const ans = o.autoYes ? 'y' : await ask(t('core.orchestrator.askRetry', { id: nodeId }));
        if (ans !== 'y') { st.status = 'failed'; aborted = true; persist(); break; }
        continue;
      }

      // abort
      st.status = 'failed';
      aborted = true;
      persist();
      break;
    }

    async function thenAction(then: 'ask_user' | 'abort' | 'continue' | undefined): Promise<void> {
      if (then === 'continue') return;
      if (then === 'ask_user' && !o.autoYes) {
        const ans = await ask(t('core.orchestrator.askSkip', { id: nodeId }));
        if (ans === 'y') { st.status = 'failed'; nodeDone = true; return; }
      }
      st.status = 'failed';
      aborted = true;
      persist();
    }
  }

  persist();
  const hasMergeGate = def.nodes.some((n) => n.type === 'merge_gate');
  const ok = !aborted && (!hasMergeGate || (merged && !mergeConflict));
  return { ok, runId, statePath, merged, mergeConflict, nodes: nodeState };
}
