// Pure extension logic test — plain node, no VS Code host
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fleetSnapshot, tasksSnapshot, policyMatrixHtml, mergeableTasks, promoteWorker, restoreDefaultPolicy, trackOverride, conformanceBadge } from '../out/extension/src/logic.js';

// 0. default policy resolvable from extension/out + modelsList (router R2a)
const { loadPolicy } = await import('../out/prototype/src/policy.js');
const { t } = await import('../out/prototype/src/i18n/index.js');
assert.equal(loadPolicy().source, 'proto-default', 'loadPolicy from out/');
const { modelsList } = await import('../out/extension/src/logic.js');
const ml = modelsList(['gw/opus', 'oa/gpt'], [
  { id: 'gw', kind: 'anthropic', baseUrl: 'x', formats: ['messages'], enabled: true },
  { id: 'oa', kind: 'openai', baseUrl: 'x', formats: ['responses', 'chat'], enabled: true },
]);
const pick = (w, id) => ml.byWorker[w].find((m) => m.id === id);
assert.deepEqual(ml.models, ['gw/opus', 'oa/gpt']);
assert.ok(pick('claude', 'gw/opus').ok && pick('codex', 'oa/gpt').ok, 'claude+messages, codex+responses');
assert.match(pick('codex', 'gw/opus').reason, /Responses/, 'codex + messages translated via router');
assert.equal(pick('antigravity', 'gw/opus').ok, false, 'antigravity does not support the router yet');
console.log('✓ proto-default from out/ + modelsList byWorker');

// 1. Fleet snapshot — real CLIs on this machine
const fleet = fleetSnapshot();
assert.ok(Array.isArray(fleet) && fleet.length >= 2, `fleet: ${JSON.stringify(fleet)}`);
const claude = fleet.find((f) => f.id === 'claude');
assert.ok(claude?.installed && claude.version, `claude: ${JSON.stringify(claude)}`);
const codex = fleet.find((f) => f.id === 'codex');
assert.ok(codex?.installed && codex.version, `codex: ${JSON.stringify(codex)}`);
console.log(`✓ fleet: ${fleet.map((f) => `${f.id}@${f.version}`).join(', ')}`);

// 2. Tasks snapshot — demo repo has records from P2–P4
const tasks = tasksSnapshot();
assert.ok(tasks.length >= 3, `tasks: ${tasks.length}`);
assert.ok(tasks.every((t) => t.id && t.node), 'task record shape');
console.log(`✓ tasks: ${tasks.length} records, newest ${tasks[0]?.id} (${tasks[0]?.node}/${tasks[0]?.worker})`);

// 3. Policy matrix HTML — role×worker table + KB + no validation errors
const html = policyMatrixHtml();
assert.ok(html.includes('<table'), 'matrix has a table');
assert.ok(html.includes('coder') && html.includes('planner'), 'matrix có roles');
assert.ok(html.includes('kb-payment-module'), 'matrix có KB entry');
assert.ok(html.includes(t('ext.mx.valid')), 'policy validate pass');
console.log(`✓ matrix html: ${html.length} chars, has roles + KB + valid policy`);

// 4. Mergeable tasks — branches not yet in main (P5.2 Review & Merge)
const mergeable = mergeableTasks();
assert.ok(Array.isArray(mergeable), 'mergeable array');
for (const t of mergeable) {
  assert.ok(t.branch && t.branch.startsWith('orchestra/task-'), `branch shape: ${JSON.stringify(t)}`);
  assert.ok(t.files.length >= 0, 'files shape');
}
console.log(`✓ mergeable: ${mergeable.length} task(s) awaiting merge (${mergeable.map((t) => t.id).slice(0, 3).join(', ') || '—'})`);

// 5. promoteWorker — clicking a cell must write the project policy.yml and reload as source=project
const repo = 'C:/Users/Nitro V 15/Desktop/Source/Orchestra/prototype/demo-repo';
restoreDefaultPolicy(repo); // make sure we start from proto-default
const promo = promoteWorker(repo, 'coder', 'claude');
assert.ok(promo.ok, `promote: ${promo.detail}`);
const htmlAfter = policyMatrixHtml(repo);
assert.ok(htmlAfter.includes('policy source: <b>project</b>'), 'policy source must be project after promote');
assert.ok(existsSync(path.join(repo, '.orchestra', 'policy.yml')), 'project policy.yml written');
// written yaml must list claude before codex for coder
const yamlText = readFileSync(path.join(repo, '.orchestra', 'policy.yml'), 'utf8');
const coderSection = yamlText.split('bindings:')[1]?.split('coder:')[1]?.split(/\n  \w/)?.[0] ?? '';
assert.ok(coderSection.indexOf('claude') < coderSection.indexOf('codex'), `bindings.coder must have claude before codex: ${coderSection}`);
restoreDefaultPolicy(repo); // cleanup — restore proto-default
console.log('✓ promoteWorker: cell click → project policy.yml written in order + source=project (cleaned up)');

// 6. trackOverride — user picks differently from auto-pick → task_reassigned feedback
const tmpRepo = mkdtempSync(path.join(os.tmpdir(), 'orch-ovr-'));
mkdirSync(path.join(tmpRepo, '.orchestra'), { recursive: true });
const t1 = trackOverride(tmpRepo, { autoPick: 'codex', pin: 'claude', taskId: 't-x', ok: true });
assert.ok(t1.tracked, `track: ${t1.detail}`);
const t2 = trackOverride(tmpRepo, { autoPick: 'claude', pin: 'claude', taskId: 't-y', ok: true });
assert.ok(!t2.tracked, 'not an override — not recorded');
const t3 = trackOverride(tmpRepo, { autoPick: 'codex', pin: 'claude', taskId: 't-z', ok: false });
assert.ok(!t3.tracked, 'dispatch failed — not recorded');
const fb = readFileSync(path.join(tmpRepo, '.orchestra', 'feedback.jsonl'), 'utf8').trim().split('\n');
assert.equal(fb.length, 1, 'exactly 1 feedback event');
assert.ok(fb[0].includes('"type":"task_reassigned"') && fb[0].includes('"worker":"claude"'), `feedback shape: ${fb[0]}`);
rmSync(tmpRepo, { recursive: true, force: true });
console.log('✓ trackOverride: exactly 1 event on override, 0 on match/fail (temp repo removed)');

// 7. conformance badge — demo repo has a pass badge from P5.2
const badge = conformanceBadge(repo, 'claude', '2.1.310');
assert.equal(badge, 'pass', `badge: ${badge}`);
console.log(`✓ conformanceBadge: claude@2.1.310 = ${badge}`);

// 8. (skill-sync AGENTS.md/CLAUDE.md removed — real skills: prototype/test/skills.test.mjs)

console.log('LOGIC TEST PASS ✓ (7 nhóm — fleet/tasks/matrix/mergeable/promote/override/badge)');

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
console.log('✓ parseOrchestraActions: 1 valid action, broken block skipped');

const chat = await orchestratorTurn(repo, 'Chào bạn — bạn là ai và bạn có làm gì được cho tôi? Trả lời 2 câu.');
assert.ok(chat.text && chat.text.length > 20, `chat turn: ${chat.text.slice(0, 100)}`);
assert.ok(chat.session, 'session id required for resume');
console.log(`✓ orchestratorTurn real: session=${chat.session.slice(0, 8)}… text="${chat.text.slice(0, 80).replace(/\n/g, ' ')}…"`);
console.log('LOGIC TEST PASS ✓ (9 groups — incl. orchestrator chat)');
