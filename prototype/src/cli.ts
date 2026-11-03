import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFESTS, getManifest } from './manifests.js';
import { checkStatus, installWorker, uninstallWorker } from './registry.js';
import { runHeadless } from './runner.js';
import { dispatch } from './dispatch.js';
import { runPipeline } from './orchestrator.js';
import { loadPolicy } from './policy.js';
import { buildFleetStats, syncTasksToSqlite, addFeedback, type FeedbackType } from './memory.js';
import { retrospective } from './retro.js';
import { runConformance } from './conformance.js';
import { vaultSet, vaultGet, vaultList, vaultDelete } from './vault.js';
import { createProviderStore } from './router/providers.js';
import { startRouter } from './router/server.js';
import type { FleetEvent, MapResult } from './types.js';
import type { NodeType } from './brief.js';
import { t, setLocale, detectLocale } from './i18n/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.resolve(__dirname, '..');
const RAW_DIR = path.join(PROTO, '.raw');
const FIXTURES = path.join(PROTO, 'fixtures');

const here = process.cwd();

function parseFlags(args: string[]): { flags: Map<string, string[]>; rest: string[] } {
  const flags = new Map<string, string[]>();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        const list = flags.get(key) ?? [];
        list.push(next);
        flags.set(key, list);
        i++;
      } else flags.set(key, ['true']);
    } else rest.push(a);
  }
  return { flags, rest };
}

const f1 = (flags: Map<string, string[]>, key: string): string | undefined => flags.get(key)?.[0];
const csv = (v: string | undefined): string[] => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

const evTypes = (events: FleetEvent[]): Set<string> => new Set(events.map((e) => e.t));

async function cmdList(): Promise<void> {
  console.log(`# Orchestra prototype — fleet registry (${new Date().toISOString()})`);
  for (const m of MANIFESTS) {
    const s = checkStatus(m);
    const line = [
      s.installed ? '✓' : '✗',
      s.id.padEnd(10),
      (s.version ?? '-').padEnd(12),
      `auth=${s.auth}`.padEnd(16),
      s.experimental ? '[experimental]' : '',
    ].join(' ');
    console.log(line);
    if (s.installed && s.binPath) console.log(`    bin: ${s.binPath}`);
    for (const n of s.notes) console.log(`    note: ${n}`);
  }
}

async function cmdSmoke(id: string, flags: Map<string, string[]>): Promise<number> {
  const m = getManifest(id);
  if (!m) {
    console.error(t('cli.unknownWorkerList', { id, list: MANIFESTS.map((x) => x.id).join(', ') }));
    return 2;
  }
  console.log(`# smoke ${id} — prompt: "Reply with exactly: OK"`);
  const r = await runHeadless(m, 'Reply with exactly: OK', {
    cwd: here,
    rawDir: RAW_DIR,
    silenceMs: 60_000,
    wallMs: 180_000,
    headless: { sandbox: 'read-only', model: f1(flags, 'model') },
  });

  for (const e of r.events) console.log(JSON.stringify(e));

  const seen = evTypes(r.events);
  const missing = m.requiredEvents.filter((t) => !seen.has(t));
  const pass = !r.killed && r.exitCode === 0 && missing.length === 0;

  console.log('---');
  console.log(`raw: ${r.rawPath}`);
  console.log(`rawLines=${r.rawLines} unmapped=${r.unmappedLines} exit=${r.exitCode} killed=${r.killed}${r.killReason ? ` (${r.killReason})` : ''}`);
  if (r.stderrTail) console.log(`stderr(tail): ${r.stderrTail.split('\n').slice(-3).join(' | ')}`);
  if (missing.length) console.log(`MISSING events: ${missing.join(', ')}`);
  console.log(`SMOKE ${id}: ${pass ? 'PASS ✓' : 'FAIL ✗'}  (events: ${[...seen].sort().join(',')})`);

  if (flags.has('save-fixture') && pass) {
    mkdirSync(FIXTURES, { recursive: true });
    const dest = path.join(FIXTURES, `${id}-stream.jsonl`);
    copyFileSync(r.rawPath, dest);
    console.log(`fixture saved: ${dest}`);
  }
  return pass ? 0 : 1;
}

async function cmdRun(id: string, promptParts: string[], flags: Map<string, string[]>): Promise<number> {
  const m = getManifest(id);
  if (!m) {
    console.error(t('cli.unknownWorker', { id }));
    return 2;
  }
  const prompt = promptParts.join(' ');
  if (!prompt) {
    console.error(t('cli.run.noPrompt'));
    return 2;
  }
  const sandbox = f1(flags, 'sandbox') === 'worktree-write' ? 'worktree-write' : 'read-only';
  const r = await runHeadless(m, prompt, {
    cwd: f1(flags, 'cwd') ? path.resolve(f1(flags, 'cwd')!) : here,
    rawDir: RAW_DIR,
    wallMs: Number(f1(flags, 'wall-ms') ?? 300_000),
    headless: { sandbox, model: f1(flags, 'model') },
  });
  for (const e of r.events) console.log(JSON.stringify(e));
  console.error(`--- raw=${r.rawPath} unmapped=${r.unmappedLines} exit=${r.exitCode}`);
  return r.exitCode === 0 && !r.killed ? 0 : 1;
}

async function cmdReplay(id: string, fixturePath: string): Promise<number> {
  const m = getManifest(id);
  if (!m) {
    console.error(t('cli.unknownWorker', { id }));
    return 2;
  }
  const lines = readFileSync(fixturePath, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  let known = 0;
  let unmapped = 0;
  const events: FleetEvent[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      unmapped++;
      continue;
    }
    const res: MapResult = m.mapEvent(parsed, m.id);
    if (res.known) known++;
    else unmapped++;
    events.push(...res.events);
  }
  for (const e of events) console.log(JSON.stringify(e));
  const seen = evTypes(events);
  const missing = m.requiredEvents.filter((t) => !seen.has(t));
  console.error(`--- lines=${lines.length} known=${known} unmapped=${unmapped} missing=[${missing.join(',')}]`);
  return missing.length === 0 && unmapped === 0 ? 0 : 1;
}

async function cmdDispatch(repo: string, goalParts: string[], flags: Map<string, string[]>): Promise<number> {
  const goal = goalParts.join(' ');
  if (!goal) {
    console.error(t('cli.dispatch.usage'));
    return 2;
  }
  if (!existsSync(repo)) {
    console.error(t('cli.repoMissing', { repo }));
    return 2;
  }
  const node = (f1(flags, 'node') ?? 'implement') as NodeType;
  const r = await dispatch({
    repo: path.resolve(repo),
    node,
    role: f1(flags, 'role') ?? 'coder',
    goal,
    scope: csv(f1(flags, 'scope')),
    constraints: csv(f1(flags, 'constraint')),
    acceptance: csv(f1(flags, 'acceptance')),
    workerPin: f1(flags, 'worker'),
    model: f1(flags, 'model'),
    wallMs: f1(flags, 'wall-ms') ? Number(f1(flags, 'wall-ms')) : undefined,
  });

  console.log(`# dispatch ${r.taskId} [${node}]`);
  console.log(`stage: ${r.stage}`);
  if (r.reason) console.log(`reason: ${r.reason}`);
    if (r.record) {
    const rec = r.record as Record<string, any>;
    console.log(`worker: ${(rec.routing as any)?.pick ?? rec.brief?.worker} · model=${(rec.routing as any)?.model ?? '(default)'} (${(rec.routing as any)?.reason})`);
    console.log(`worktree: ${(rec.worktree as any)?.path}`);
    console.log(`run: exit=${(rec.run as any).exit} killed=${(rec.run as any).killed} ${(rec.run as any).duration_ms}ms unmapped=${(rec.run as any).unmapped_lines}`);
    console.log(`files_changed: ${((rec.artifacts as any)?.files_changed ?? []).join(', ') || t('cli.none')}`);
    const sc = rec.scope_check as any;
    console.log(`scope_check: ${sc.ok ? 'PASS' : 'VIOLATION'}${sc.violations.length ? ' → ' + sc.violations.map((x: any) => x.file).join(', ') : ''}`);
    if (rec.usage) console.log(`usage: in=${(rec.usage as any).tokens_in} out=${(rec.usage as any).tokens_out} usd=${(rec.usage as any).usd}`);
    console.log(`record: ${r.recordPath}`);
  }
  return r.ok ? 0 : 1;
}

async function cmdTasks(repo: string): Promise<number> {
  const dir = path.join(path.resolve(repo), '.orchestra', 'tasks');
  if (!existsSync(dir)) {
    console.log(t('cli.tasks.empty'));
    return 0;
  }
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const rec = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
    const sc = rec.scope_check?.ok ? 'scope=OK' : `scope=VIOLATION(${rec.scope_check?.violations?.length ?? 0})`;
    console.log(
      [rec.id, rec.node, rec.routing?.pick ?? rec.brief?.worker, `exit=${rec.run?.exit}`, sc, `${rec.artifacts?.files_changed?.length ?? 0} file`].join('  '),
    );
  }
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const li = argv.indexOf('--lang');
  setLocale(detectLocale(li >= 0 ? argv.splice(li, 2)[1] : process.env.ORCHESTRA_LANG));
  const [cmd, ...rest] = argv;
  const { flags, rest: args } = parseFlags(rest ?? []);
  switch (cmd) {
    case 'list':
      await cmdList();
      return 0;
    case 'smoke': {
      const id = args[0] ?? 'claude';
      return cmdSmoke(id, flags);
    }
    case 'run': {
      const id = args[0] ?? '';
      return cmdRun(id, args.slice(1), flags);
    }
    case 'replay': {
      const id = args[0] ?? '';
      const fixture = args[1] ?? '';
      if (!fixture) {
        console.error(t('cli.replay.usage'));
        return 2;
      }
      return cmdReplay(id, fixture);
    }
    case 'dispatch': {
      const repo = args[0] ?? '.';
      return cmdDispatch(repo, args.slice(1), flags);
    }
    case 'run-pipeline': {
      const repo = args[0] ?? '.';
      const goal = args.slice(1).join(' ');
      if (!goal) {
        console.error(t('cli.pipeline.usage'));
        return 2;
      }
      const tpl = f1(flags, 'template') ?? 'templates/feature-dev.yml';
      const templatePath = path.isAbsolute(tpl) ? tpl : path.join(PROTO, tpl);
      const params: Record<string, unknown> = {};
      for (const kv of flags.get('param') ?? []) {
        const eq = kv.indexOf('=');
        if (eq > 0) params[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
      const r = await runPipeline({
        repo: path.resolve(repo),
        templatePath,
        goal,
        scope: csv(f1(flags, 'scope')),
        acceptance: csv(f1(flags, 'acceptance')),
        params,
        autoYes: flags.has('yes'),
      });
      console.log('---');
      console.log(`PIPELINE ${r.runId}: ${r.ok ? 'OK ✓' : 'FAILED ✗'} merged=${r.merged}${r.mergeConflict ? ' (CONFLICT)' : ''}`);
      for (const [id, st] of Object.entries(r.nodes)) {
        console.log(`  ${id.padEnd(12)} ${st.status.padEnd(8)} worker=${st.worker ?? '-'} attempts=${st.attempts}${st.error ? ` — ${st.error.slice(0, 80)}` : ''}`);
      }
      console.log(`state: ${r.statePath}`);
      return r.ok ? 0 : 1;
    }
    case 'tasks': {
      const repo = args[0] ?? '.';
      return cmdTasks(repo);
    }
    case 'policy': {
      const repo = args[0] ?? '.';
      const lp = loadPolicy(path.resolve(repo));
      console.log(`policy source: ${lp.source}`);
      if (lp.errors.length) for (const e of lp.errors) console.log(`  ✗ ${e}`);
      const b = lp.policy?.bindings ?? {};
      for (const [role, binds] of Object.entries(b)) {
        console.log(`  ${role.padEnd(10)} → ${binds.map((x) => x.worker.cli).join(' > ')}`);
      }
      console.log(`  routing: ${JSON.stringify(lp.policy?.routing ?? {})}`);
      return 0;
    }
    case 'stats': {
      const repo = path.resolve(args[0] ?? '.');
      const dirName = f1(flags, 'dir') ?? 'tasks';
      const decay = Number(f1(flags, 'decay-days') ?? 30);
      const stats = buildFleetStats(path.join(repo, '.orchestra', dirName), decay);
      console.log(`# fleet stats (${dirName}, decay ${decay}d) — worker|role  n  pass  first_try  ema  avg_usd`);
      const rows = [...stats.values()].sort((a, b) => a.role.localeCompare(b.role) || b.ema - a.ema);
      for (const s of rows) {
        console.log(`  ${s.worker.padEnd(8)}|${s.role.padEnd(10)} n=${String(s.dispatched).padEnd(3)} pass=${String(s.passed).padEnd(3)} first_try=${String(s.first_try).padEnd(3)} ema=${s.ema.toFixed(2)} usd=${s.avg_cost_usd?.toFixed(2) ?? '-'}`);
      }
      const n = syncTasksToSqlite(repo);
      console.log(`episodic.sqlite synced: ${n} task records`);
      return 0;
    }
    case 'feedback': {
      const repo = path.resolve(args[0] ?? '.');
      const type = args[1] as FeedbackType;
      if (!type) {
        console.error(t('cli.feedback.usage'));
        return 2;
      }
      addFeedback(repo, { type, taskId: f1(flags, 'task'), worker: f1(flags, 'worker'), detail: f1(flags, 'detail') });
      console.log(t('cli.feedback.saved', { type }));
      return 0;
    }
    case 'retro': {
      const repo = path.resolve(args[0] ?? '.');
      const dirName = f1(flags, 'dir') ?? 'tasks';
      const r = retrospective(repo, dirName, Number(f1(flags, 'min-sample') ?? 5));
      console.log(t('cli.retro.header'));
      for (const p of r.kbProposals) console.log(`  KB proposal: ${p}`);
      for (const p of r.policyProposals) console.log(`  Policy proposal: ${p}`);
      if (!r.kbProposals.length && !r.policyProposals.length) console.log(`  ${t('cli.retro.none')}`);
      return 0;
    }
    case 'conformance': {
      const id = args[0] ?? 'claude';
      const m = getManifest(id);
      if (!m) {
        console.error(t('cli.unknownWorker', { id }));
        return 2;
      }
      const repo = path.resolve(f1(flags, 'repo') ?? '.');
      console.log(`# conformance ${id} — Worker Protocol §10`);
      const r = await runConformance(m, { repo, withSmoke: flags.has('with-smoke'), model: f1(flags, 'model') });
      for (const c of r.cases) console.log(`  [${c.status.toUpperCase().padEnd(4)}] ${c.case} — ${c.detail}`);
      console.log(`badge: ${r.badge} → ${r.file}`);
      return r.badge === 'fail' ? 1 : 0;
    }
    case 'vault': {
      const sub = args[0];
      if (sub === 'list') {
        for (const p of vaultList()) console.log(`  ${p} (configured)`);
        if (!vaultList().length) console.log(`  ${t('cli.vault.empty')}`);
        return 0;
      }
      if (sub === 'set') {
        const provider = args[1];
        const secret = args[2];
        const baseUrl = args[3]; // P6.4: custom provider — ví dụ https://gateway.example.com/v1
        if (!provider || !secret) {
          console.error(t('cli.vault.setUsage'));
          return 2;
        }
        console.log(vaultSet(provider, secret, baseUrl) ? `✓ ${t('cli.vault.saved', { provider })}${baseUrl ? ` (base_url: ${baseUrl})` : ''}` : `✗ ${t('cli.vault.saveFailed')}`);
        return vaultSet(provider, secret, baseUrl) ? 0 : 1;
      }
      if (sub === 'auth') {
        const id = args[1];
        const m = getManifest(id ?? '');
        if (!m) {
          console.error(t('cli.vault.authUsage'));
          return 2;
        }
        console.log(t('cli.vault.authGuide', { display: m.display, id: m.id, bin: m.bin }));
        return 0;
      }
      if (sub === 'get') {
        const provider = args[1];
        const s = provider ? vaultGet(provider) : null;
        if (!s) {
          console.log(t('cli.vault.getNone'));
          return 1;
        }
        console.log(`${provider}: ${s.slice(0, 4)}…${'*'.repeat(8)} ${t('cli.vault.masked')}`);
        return 0;
      }
      if (sub === 'delete') {
        const provider = args[1];
        console.log(provider && vaultDelete(provider) ? `✓ ${t('cli.vault.deleted', { provider })}` : `✗ ${t('cli.vault.notFound')}`);
        return 0;
      }
      console.log(t('cli.vault.usage'));
      return 2;
    }
    case 'install': {
      const id = args[0] ?? '';
      const m = getManifest(id);
      if (!m) {
        console.error(t('cli.unknownWorkerList', { id, list: MANIFESTS.map((x) => x.id).join(', ') }));
        return 2;
      }
      const s = checkStatus(m);
      if (s.installed) {
        console.log(t('cli.install.already', { id, version: s.version ?? '?' }));
        return 0;
      }
      const r = await installWorker(m, (line) => console.log(`  ${line}`));
      console.log(`${r.ok ? '✓' : '✗'} ${r.detail}`);
      if (r.ok) console.log(t('cli.install.loginNote', { bin: m.bin }));
      return r.ok ? 0 : 1;
    }
    case 'uninstall': {
      const id = args[0] ?? '';
      const m = getManifest(id);
      if (!m) {
        console.error(t('cli.unknownWorker', { id }));
        return 2;
      }
      const r = uninstallWorker(m);
      console.log(`${r.ok ? '✓' : '✗'} ${r.detail}`);
      return r.ok ? 0 : 1;
    }
    case 'simulate': {
      const repo = path.resolve(args[0] ?? '.');
      const n = Number(args[1] ?? 12);
      const dir = path.join(repo, '.orchestra', 'sim-tasks');
      mkdirSync(dir, { recursive: true });
      const now = Date.now();
      for (let i = 0; i < n; i++) {
        const worker = i % 2 === 0 ? 'codex' : 'claude';
        const passRate = worker === 'codex' ? 0.7 : 0.95;
        const pass = Math.random() < passRate;
        const ageDays = (n - i) * 3; // trải đều 3n ngày — test decay
        const ts = new Date(now - ageDays * 86_400_000).toISOString();
        const id = `sim-${String(i).padStart(3, '0')}`;
        writeFileSync(
          path.join(dir, `${id}.json`),
          JSON.stringify({
            id, ts, node: 'implement', role: 'coder',
            routing: { pick: worker, reason: 'simulated' },
            run: { exit: pass ? 0 : 1, killed: false },
            scope_check: { ok: pass, violations: [] },
            usage: { usd: worker === 'codex' ? 1.2 : 1.8, tokens_in: 1000, tokens_out: 500 },
            artifacts: { files_changed: [`src/payment/gateways/sim${i % 3}.ts`] },
            brief: { goal: `simulated task ${i}` },
            simulated: true,
          }, null, 2),
          'utf8',
        );
      }
      console.log(t('cli.simulate.done', { n, dir }));
      return 0;
    }
    case 'router': {
      const store = createProviderStore();
      const r = await startRouter({ store, port: Number(f1(flags, 'port') ?? 0), defaultModel: f1(flags, 'default-model'), onLog: (l) => console.log(l) });
      console.log(`router http://127.0.0.1:${r.port}  token=${r.token}  providers=${store.listProviders().map((p) => p.id).join(',') || t('cli.router.noProviders')}`);
      return new Promise<number>(() => {}); // chạy tới Ctrl+C
    }
    default:
      console.log(t('cli.help'));
      return cmd ? 2 : 0;
  }
}

main().then((code) => process.exit(code));
