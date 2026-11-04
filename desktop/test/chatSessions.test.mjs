// Chat session — parse jsonl to resume; list/open by project, delete project, memory:set (temp dir)
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseChatSession, SESSION_ID_RE, listChatSessions, chatSessionsView, sessionFile, findProject, newProjectId, deleteProjectData, addRepoDir, saveSessionImages, sessionImageFiles, saveSessionFiles, readSessionFile, sessionFileDirs, hasSessionFiles } from '../out/desktop/src/main/chatSessions.js';
import { attachmentBlocks } from '../out/prototype/src/attachments.js';
import { deflateRawSync, crc32 } from 'node:zlib';
import { setLocale, t } from '../out/prototype/src/i18n/index.js';
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
  L('assistant', [{ type: 'thinking', thinking: 'x', signature: 's' }]), // thinking only → empty → dropped
  L('assistant', [{ type: 'tool_use', id: 't2', name: 'fleet_status', input: {} }]), // dangling, no tool_result
  '',
].join('\r\n');

const s = parseChatSession(text);
assert.ok(!JSON.stringify(s.history).includes('thinking'), 'thinking/redacted_thinking dropped');
assert.equal(s.history.length, 4, 'dangling tool_use + unanswered user dropped');
assert.equal(s.history.at(-1).role, 'assistant');
assert.deepEqual(s.messages, [
  { role: 'user', text: long },
  { role: 'orch', text: 'Khảo sát repo' },
  { role: 'step', text: '🔧 fleet_dispatch' },
  { role: 'orch', text: 'Xong' },
], 'tool_result-only turn dropped');
assert.equal(s.title.length, 60);
assert.ok(long.startsWith(s.title.slice(0, -1)) && s.title.endsWith('…'), 'title from first user message');
assert.equal(s.turns, 1);
// conversation-mode reminder: kept in history (brain sees which turns were talk/plan/goal), hidden from the visible text + title
{
  const rem = '<system-reminder>\nConversation mode: plan. The user wants a plan.\n</system-reminder>';
  const p = parseChatSession([L('user', [{ type: 'text', text: rem }, { type: 'text', text: 'lên plan thêm X' }]), L('assistant', [{ type: 'text', text: 'Kế hoạch…' }])].join('\n'));
  assert.equal(p.history[0].content[0].text, rem, 'reminder kept in history');
  assert.deepEqual(p.messages[0], { role: 'user', text: 'lên plan thêm X' }, 'reminder hidden from display');
  assert.equal(p.title, 'lên plan thêm X');
}
// images in a user message: reopened view gets data: URLs, image-only first message still titles the session
{
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };
  const p = parseChatSession([L('user', [img, { type: 'text', text: 'cái gì đây' }]), L('assistant', 'ảnh logo'), L('user', [img]), L('assistant', 'ok')].join('\n'));
  assert.deepEqual(p.messages[0], { role: 'user', text: 'cái gì đây', images: ['data:image/png;base64,iVBORw0KGgo='] });
  assert.deepEqual(p.messages[2], { role: 'user', text: '', images: ['data:image/png;base64,iVBORw0KGgo='] }, 'image-only message kept');
  assert.equal(p.turns, 2);
  assert.equal(parseChatSession([L('user', [img]), L('assistant', 'ok')].join('\n')).title, '🖼 ×1');
}
setLocale('vi');
assert.deepEqual(parseChatSession(''), { history: [], messages: [], title: '(trống)', turns: 0 });
setLocale('en');
assert.equal(parseChatSession('').title, '(empty)', 'empty title follows locale');
console.log('✓ parseChatSession: thinking dropped, dangling tool_use dropped, title, tool_result-only dropped');

// legacy records with reasoning leaked into text: placeholder shown, never replayed; user text + tool pairing kept (synthetic sentinel)
const SENT = 'PRIVATE_SENTINEL';
const leak = parseChatSession([
  L('user', 'chào'),
  L('assistant', [{ type: 'reasoning', text: SENT }, { type: 'text', text: `antml:thinking_mode\n${SENT}` }, { type: 'tool_use', id: 't1', name: 'fleet_status', input: {} }]),
  L('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'tool out' }]),
  L('assistant', `antml:thinking_mode\n${SENT}Xin chào`),
  L('user', 'lượt 2'),
  L('assistant', [{ type: 'text', text: `<think>${SENT}</think>Đây` }]),
].join('\n'));
const placeholder = t('brain.reasoningLeak');
assert.ok(!JSON.stringify(leak).includes(SENT) && !JSON.stringify(leak).includes('antml:'), 'no marker/sentinel in history or view');
assert.deepEqual(leak.messages, [
  { role: 'user', text: 'chào' },
  { role: 'orch', text: placeholder },
  { role: 'step', text: '🔧 fleet_status' },
  { role: 'orch', text: placeholder },
  { role: 'user', text: 'lượt 2' },
  { role: 'orch', text: 'Đây' },
]);
assert.deepEqual(leak.history[1].content.map((b) => b.type), ['text', 'tool_use'], 'tool_use kept');
assert.deepEqual(leak.history[2].content, [{ type: 'tool_result', tool_use_id: 't1', content: 'tool out' }], 'tool_result kept');
console.log('✓ parseChatSession: leaked reasoning in legacy records → placeholder, tool pairing kept');

for (const bad of ['../x', 'a/b', 'a\\b', '']) assert.ok(!SESSION_ID_RE.test(bad), `id ${bad} blocked`);
assert.ok(SESSION_ID_RE.test('2026-11-02T08-00-00-000Z'));
console.log('✓ SESSION_ID_RE blocks path traversal');

// sessions by project: ~/.orchestra/projects/<id>/chat + ~/.orchestra/chats (home = temp dir)
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
assert.deepEqual(view.chats.map((x) => [x.id, x.title, x.active]), [['g1', 'hi g1', false]], 'global chats kept separate, not wrongly active');
assert.equal(chatSessionsView(projects, { projectId: null, id: 'g1' }).chats[0].active, true);
// empty session file (chat created, nothing sent): listed only while it is the open one, titled "New chat"
writeFileSync(path.join(chatDir(null), 'g0.jsonl'), '');
assert.deepEqual(chatSessionsView(projects, { projectId: null, id: 'g1' }).chats.map((x) => x.id), ['g1'], 'abandoned empty chat hidden');
const open = chatSessionsView(projects, { projectId: null, id: 'g0' }).chats.find((x) => x.id === 'g0');
assert.deepEqual([open.active, open.turns, open.title], [true, 0, t('desktop.sessions.new')], 'open empty chat listed right away');
assert.deepEqual(chatSessionsView(projects, { projectId: 'pa-0001', id: 'g0' }).chats.map((x) => x.id), ['g1'], 'same id in another scope does not keep it');
rmSync(path.join(chatDir(null), 'g0.jsonl'));
console.log('✓ chat:sessions: grouped by project + global chats, newest first, top N, active; empty only while open');

// attached images as files: ids continue per session, resolve only within the same session, no traversal
{
  const png = { media_type: 'image/png', data: Buffer.from('PNG1').toString('base64') };
  const jpg = { media_type: 'image/jpeg', data: Buffer.from('JPG2').toString('base64') };
  assert.deepEqual(saveSessionImages(null, 's1', [png, jpg]), ['img-1', 'img-2']);
  assert.deepEqual(saveSessionImages(null, 's1', [png]), ['img-3'], 'numbering continues');
  assert.deepEqual(saveSessionImages(null, 's1', []), []);
  const r = sessionImageFiles(null, 's1', ['img-2', 'img-1', 'img-2']);
  assert.deepEqual(r.paths.map((p) => path.basename(p)), ['img-2.jpg', 'img-1.png'], 'dedup, keeps order');
  assert.equal(readFileSync(r.paths[0], 'utf8'), 'JPG2');
  for (const bad of [['img-9'], ['../s1.jsonl'], ['img-1/../../x']]) assert.ok('error' in sessionImageFiles(null, 's1', bad), `rejects ${bad}`);
  assert.ok('error' in sessionImageFiles('pa-0001', 's1', ['img-1']), 'other scope cannot read this session images');
  assert.ok('error' in sessionImageFiles(null, 's2', ['img-1']), 'other session cannot read them');
  rmSync(path.join(chatDir(null), 's1.images'), { recursive: true });
}
console.log('✓ session images: saved as img-N files, resolved per session only');

// attached files: stored per session as file-N/, Office text next to the original, zip unpacked safely, read + paged
{
  const zip = (files) => {
    const L = [], C = [];
    let off = 0;
    for (const [name, content] of Object.entries(files)) {
      const d = Buffer.from(content), c = deflateRawSync(d), n = Buffer.from(name), h = Buffer.alloc(30), e = Buffer.alloc(46);
      h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(8, 8); h.writeUInt32LE(crc32(d), 14); h.writeUInt32LE(c.length, 18); h.writeUInt32LE(d.length, 22); h.writeUInt16LE(n.length, 26);
      e.writeUInt32LE(0x02014b50, 0); e.writeUInt16LE(8, 10); e.writeUInt32LE(crc32(d), 16); e.writeUInt32LE(c.length, 20); e.writeUInt32LE(d.length, 24); e.writeUInt16LE(n.length, 28); e.writeUInt32LE(off, 42);
      L.push(h, n, c); C.push(e, n); off += 30 + n.length + c.length;
    }
    const cd = Buffer.concat(C), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(C.length / 2, 8); end.writeUInt16LE(C.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
    return Buffer.concat([...L, cd, end]);
  };
  const docx = zip({ 'word/document.xml': '<w:p><w:r><w:t>Yêu cầu: API trả 200</w:t></w:r></w:p>' });
  const src = zip({ 'app/main.ts': 'console.log(1)', '../evil.txt': 'x', 'C:/abs.txt': 'x', 'app/CON': 'x', 'notes.md': 'y'.repeat(30000) });
  assert.equal(hasSessionFiles(null, 'f1'), false);
  const big = Buffer.alloc(11 * 1024 * 1024, 1);
  const infos = saveSessionFiles(null, 'f1', [
    { name: 'spec.docx', buf: docx }, { name: 'src.zip', buf: src }, { name: 'a.pdf', buf: Buffer.from('%PDF-1') }, { name: 'big.pdf', buf: big },
    { name: 'bad.xlsx', buf: Buffer.from('not a zip') }, { name: 'log.txt', buf: Buffer.from('dòng 1') },
  ]);
  assert.deepEqual(infos.map((i) => [i.id, i.kind]), [['file-1', 'docx'], ['file-2', 'zip'], ['file-3', 'pdf'], ['file-4', 'pdf'], ['file-5', 'xlsx'], ['file-6', 'text']]);
  assert.equal(infos[0].text, 'Yêu cầu: API trả 200');
  assert.deepEqual(infos[1].tree.map((e) => e.path), ['app/main.ts', 'notes.md']);
  assert.equal(infos[1].skipped, 3, 'traversal / absolute / reserved names skipped');
  assert.ok(!existsSync(path.join(chatDir(null), 'f1.files', 'evil.txt')) && !existsSync(path.join(chatDir(null), 'evil.txt')), 'nothing written outside');
  assert.equal(infos[2].pdfBase64, Buffer.from('%PDF-1').toString('base64'));
  assert.equal(infos[3].pdfBase64, undefined, 'PDF over the inline cap → workers only');
  assert.match(infos[4].error, /not a zip/);
  assert.equal(saveSessionFiles(null, 'f1', [{ name: 'c.pdf', buf: Buffer.from('%PDF') }], 2)[0].pdfBase64, undefined, 'conversation PDF budget used up');
  assert.equal(hasSessionFiles(null, 'f1'), true);
  const dir = path.join(chatDir(null), 'f1.files');
  assert.equal(readFileSync(path.join(dir, 'file-1', 'spec.docx.txt'), 'utf8'), 'Yêu cầu: API trả 200', 'extracted text kept for workers');
  assert.equal(readFileSync(path.join(dir, 'file-2', 'src', 'app', 'main.ts'), 'utf8'), 'console.log(1)');
  // attachment_read
  assert.deepEqual(readSessionFile(null, 'f1', 'file-1', undefined, 0), { ok: true, content: 'Yêu cầu: API trả 200' });
  assert.equal(readSessionFile(null, 'f1', 'file-6', undefined, 0).content, 'dòng 1');
  assert.match(readSessionFile(null, 'f1', 'file-2', undefined, 0).content, /pass path= one of\napp\/main\.ts\nnotes\.md/);
  assert.equal(readSessionFile(null, 'f1', 'file-2', 'app/main.ts', 0).content, 'console.log(1)');
  assert.match(readSessionFile(null, 'f1', 'file-2', 'notes.md', 0).content, /…\(18000 of 30000 chars — offset=18000 for more\)$/);
  assert.equal(readSessionFile(null, 'f1', 'file-2', 'notes.md', 18000).content.length, 12000);
  for (const [id, inner] of [['file-2', '../file-1/spec.docx'], ['file-2', 'C:/Windows/win.ini'], ['file-2', 'nope.ts'], ['file-1', 'x'], ['file-99', undefined], ['../f1', undefined]])
    assert.equal(readSessionFile(null, 'f1', id, inner, 0).ok, false, `${id} ${inner}`);
  assert.match(readSessionFile(null, 'f1', 'file-3', undefined, 0).content, /pdf file — not readable as text here/);
  assert.equal(readSessionFile(null, 'f2', 'file-1', undefined, 0).ok, false, 'other session cannot read it');
  assert.deepEqual(sessionFileDirs(null, 'f1', ['file-2', 'file-1', 'file-2']).paths.map((p) => path.basename(p)), ['file-2', 'file-1']);
  assert.ok('error' in sessionFileDirs(null, 'f1', ['file-42']));
  assert.ok('error' in sessionFileDirs('pa-0001', 'f1', ['file-1']));
  // reopened session: chips from the attachment tags, tags hidden from the text, file-only message titled by names
  const blocks = attachmentBlocks(infos[0]);
  const p = parseChatSession([L('user', [...blocks, { type: 'text', text: 'làm theo spec' }]), L('assistant', 'ok'), L('user', attachmentBlocks(infos[5])), L('assistant', 'ok')].join('\n'));
  assert.deepEqual(p.messages[0], { role: 'user', text: 'làm theo spec', files: ['spec.docx'] });
  assert.deepEqual(p.messages[2], { role: 'user', text: '', files: ['log.txt'] });
  assert.equal(parseChatSession([L('user', attachmentBlocks(infos[5])), L('assistant', 'ok')].join('\n')).title, '📎 log.txt');
  rmSync(dir, { recursive: true });
}
console.log('✓ session files: stored as file-N, Office text + safe unzip, attachment_read paged + scoped, chips on reopen');

assert.ok('error' in sessionFile(projects, 'nope-0000', 'a1'), 'nonexistent project blocked');
assert.ok('error' in sessionFile(projects, 42, 'a1'));
for (const bad of ['../x', 'a/b', '', 7]) assert.ok('error' in sessionFile(projects, 'pa-0001', bad), `id ${bad}`);
assert.equal(sessionFile(projects, 'pa-0001', 'a1').file, path.join(tmp, 'home', 'projects', 'pa-0001', 'chat', 'a1.jsonl'));
assert.equal(sessionFile(projects, null, 'g1').file, path.join(tmp, 'home', 'chats', 'g1.jsonl'));
assert.deepEqual(findProject(projects, undefined), { project: null });
console.log('✓ chat:open: blocks unknown project + bad id; null = global chat');

assert.match(newProjectId('Payment Service!'), /^payment-service-[0-9a-f]{4}$/);
assert.match(newProjectId('   '), /^project-[0-9a-f]{4}$/);
console.log('✓ newProjectId: slug + 4 hex');

// project:delete: only deletes ~/.orchestra/projects/<id>, NEVER touches the repo
mkdirSync(path.join(A, '.orchestra', 'chat'), { recursive: true });
writeFileSync(path.join(A, 'keep.txt'), 'x');
setMemoryText('pa-0001', '- fact');
deleteProjectData('pa-0001');
assert.ok(!existsSync(path.join(tmp, 'home', 'projects', 'pa-0001')), 'project data deleted');
assert.ok(existsSync(path.join(A, 'keep.txt')) && existsSync(path.join(A, '.orchestra', 'chat')), 'repo intact');
assert.ok(existsSync(path.join(tmp, 'home', 'chats', 'g1.jsonl')), 'global chat intact');
assert.throws(() => deleteProjectData('../home'), /invalid project id/);
console.log('✓ deleteProjectData: only deletes project data, repo + global chat intact, blocks bad id');

// memory:set: redact secret + over budget → error, not written
const ms = setMemoryText(null, '- api key is sk-ant-abcdefghijklmnopqrstuvwxyz0123\n- likes tea');
assert.ok(ms.ok && !ms.text.includes('sk-ant-abc') && ms.text.includes('likes tea'), 'secret masked');
assert.equal(loadMemory(null).trim(), ms.text.trim());
const over = setMemoryText(null, '- ' + 'x'.repeat(3100));
assert.equal(over.ok, false);
assert.match(over.error, /3000/);
assert.equal(loadMemory(null).trim(), ms.text.trim(), 'over budget → not written');
console.log('✓ memory:set: redact + budget');

const r1 = addRepoDir([], A);
assert.equal(r1.ok, false, 'no .git → rejected');
assert.match(r1.error, /git/);
mkdirSync(path.join(A, '.git'));
const r2 = addRepoDir(['C:/x'], A + path.sep);
assert.ok(r2.ok);
assert.equal(r2.repo, A.replace(/\\/g, '/'), 'normalized to /');
assert.deepEqual(r2.repos, ['C:/x', r2.repo]);
const r3 = addRepoDir(r2.repos, A);
assert.deepEqual([r3.repo, r3.repos], [r2.repo, r2.repos], 'dedupe');
assert.equal(addRepoDir([], '').ok, false);
rmSync(tmp, { recursive: true, force: true });
console.log('✓ addRepoDir: requires .git, normalizes /, dedupe');
console.log('CHAT SESSIONS TEST PASS ✓');
