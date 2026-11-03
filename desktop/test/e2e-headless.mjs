// E2E headless — runs the exact Desktop code path (IPC handler → logic.ts) without a GUI:
// G2: dispatchTracked (Dashboard dispatch) + onEvent transcript
// G3: runPipeline with injectable askUser (simulated approval modal: log question + auto 'y')
// Real model calls — costs ~$1
import path from 'node:path';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import {
  fleetSnapshot, tasksSnapshot, dispatchTracked,
} from '../out/extension/src/logic.js';
import { runPipeline } from '../out/prototype/src/orchestrator.js';
import { loadSettings, saveSettings } from '../out/desktop/src/main/settingsStore.js';

const PROTO = path.resolve('..');
const DEMO = path.join(PROTO, 'prototype', 'demo-repo');
const results = [];
const gate = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name} — ${detail}`);
};

// --- prepare settings like the Dashboard handler does ---
const settingsFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'orch-e2e-')), 'settings.json');
saveSettings(settingsFile, { repos: [DEMO], activeRepo: DEMO, orchestratorWorker: 'claude', autoApprovePlan: false, hooksEnabled: true, skillSync: true, templatesDir: '' });
const s = loadSettings(settingsFile);
console.log(`settings: activeRepo=${s.activeRepo.split(/[\\/]/).pop()} hooks=${s.hooksEnabled} sync=${s.skillSync}`);

// --- G1: fleet as the Dashboard loads it ---
const fleet = fleetSnapshot();
gate('G1 fleet from app-path', fleet.filter((f) => f.installed).length >= 2, fleet.map((f) => `${f.id}:${f.installed}`).join(' '));

// --- G2: real dispatch via dispatchTracked (same IPC DISPATCH handler) ---
const events = [];
const d = await dispatchTracked(DEMO, {
  node: 'implement',
  role: 'coder',
  goal: 'Thêm hàm helper formatPrice(cents) trả chuỗi "1.234đ" vào src/payment/gateways/stripe.ts (export thêm). Không sửa file khác.',
  scope: ['src/payment/**'],
  acceptance: ['formatPrice export'],
  hooksEnabled: true,
  skillSync: true,
  onEvent: (e) => events.push(e.t),
});
const hasSeq = events.includes('session') && events.includes('tool_use') && events.includes('usage') && events.includes('done');
const rec = d.result.record ? JSON.parse(readFileSync(d.result.recordPath, 'utf8')) : null;
gate(
  'G2 dispatch from app-path',
  d.result.ok && hasSeq && !!rec && rec.scope_check.ok === true,
  `taskId=${d.result.taskId} events=[${[...new Set(events)].join(',')}] files=[${(rec?.artifacts?.files_changed ?? []).join(',')}] scope_ok=${rec?.scope_check?.ok} session=${rec?.session?.slice(0, 8)}…`,
);

// --- G3: pipeline with simulated approval modal ---
const logs = [];
let approvalAsked = false;
const p = await runPipeline({
  repo: DEMO,
  templatePath: path.join(PROTO, 'prototype', 'templates', 'feature-dev.yml'),
  goal: 'Thêm cổng thanh toán PayOS vào src/payment/gateways/payos.ts theo đúng pattern PaymentGateway trong stripe.ts (constructor nhận partnerCode, createPayment trả reference payos_*, verify trả paid=false, import type). Không sửa file khác, không BOM.',
  scope: ['src/payment/**'],
  acceptance: ['payos implements PaymentGateway'],
  autoYes: false, // force the pipeline to ASK — no stdin, only injectable askUser
  onLog: (l) => logs.push(l),
  askUser: async (q) => {
    approvalAsked = true;
    console.log(`  [simulated-modal] ${q} → 'y'`);
    return 'y';
  },
});
gate(
  'G3 pipeline + modal approval',
  p.ok && p.merged && approvalAsked,
  `runId=${p.runId} merged=${p.merged} approvalAsked=${approvalAsked} nodes=${Object.entries(p.nodes).map(([k, v]) => `${k}:${v.status}`).join(' ')}`,
);
gate('G3 transcript live (onLog streaming)', logs.length >= 6 && logs.some((l) => l.includes('▶ node')), `${logs.length} log lines`);

// --- G4: chat brain (tested in P5.7, rerun in E2E) ---
const { orchestratorTurn, parseOrchestraActions } = await import('../out/extension/src/logic.js');
const c = await orchestratorTurn(DEMO, 'Trạng thái fleet hiện tại? Trả lời 1 câu.', undefined, 'claude');
gate('G4 chat brain', c.text.length > 10 && !!c.session, `session=${c.session?.slice(0, 8)}… text="${c.text.slice(0, 60).replace(/\n/g, ' ')}…"`);

// --- summary ---
const pass = results.every((r) => r.ok);
console.log('---');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
console.log(pass ? 'E2E HEADLESS GATE PASS ✓ (G2/G3 mechanics + G1/G4)' : 'E2E FAIL');
process.exit(pass ? 0 : 1);
