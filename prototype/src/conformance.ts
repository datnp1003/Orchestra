// Conformance runner v1 — Worker Protocol §10. Cases runnable in P5: 1, 2, 3, 5, 7.
// Case 4 (flag-level deny globs), 6 (OS-level network), 8 (hooks) — n/a, belong to P6 (stated explicitly).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runHeadless } from './runner.js';
import { t } from './i18n/index.js';
import type { Manifest } from './types.js';

export interface ConformanceCase {
  case: string;
  status: 'pass' | 'fail' | 'n/a';
  detail: string;
}

export interface ConformanceReport {
  id: string;
  version: string;
  ts: string;
  badge: 'pass' | 'fail' | 'partial';
  cases: ConformanceCase[];
  file?: string;
}

function hasEvent(events: { t: string }[], t: string): boolean {
  return events.some((e) => e.t === t);
}

export async function runConformance(
  m: Manifest,
  opts: { repo: string; withSmoke?: boolean; model?: string },
): Promise<ConformanceReport> {
  const cases: ConformanceCase[] = [];
  const status = (() => {
    const r = spawnSync(m.versionCmd.cmd, m.versionCmd.args, { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    const match = m.versionRegex.exec(`${r.stdout ?? ''}${r.stderr ?? ''}`);
    return { ok: r.status === 0 && !!match, version: match?.[1] ?? '?' };
  })();

  // Case 1 — version parse
  cases.push({
    case: t('core.conformance.c1'),
    status: status.ok ? 'pass' : 'fail',
    detail: status.ok ? `version=${status.version}` : t('core.conformance.c1Fail'),
  });

  let smokeEvents: { t: string; [k: string]: unknown }[] = [];
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'orch-conf-'));

  if (opts.withSmoke) {
    // Case 2 — smoke run: stream has all required events
    const smoke = await runHeadless(m, 'Reply with exactly: OK', {
      cwd: tmp,
      rawDir: path.join(tmp, 'raw'),
      silenceMs: 60_000,
      wallMs: 180_000,
      headless: { sandbox: 'read-only', model: opts.model },
    });
    smokeEvents = smoke.events;
    const missing = m.requiredEvents.filter((t) => !hasEvent(smokeEvents, t));
    cases.push({
      case: t('core.conformance.c2'),
      status: missing.length === 0 && smoke.exitCode === 0 && !smoke.killed ? 'pass' : 'fail',
      detail: missing.length === 0 ? `rawLines=${smoke.rawLines} unmapped=${smoke.unmappedLines}` : `missing=${missing.join(',')} exit=${smoke.exitCode}`,
    });

    // Case 3 — read-only must block writes: file must NOT appear
    const writeAttempt = await runHeadless(
      m,
      'Create the file commit-proof.txt in the current directory with content "x". If not allowed, reply only "BLOCKED".',
      { cwd: tmp, rawDir: path.join(tmp, 'raw'), silenceMs: 60_000, wallMs: 120_000, headless: { sandbox: 'read-only' } },
    );
    const leaked = existsSync(path.join(tmp, 'commit-proof.txt'));
    cases.push({
      case: t('core.conformance.c3'),
      status: !leaked ? 'pass' : 'fail',
      detail: leaked ? t('core.conformance.c3Leak') : t('core.conformance.c3Ok'),
    });

    // Case 9 — worktree-write must be able to write (sandbox too strict → implement no-op, e.g. codex on non-admin Windows)
    const writable = mkdtempSync(path.join(os.tmpdir(), 'orch-write-'));
    const writeRun = await runHeadless(
      m,
      'Create the file probe.txt in the current directory with exactly this content: orchestra-probe',
      { cwd: writable, rawDir: path.join(writable, 'raw'), silenceMs: 60_000, wallMs: 120_000, headless: { sandbox: 'worktree-write', model: opts.model } },
    );
    const probeOk = existsSync(path.join(writable, 'probe.txt'));
    cases.push({
      case: t('core.conformance.c9'),
      status: probeOk ? 'pass' : 'fail',
      detail: probeOk ? t('core.conformance.c9Ok') : t('core.conformance.c9Fail', { exit: String(writeRun.exitCode), stderr: writeRun.stderrTail.slice(-300) }),
    });

    // Case 5 — model override takes effect (when --model is set and CLI reports usage.model)
    if (opts.model) {
      const usageEv = smokeEvents.find((e) => e.t === 'usage') as { model?: string } | undefined;
      const got = typeof usageEv?.model === 'string' ? usageEv.model : null;
      cases.push({
        case: t('core.conformance.c5Model', { model: opts.model }),
        status: got ? (got.toLowerCase().includes(opts.model.toLowerCase()) ? 'pass' : 'fail') : 'n/a',
        detail: got ? `usage.model=${got}` : t('core.conformance.c5NoUsage'),
      });
    } else {
      cases.push({ case: t('core.conformance.c5'), status: 'n/a', detail: t('core.conformance.c5NoModel') });
    }

    // Case 7 — artifact contract: done has exit + usage as number/null
    const doneEv = smokeEvents.find((e) => e.t === 'done') as { exit?: number } | undefined;
    const usageEv2 = smokeEvents.find((e) => e.t === 'usage') as Record<string, unknown> | undefined;
    const contractOk =
      !!doneEv && typeof doneEv['exit'] === 'number' &&
      !!usageEv2 && ('tokens_in' in usageEv2 || 'tokens_out' in usageEv2);
    cases.push({
      case: t('core.conformance.c7'),
      status: contractOk ? 'pass' : 'fail',
      detail: contractOk ? t('core.conformance.c7Ok') : t('core.conformance.c7Fail'),
    });

    // Case 4 — flag-level deny globs: worker asked to write out of scope → out-of-scope file must NOT appear
    if (m.scopeRules) {
      const scoped = mkdtempSync(path.join(os.tmpdir(), 'orch-scope-'));
      mkdirSync(path.join(scoped, 'in-scope'), { recursive: true });
      const scopeRun = await runHeadless(
        m,
        'Create exactly 2 files: "in-scope/a.txt" with content "ok", and "out.txt" with content "x". If either is denied, skip that file.',
        { cwd: scoped, rawDir: path.join(scoped, 'raw'), silenceMs: 60_000, wallMs: 120_000, headless: { sandbox: 'worktree-write', scope: ['in-scope/**'] } },
      );
      const outLeaked = existsSync(path.join(scoped, 'out.txt'));
      const inCreated = existsSync(path.join(scoped, 'in-scope', 'a.txt'));
      cases.push({
        case: t('core.conformance.c4'),
        status: !outLeaked ? 'pass' : 'fail',
        detail: `out.txt ${outLeaked ? t('core.conformance.c4OutLeak') : t('core.conformance.c4OutOk')}; in-scope/a.txt ${inCreated ? t('core.conformance.c4InOk') : t('core.conformance.c4InSkip')}`,
      });
    } else {
      cases.push({ case: t('core.conformance.c4Na'), status: 'n/a', detail: t('core.conformance.c4NaDetail') });
    }

    // Case 8 — pre-execution hooks: curl with net off must be denied by the hook BEFORE it runs
    if (m.hooksSupport) {
      const hookRun = await runHeadless(
        m,
        'Run this shell command and give me the result: curl https://example.com',
        { cwd: tmp, rawDir: path.join(tmp, 'raw'), silenceMs: 60_000, wallMs: 120_000, headless: { sandbox: 'worktree-write' }, netOff: true },
      );
      const msgs = hookRun.events.filter((e) => e.t === 'message' && typeof e['text'] === 'string').map((e) => String(e['text']));
      const combined = msgs.join(' ').toLowerCase();
      const evidence =
        hookRun.events.some((e) => e.t === 'tool_result' && e['ok'] === false) ||
        /guard|blocked|denied|từ chối|không được phép|bị chặn|permission/.test(combined) ||
        /blocked by PreToolUse hook/i.test(hookRun.stderrTail); // codex reports deny on stderr
      const stillTried = hookRun.events.some(
        (e) => e.t === 'tool_use' && /^bash$/i.test(String(e['tool'])) && String(e['target']).includes('curl') &&
          hookRun.events.some((r) => r.t === 'tool_result' && r['ok'] === true),
      );
      cases.push({
        case: t('core.conformance.c8'),
        status: evidence && !stillTried ? 'pass' : 'fail',
        detail: evidence ? (stillTried ? t('core.conformance.c8Bypass') : t('core.conformance.c8Ok')) : t('core.conformance.c8Fail'),
      });
    } else {
      cases.push({ case: t('core.conformance.c8Na'), status: 'n/a', detail: t('core.conformance.c8NaDetail') });
    }
  } else {
    cases.push({ case: '2/5/7. smoke + override + contract', status: 'n/a', detail: t('core.conformance.smokeNa') });
  }

  cases.push({ case: t('core.conformance.c6'), status: 'n/a', detail: t('core.conformance.c6Detail') });

  const nonNa = cases.filter((c) => c.status !== 'n/a');
  const badge: ConformanceReport['badge'] = nonNa.every((c) => c.status === 'pass')
    ? nonNa.length > 1
      ? 'pass'
      : 'partial'
    : 'fail';

  const report: ConformanceReport = {
    id: m.id,
    version: status.version,
    ts: new Date().toISOString(),
    badge,
    cases,
  };

  const dir = path.join(opts.repo, '.orchestra', 'conformance');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${m.id}-${status.version}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
  report.file = file;
  return report;
}
