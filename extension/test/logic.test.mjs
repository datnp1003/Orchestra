// Test logic thuần của extension — node thường, không cần VS Code host
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fleetSnapshot, tasksSnapshot, policyMatrixHtml, mergeableTasks, promoteWorker, restoreDefaultPolicy, trackOverride, conformanceBadge } from '../out/extension/src/logic.js';

// 0. default policy tìm được từ extension/out + modelsList (router R2a)
const { loadPolicy } = await import('../out/prototype/src/policy.js');
const { t } = await import('../out/prototype/src/i18n/index.js');
assert.equal(loadPolicy().source, 'proto-default', 'loadPolicy từ out/');
const { modelsList } = await import('../out/extension/src/logic.js');
const ml = modelsList(['gw/opus', 'oa/gpt'], [
  { id: 'gw', kind: 'anthropic', baseUrl: 'x', formats: ['messages'], enabled: true },
  { id: 'oa', kind: 'openai', baseUrl: 'x', formats: ['responses', 'chat'], enabled: true },
]);
const pick = (w, id) => ml.byWorker[w].find((m) => m.id === id);
assert.deepEqual(ml.models, ['gw/opus', 'oa/gpt']);
assert.ok(pick('claude', 'gw/opus').ok && pick('codex', 'oa/gpt').ok, 'claude+messages, codex+responses');
assert.match(pick('codex', 'gw/opus').reason, /Responses/, 'codex + messages qua router dịch');
assert.equal(pick('antigravity', 'gw/opus').ok, false, 'antigravity chưa hỗ trợ router');
console.log('✓ proto-default từ out/ + modelsList byWorker');

// 1. Fleet snapshot — CLI thật trên máy
const fleet = fleetSnapshot();
assert.ok(Array.isArray(fleet) && fleet.length >= 2, `fleet: ${JSON.stringify(fleet)}`);
const claude = fleet.find((f) => f.id === 'claude');
assert.ok(claude?.installed && claude.version, `claude: ${JSON.stringify(claude)}`);
const codex = fleet.find((f) => f.id === 'codex');
assert.ok(codex?.installed && codex.version, `codex: ${JSON.stringify(codex)}`);
console.log(`✓ fleet: ${fleet.map((f) => `${f.id}@${f.version}`).join(', ')}`);

// 2. Tasks snapshot — demo repo có records từ P2–P4
const tasks = tasksSnapshot();
assert.ok(tasks.length >= 3, `tasks: ${tasks.length}`);
assert.ok(tasks.every((t) => t.id && t.node), 'task record shape');
console.log(`✓ tasks: ${tasks.length} records, mới nhất ${tasks[0]?.id} (${tasks[0]?.node}/${tasks[0]?.worker})`);

// 3. Policy matrix HTML — bảng role×worker + KB + không lỗi validate
const html = policyMatrixHtml();
assert.ok(html.includes('<table'), 'matrix có bảng');
assert.ok(html.includes('coder') && html.includes('planner'), 'matrix có roles');
assert.ok(html.includes('kb-payment-module'), 'matrix có KB entry');
assert.ok(html.includes(t('ext.mx.valid')), 'policy validate pass');
console.log(`✓ matrix html: ${html.length} chars, có roles + KB + policy hợp lệ`);

// 4. Mergeable tasks — branch chưa vào main (P5.2 Review & Merge)
const mergeable = mergeableTasks();
assert.ok(Array.isArray(mergeable), 'mergeable array');
for (const t of mergeable) {
  assert.ok(t.branch && t.branch.startsWith('orchestra/task-'), `branch shape: ${JSON.stringify(t)}`);
  assert.ok(t.files.length >= 0, 'files shape');
}
console.log(`✓ mergeable: ${mergeable.length} task chờ merge (${mergeable.map((t) => t.id).slice(0, 3).join(', ') || '—'})`);

// 5. promoteWorker — click cell phải ghi policy.yml project và load lại là source=project
const repo = 'C:/Users/Nitro V 15/Desktop/Source/Orchestra/prototype/demo-repo';
restoreDefaultPolicy(repo); // bảo đảm bắt đầu từ proto-default
const promo = promoteWorker(repo, 'coder', 'claude');
assert.ok(promo.ok, `promote: ${promo.detail}`);
const htmlAfter = policyMatrixHtml(repo);
assert.ok(htmlAfter.includes('policy source: <b>project</b>'), 'policy source phải là project sau promote');
assert.ok(existsSync(path.join(repo, '.orchestra', 'policy.yml')), 'policy.yml project được ghi');
// yaml ghi ra phải có coder đứng claude trước codex
const yamlText = readFileSync(path.join(repo, '.orchestra', 'policy.yml'), 'utf8');
const coderSection = yamlText.split('bindings:')[1]?.split('coder:')[1]?.split(/\n  \w/)?.[0] ?? '';
assert.ok(coderSection.indexOf('claude') < coderSection.indexOf('codex'), `bindings.coder phải claude trước codex: ${coderSection}`);
restoreDefaultPolicy(repo); // cleanup — trả lại trạng thái proto-default
console.log('✓ promoteWorker: cell click → policy.yml project ghi đúng thứ tự + source=project (đã cleanup)');

// 6. trackOverride — user chọn khác auto-pick → feedback task_reassigned
const tmpRepo = mkdtempSync(path.join(os.tmpdir(), 'orch-ovr-'));
mkdirSync(path.join(tmpRepo, '.orchestra'), { recursive: true });
const t1 = trackOverride(tmpRepo, { autoPick: 'codex', pin: 'claude', taskId: 't-x', ok: true });
assert.ok(t1.tracked, `track: ${t1.detail}`);
const t2 = trackOverride(tmpRepo, { autoPick: 'claude', pin: 'claude', taskId: 't-y', ok: true });
assert.ok(!t2.tracked, 'không phải override — không ghi');
const t3 = trackOverride(tmpRepo, { autoPick: 'codex', pin: 'claude', taskId: 't-z', ok: false });
assert.ok(!t3.tracked, 'dispatch fail — không ghi');
const fb = readFileSync(path.join(tmpRepo, '.orchestra', 'feedback.jsonl'), 'utf8').trim().split('\n');
assert.equal(fb.length, 1, 'đúng 1 feedback event');
assert.ok(fb[0].includes('"type":"task_reassigned"') && fb[0].includes('"worker":"claude"'), `feedback shape: ${fb[0]}`);
rmSync(tmpRepo, { recursive: true, force: true });
console.log('✓ trackOverride: đúng 1 event khi override, 0 khi trùng/fail (temp repo đã xoá)');

// 7. conformance badge — demo repo có badge pass từ P5.2
const badge = conformanceBadge(repo, 'claude', '2.1.310');
assert.equal(badge, 'pass', `badge: ${badge}`);
console.log(`✓ conformanceBadge: claude@2.1.310 = ${badge}`);

// 8. Skill-sync v0 — KB → AGENTS.md + CLAUDE.md (ý tưởng gốc #3)
const { syncSkills } = await import('../out/prototype/src/skillsync.js');
const tmpRepo2 = mkdtempSync(path.join(os.tmpdir(), 'orch-skill-'));
mkdirSync(path.join(tmpRepo2, '.orchestra', 'kb'), { recursive: true });
writeFileSync(
  path.join(tmpRepo2, '.orchestra', 'kb', 'test-conv.md'),
  `---\nid: kb-test-conv\ntitle: "Convention test"\nscope: []\ntags: []\nsource: manual\nconfidence: high\npinned: true\n---\nLuôn dùng tiếng Việt trong comment.`,
  'utf8',
);
const sync = syncSkills(tmpRepo2);
assert.ok(sync.files.includes('AGENTS.md') && sync.files.includes('CLAUDE.md'), `sync files: ${sync.files}`);
const agents = readFileSync(path.join(tmpRepo2, 'AGENTS.md'), 'utf8');
const claudeMd = readFileSync(path.join(tmpRepo2, 'CLAUDE.md'), 'utf8');
assert.ok(agents.includes('kb-test-conv') && agents.includes('AUTO-GENERATED'), 'AGENTS.md chứa KB + header');
assert.ok(claudeMd.includes('Luôn dùng tiếng Việt'), 'CLAUDE.md chứa nội dung KB');
rmSync(tmpRepo2, { recursive: true, force: true });
console.log('✓ syncSkills: KB → AGENTS.md + CLAUDE.md (worker đọc được ngay khi checkout)');

console.log('LOGIC TEST PASS ✓ (8 nhóm — fleet/tasks/matrix/mergeable/promote/override/badge/skillsync)');

// 9. Chat orchestrator — parser + real turn
const { parseOrchestraActions, orchestratorTurn } = await import('../out/extension/src/logic.js');
const chatText = `Tôi sẽ dispatch cho codex.
\`\`\`orchestra
{"action":"dispatch","goal":"Thêm cổng VNPAY","scope":["src/payment/**"],"worker":"codex"}
\`\`\`
và một block JSON lỗi sẽ bị bỏ qua:
\`\`\`orchestra
{không phải json}
\`\`\``;
const acts = parseOrchestraActions(chatText);
assert.equal(acts.length, 1, `parser: ${JSON.stringify(acts)}`);
assert.equal(acts[0].action, 'dispatch');
assert.equal(acts[0].worker, 'codex');
console.log('✓ parseOrchestraActions: 1 action hợp lệ, block lỗi bỏ qua');

const chat = await orchestratorTurn(repo, 'Chào bạn — bạn là ai và bạn có làm gì được cho tôi? Trả lời 2 câu.');
assert.ok(chat.text && chat.text.length > 20, `chat turn: ${chat.text.slice(0, 100)}`);
assert.ok(chat.session, 'session id phải có để resume');
console.log(`✓ orchestratorTurn thật: session=${chat.session.slice(0, 8)}… text="${chat.text.slice(0, 80).replace(/\n/g, ' ')}…"`);
console.log('LOGIC TEST PASS ✓ (9 nhóm — thêm chat orchestrator)');
