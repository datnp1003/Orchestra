// Long-term memory: ops, redact, budget, reflection (callModel giả) — temp home, không mạng
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setOrchestraHome, memoryFile, projectDir } from '../dist/home.js';
import {
  applyMemoryOps, redactSecrets, renderMemoryBlock, reflectMemory, consolidateMemory, writeMemoryOps,
  setMemoryText, loadMemory, parseOps, transcriptOf, summarizeOps, fitNewest, BUDGET,
} from '../dist/agentMemory.js';

const home = (t) => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'orch-mem-'));
  setOrchestraHome(d);
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

test('applyMemoryOps: add / dedupe / replace / remove; mơ hồ hoặc không khớp → lỗi', () => {
  let r = applyMemoryOps('- uses pnpm\n- api in Go', [{ action: 'add', text: 'uses pnpm' }]);
  assert.deepEqual([r.ok, r.changed], [true, false], 'add trùng = no-op');
  r = applyMemoryOps(r.text, [{ action: 'add', text: '  deploys   on fly ' }]);
  assert.equal(r.text, '- uses pnpm\n- api in Go\n- deploys on fly');
  r = applyMemoryOps(r.text, [{ action: 'replace', old_text: 'pnpm', text: 'uses bun' }, { action: 'remove', old_text: 'fly' }]);
  assert.equal(r.text, '- uses bun\n- api in Go');
  const amb = applyMemoryOps('- api in Go\n- api gateway', [{ action: 'remove', old_text: 'api' }]);
  assert.equal(amb.ok, false);
  assert.match(amb.error, /2 entries/);
  assert.equal(applyMemoryOps('- a', [{ action: 'replace', old_text: 'zzz', text: 'b' }]).ok, false);
  assert.equal(applyMemoryOps('- a', [{ action: 'add', text: '' }]).ok, false);
  assert.equal(applyMemoryOps('- a', [{ action: 'nuke' }]).ok, false);
});

test('redactSecrets', () => {
  const s = [
    'sk-ant-api03-AAAAbbbbCCCCdddd1234', 'sk-proj-abcdefgh12345678', 'Authorization: Bearer eyJhbGciOi.xyz',
    'API_KEY=hunter2', 'token = abc123', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8', 'Zm9vYmFyQmF6UXV4MTIzNDU2Nzg5MEFCQ0RFRg==',
  ].join(' | ');
  const out = redactSecrets(s);
  for (const leak of ['AAAAbbbb', 'abcdefgh1234', 'eyJhbGciOi', 'hunter2', 'abc123', 'a1b2c3d4e5f6', 'Zm9vYmFy']) assert.ok(!out.includes(leak), `lọt ${leak}: ${out}`);
  assert.equal(redactSecrets('uses some-really-long-kebab-case-service-name-here'), 'uses some-really-long-kebab-case-service-name-here', 'tên dài không bị che');
});

test('setMemoryText: redact, normalize, quá budget → lỗi không ghi; ghi atomic (không còn .tmp)', (t) => {
  home(t);
  const r = setMemoryText('p-1', 'likes tea\n\n- key=sk-abcdefghijk\n');
  assert.ok(r.ok);
  assert.equal(r.text, '- likes tea\n- key=[REDACTED]');
  assert.equal(loadMemory('p-1'), r.text + '\n');
  const over = setMemoryText('p-1', '- ' + 'x'.repeat(BUDGET.project));
  assert.equal(over.ok, false);
  assert.equal(loadMemory('p-1'), r.text + '\n', 'không ghi');
  assert.deepEqual(readdirSync(path.dirname(memoryFile('p-1'))).filter((f) => f.endsWith('.tmp')), []);
  assert.throws(() => projectDir('../x'), /invalid project id/);
});

test('renderMemoryBlock: global riêng; project kèm tên; cắt theo budget giữ entry mới', () => {
  assert.equal(renderMemoryBlock('- g'), 'USER/GLOBAL MEMORY:\n- g');
  assert.equal(renderMemoryBlock('', { name: 'Shop', text: '- p' }), 'USER/GLOBAL MEMORY:\n(empty)\n\nPROJECT MEMORY (Shop):\n- p');
  const big = Array.from({ length: 400 }, (_, i) => `- entry number ${i}`).join('\n');
  const block = renderMemoryBlock(big);
  assert.ok(block.length <= 'USER/GLOBAL MEMORY:\n'.length + BUDGET.global);
  assert.ok(block.endsWith('entry number 399') && !block.includes('entry number 0\n'));
  assert.equal(fitNewest('- aaaa\n- bb', 4), '- bb');
});

test('parseOps / reflectMemory: JSON hỏng → []; op rác bị lọc; project op bị bỏ ngoài project', async () => {
  assert.deepEqual(parseOps('nope'), []);
  assert.deepEqual(parseOps('{"ops":"x"}'), []);
  const raw = 'sure:\n{"ops":[{"scope":"global","action":"add","text":"likes tea"},{"scope":"project","action":"add","text":"api in Go"},{"scope":"x","action":"add","text":"y"},{"scope":"global","action":"add","text":5}]}';
  assert.equal(parseOps(raw).length, 2);
  const seen = [];
  const callModel = async (system, user) => (seen.push({ system, user }), raw);
  const g = await reflectMemory({ callModel, global: '- old', transcript: 'USER: hi' });
  assert.deepEqual(g.map((o) => o.scope), ['global']);
  assert.match(seen[0].system, /NOT in a project/);
  assert.ok(!seen[0].user.includes('PROJECT MEMORY'));
  const p = await reflectMemory({ callModel, global: '', project: { name: 'Shop', text: '- p' }, transcript: 'USER: hi' });
  assert.deepEqual(p.map((o) => o.scope), ['global', 'project']);
  assert.match(seen[1].user, /PROJECT MEMORY \(Shop\)/);
});

test('writeMemoryOps: project ngoài project → lỗi; vượt budget → consolidate (model), lỗi model → giữ mới nhất', async (t) => {
  home(t);
  const r = await writeMemoryOps(null, [{ scope: 'project', action: 'add', text: 'x' }, { scope: 'global', action: 'add', text: 'g' }]);
  assert.equal(r.errors.length, 1);
  assert.deepEqual(r.applied.map((o) => o.scope), ['global']);
  assert.ok(!existsSync(path.join(path.dirname(memoryFile(null)), 'projects')), 'không tạo project memory');

  // 111 entry × 27 ký tự − 1 = 2996 ≤ budget; thêm 1 entry → vượt
  const seed = Array.from({ length: 111 }, (_, i) => `- fact ${String(i).padStart(3, '0')} padding padding`).join('\n');
  assert.ok(setMemoryText(null, seed).ok);
  const compact = await writeMemoryOps(null, [{ scope: 'global', action: 'add', text: 'newest fact' }], async () => '- merged summary\n- newest fact');
  assert.equal(compact.applied.length, 1);
  assert.equal(loadMemory(null), '- merged summary\n- newest fact\n');

  assert.ok(setMemoryText(null, seed).ok);
  await writeMemoryOps(null, [{ scope: 'global', action: 'add', text: 'newest fact' }], async () => { throw new Error('down'); });
  const kept = loadMemory(null);
  assert.ok(kept.length <= BUDGET.global + 1 && kept.trimEnd().endsWith('- newest fact') && !kept.includes('fact 000'));
  assert.equal(await consolidateMemory({ callModel: async () => 'garbage', text: '- a', budget: 10 }), '- a');
});

test('transcriptOf: chỉ text user/assistant, giữ đuôi; summarizeOps redact', () => {
  const msgs = [
    { role: 'user', content: 'add stripe' },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: '1', name: 'fleet_dispatch', input: { goal: 'SECRET_INPUT' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: 'TOOL_OUTPUT' }] },
  ];
  const s = transcriptOf(msgs);
  assert.equal(s, 'USER: add stripe\n\nASSISTANT: ok');
  assert.equal(transcriptOf([{ role: 'user', content: 'x'.repeat(100) }], 10), '…' + 'x'.repeat(10));
  assert.equal(summarizeOps([{ scope: 'global', action: 'add', text: 'token=abc' }]), '+global: token=[REDACTED]');
});
