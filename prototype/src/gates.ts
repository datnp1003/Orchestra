// Deterministic gate evaluator — pipeline-dsl-spec §6.3: closed set, no shell,
// may only reference declared artifacts/params. Gates run in code, no LLM.
import { spawnSync } from 'node:child_process';
import type { GateExpr } from './pipeline.js';
import { t } from './i18n/index.js';

export interface GateContext {
  repo: string;
  wtPath: string;
  params: Record<string, unknown>;
  testCommand?: string;
  /** last message text of each node (used for verdict.approved) */
  lastMessage: (nodeId: string) => string | undefined;
  /** record of the node being evaluated (files_changed…) */
  record?: { artifacts?: { files_changed?: string[] } };
}

export interface GateResult {
  gate: string;
  ok: boolean;
  detail: string;
}

export interface GatesOutcome {
  ok: boolean;
  results: GateResult[];
}

function runTests(ctx: GateContext): GateResult {
  if (!ctx.testCommand) {
    return { gate: 'tests.green', ok: false, detail: t('core.gates.noTestCommand') };
  }
  const r = spawnSync(ctx.testCommand, {
    cwd: ctx.wtPath,
    encoding: 'utf8',
    windowsHide: true,
    shell: true, // "npm test" needs a shell on Windows (npm.cmd)
    timeout: 120_000,
  });
  const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split(/\r?\n/).slice(-5).join(' | ');
  return { gate: 'tests.green', ok: r.status === 0, detail: `exit=${r.status} ${tail.slice(0, 300)}` };
}

function evalOne(expr: GateExpr, ctx: GateContext): GateResult {
  if (typeof expr !== 'string') {
    // {if: params.X, then: gate}
    const key = expr['if'];
    const cond = key.replace(/^params\./, '');
    const val = ctx.params[cond];
    if (!val || val === 'false') {
      return { gate: JSON.stringify(expr), ok: true, detail: `skipped (params.${cond} falsy)` };
    }
    const inner = evalOne(expr['then'], ctx);
    return { gate: `${key} → ${inner.gate}`, ok: inner.ok, detail: inner.detail };
  }

  if (expr === 'tests.green') return runTests(ctx);

  if (expr === 'all_gates_passed') {
    return { gate: expr, ok: true, detail: t('core.gates.allPassed') };
  }

  const verdictMatch = /^verdict\.(approved|changes_requested|blocked)$/.exec(expr);
  if (verdictMatch) {
    const want = verdictMatch[1];
    // whichever node's last message has a VERDICT line — scan nodes that ran
    const text = ctx.lastMessage('__current__') ?? '';
    const m = /VERDICT:\s*(approved|changes_requested|blocked)/i.exec(text);
    if (!m) return { gate: expr, ok: false, detail: t('core.gates.noVerdict') };
    const got = m[1]!.toLowerCase();
    return { gate: expr, ok: got === want, detail: `reviewer verdict=${got}` };
  }

  const filesMatch = /^files_changed\s*(<=|>=|<|>|==)\s*(\d+)$/.exec(expr);
  if (filesMatch) {
    const op = filesMatch[1]!;
    const n = Number(filesMatch[2]);
    const count = ctx.record?.artifacts?.files_changed?.length ?? 0;
    const ok =
      op === '<=' ? count <= n : op === '>=' ? count >= n : op === '<' ? count < n : op === '>' ? count > n : count === n;
    return { gate: expr, ok, detail: `files_changed=${count}` };
  }

  return { gate: expr, ok: false, detail: t('core.gates.unsupported') };
}

export function evalGates(gates: GateExpr[] | undefined, ctx: GateContext): GatesOutcome {
  if (!gates || gates.length === 0) return { ok: true, results: [] };
  const results = gates.map((g) => evalOne(g, ctx));
  return { ok: results.every((r) => r.ok), results };
}
