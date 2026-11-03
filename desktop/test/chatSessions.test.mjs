// Session chat — parse jsonl để resume; list/open theo project, xoá project, memory:set (temp dir)
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseChatSession, SESSION_ID_RE, listChatSessions, chatSessionsView, sessionFile, findProject, newProjectId, deleteProjectData, addRepoDir } from '../out/desktop/src/main/chatSessions.js';
import { setLocale } from '../out/prototype/src/i18n/index.js';
import { setOrchestraHome, chatDir } from '../out/prototype/src/home.js';
import { setMemoryText, loadMemory } from '../out/prototype/src/agentMemory.js';

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

// session theo project: ~/.orchestra/projects/<id>/chat + ~/.orchestra/chats (home = temp dir)
const tmp = mkdtempSync(path.join(os.tmpdir(), 'orch-sess-'));
setOrchestraHome(path.join(tmp, 'home'));
const mk = (projectId, sessions) => {
  const dir = chatDir(projectId);
  mkdirSync(dir, { recursive: true });
  for (const [id, sec] of sessions) {
    const f = path.join(dir, `${id}.jsonl`);
    writeFileSync(f, [L('user', `hi ${id}`), L('assistant', 'ok')].join('\n'));
    utimesSync(f, sec, sec);
  }
};
const A = path.join(tmp, 'alpha');
const B = path.join(tmp, 'beta');
const projects = [{ id: 'pa-0001', name: 'PA', repos: [A, B] }, { id: 'pb-0002', name: 'PB', repos: [] }];
mk('pa-0001', [['a1', 1000], ['a2', 3000], ['a3', 2000]]);
mk(null, [['g1', 1500]]);
assert.deepEqual(listChatSessions(chatDir('pa-0001')).map((x) => x.id), ['a2', 'a3', 'a1'], 'newest first');
assert.equal(listChatSessions(chatDir('pa-0001'), 2).length, 2, 'top N');
assert.deepEqual(listChatSessions(path.join(tmp, 'missing')), []);
const view = chatSessionsView(projects, { projectId: 'pa-0001', id: 'a3' });
assert.deepEqual(view.projects.map((p) => [p.id, p.name, p.repos, p.sessions.map((x) => x.id)]), [['pa-0001', 'PA', [A, B], ['a2', 'a3', 'a1']], ['pb-0002', 'PB', [], []]]);
assert.deepEqual(view.projects[0].sessions.map((x) => x.active), [false, true, false]);
assert.deepEqual(view.chats.map((x) => [x.id, x.title, x.active]), [['g1', 'hi g1', false]], 'global chat tách riêng, không active nhầm');
assert.equal(chatSessionsView(projects, { projectId: null, id: 'g1' }).chats[0].active, true);
console.log('✓ chat:sessions: nhóm theo project + chats global, newest first, top N, active');

assert.ok('error' in sessionFile(projects, 'nope-0000', 'a1'), 'project không tồn tại bị chặn');
assert.ok('error' in sessionFile(projects, 42, 'a1'));
for (const bad of ['../x', 'a/b', '', 7]) assert.ok('error' in sessionFile(projects, 'pa-0001', bad), `id ${bad}`);
assert.equal(sessionFile(projects, 'pa-0001', 'a1').file, path.join(tmp, 'home', 'projects', 'pa-0001', 'chat', 'a1.jsonl'));
assert.equal(sessionFile(projects, null, 'g1').file, path.join(tmp, 'home', 'chats', 'g1.jsonl'));
assert.deepEqual(findProject(projects, undefined), { project: null });
console.log('✓ chat:open: chặn project lạ + id xấu; null = chat global');

assert.match(newProjectId('Payment Service!'), /^payment-service-[0-9a-f]{4}$/);
assert.match(newProjectId('   '), /^project-[0-9a-f]{4}$/);
console.log('✓ newProjectId: slug + 4 hex');

// project:delete: chỉ xoá ~/.orchestra/projects/<id>, KHÔNG đụng repo
mkdirSync(path.join(A, '.orchestra', 'chat'), { recursive: true });
writeFileSync(path.join(A, 'keep.txt'), 'x');
setMemoryText('pa-0001', '- fact');
deleteProjectData('pa-0001');
assert.ok(!existsSync(path.join(tmp, 'home', 'projects', 'pa-0001')), 'dữ liệu project bị xoá');
assert.ok(existsSync(path.join(A, 'keep.txt')) && existsSync(path.join(A, '.orchestra', 'chat')), 'repo còn nguyên');
assert.ok(existsSync(path.join(tmp, 'home', 'chats', 'g1.jsonl')), 'chat global còn nguyên');
assert.throws(() => deleteProjectData('../home'), /invalid project id/);
console.log('✓ deleteProjectData: chỉ xoá dữ liệu project, repo + chat global còn nguyên, chặn id xấu');

// memory:set: redact secret + quá budget → lỗi, không ghi
const ms = setMemoryText(null, '- api key is sk-ant-abcdefghijklmnopqrstuvwxyz0123\n- likes tea');
assert.ok(ms.ok && !ms.text.includes('sk-ant-abc') && ms.text.includes('likes tea'), 'secret bị che');
assert.equal(loadMemory(null).trim(), ms.text.trim());
const over = setMemoryText(null, '- ' + 'x'.repeat(3100));
assert.equal(over.ok, false);
assert.match(over.error, /3000/);
assert.equal(loadMemory(null).trim(), ms.text.trim(), 'quá budget → không ghi');
console.log('✓ memory:set: redact + budget');

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
