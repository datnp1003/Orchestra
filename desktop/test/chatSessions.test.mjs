// Session chat — parse jsonl để resume; list/open/add theo repo (temp dir)
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseChatSession, SESSION_ID_RE, listChatSessions, sessionFile, addRepoDir } from '../out/desktop/src/main/chatSessions.js';
import { setLocale } from '../out/prototype/src/i18n/index.js';

const at = '2026-11-02T00:00:00.000Z';
const L = (role, content) => JSON.stringify({ at, role, content });
const long = 'Thêm cổng thanh toán X theo pattern Y cho service payment, kèm test và docs đầy đủ';
const text = [
  L('user', long),
  L('assistant', [{ type: 'thinking', thinking: 'hm', signature: 'sig' }, { type: 'text', text: 'Khảo sát repo' }, { type: 'tool_use', id: 't1', name: 'fleet_dispatch', input: {} }]),
  L('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
  L('assistant', [{ type: 'redacted_thinking', data: 'x' }, { type: 'text', text: 'Xong' }]),
  '{hỏng',
  L('user', 'lượt 2'),
  L('assistant', [{ type: 'thinking', thinking: 'x', signature: 's' }]), // chỉ thinking → rỗng → bỏ
  L('assistant', [{ type: 'tool_use', id: 't2', name: 'fleet_status', input: {} }]), // treo, không có tool_result
  '',
].join('\r\n');

const s = parseChatSession(text);
assert.ok(!JSON.stringify(s.history).includes('thinking'), 'thinking/redacted_thinking bị bỏ');
assert.equal(s.history.length, 4, 'tool_use treo + user chưa có phản hồi bị bỏ');
assert.equal(s.history.at(-1).role, 'assistant');
assert.deepEqual(s.messages, [
  { role: 'user', text: long },
  { role: 'orch', text: 'Khảo sát repo' },
  { role: 'step', text: '🔧 fleet_dispatch' },
  { role: 'orch', text: 'Xong' },
], 'lượt chỉ có tool_result bị bỏ');
assert.equal(s.title.length, 60);
assert.ok(long.startsWith(s.title.slice(0, -1)) && s.title.endsWith('…'), 'title từ user message đầu');
assert.equal(s.turns, 1);
setLocale('vi');
assert.deepEqual(parseChatSession(''), { history: [], messages: [], title: '(trống)', turns: 0 });
setLocale('en');
assert.equal(parseChatSession('').title, '(empty)', 'title rỗng theo locale');
console.log('✓ parseChatSession: thinking bỏ, tool_use treo bỏ, title, tool_result-only bỏ');

for (const bad of ['../x', 'a/b', 'a\\b', '']) assert.ok(!SESSION_ID_RE.test(bad), `id ${bad} bị chặn`);
assert.ok(SESSION_ID_RE.test('2026-11-02T08-00-00-000Z'));
console.log('✓ SESSION_ID_RE chặn path traversal');

// session theo repo: gộp nhiều repo, bỏ repo thiếu, mới nhất trước, top N
const tmp = mkdtempSync(path.join(os.tmpdir(), 'orch-sess-'));
const mk = (name, sessions) => {
  const repo = path.join(tmp, name);
  mkdirSync(path.join(repo, '.orchestra', 'chat'), { recursive: true });
  for (const [id, sec] of sessions) {
    const f = path.join(repo, '.orchestra', 'chat', `${id}.jsonl`);
    writeFileSync(f, [L('user', `hi ${id}`), L('assistant', 'ok')].join('\n'));
    utimesSync(f, sec, sec);
  }
  return repo;
};
const A = mk('alpha', [['a1', 1000], ['a2', 3000]]);
const B = mk('beta', [['b1', 2000]]);
const list = listChatSessions([A, path.join(tmp, 'missing'), B]);
assert.deepEqual(list.map((x) => [x.id, x.repoName]), [['a2', 'alpha'], ['b1', 'beta'], ['a1', 'alpha']]);
assert.equal(list[1].repo, B);
assert.equal(list[0].title, 'hi a2');
assert.equal(listChatSessions([A, B], 2).length, 2, 'top N');
console.log('✓ listChatSessions: gộp 2 repo, bỏ repo thiếu, newest first, top N');

assert.ok('error' in sessionFile([A], B, 'b1'), 'repo ngoài settings.repos bị chặn');
assert.ok('error' in sessionFile([A], 42, 'a1'));
for (const bad of ['../x', 'a/b', '', 7]) assert.ok('error' in sessionFile([A], A, bad), `id ${bad}`);
assert.equal(sessionFile([A], A, 'a1').file, path.join(A, '.orchestra', 'chat', 'a1.jsonl'));
console.log('✓ sessionFile: chặn repo lạ + id xấu');

const r1 = addRepoDir([], A);
assert.equal(r1.ok, false, 'không có .git → từ chối');
assert.match(r1.error, /git/);
mkdirSync(path.join(A, '.git'));
const r2 = addRepoDir(['C:/x'], A + path.sep);
assert.ok(r2.ok);
assert.equal(r2.repo, A.replace(/\\/g, '/'), 'chuẩn hoá /');
assert.deepEqual(r2.repos, ['C:/x', r2.repo]);
const r3 = addRepoDir(r2.repos, A);
assert.deepEqual([r3.repo, r3.repos], [r2.repo, r2.repos], 'dedupe');
assert.equal(addRepoDir([], '').ok, false);
rmSync(tmp, { recursive: true, force: true });
console.log('✓ addRepoDir: cần .git, chuẩn hoá /, dedupe');
console.log('CHAT SESSIONS TEST PASS ✓');
