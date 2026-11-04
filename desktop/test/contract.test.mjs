// Unit test contract + settings store — plain node, no Electron
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IPC, EVENTS, PAGES, DEFAULT_SETTINGS, validateSettings, requireRepo, validateImages, MAX_IMAGES, MAX_IMAGE_BYTES, validateFiles, MAX_FILES, MAX_FILE_BYTES, MAX_ZIP_BYTES } from '../out/desktop/src/main/contract.js';
import { loadSettings, saveSettings, initLanguage } from '../out/desktop/src/main/settingsStore.js';
import { setLocale } from '../out/prototype/src/i18n/index.js';
import { setOrchestraHome, PROJECT_ID_RE } from '../out/prototype/src/home.js';
import { copyLegacySessions } from '../out/desktop/src/main/chatSessions.js';

// 1. channels unique + complete
const chans = Object.values(IPC);
assert.equal(new Set(chans).size, chans.length, 'duplicate IPC channels');
assert.ok(chans.length >= 18, `too few channels: ${chans.length}`);
assert.ok(Object.values(EVENTS).every((e) => !chans.includes(e)), 'EVENTS must not collide with IPC channels');
console.log(`✓ contract: ${chans.length} channels unique + ${Object.keys(EVENTS).length} events`);

// 2. validateSettings — merge defaults, reject junk
// old settings with orchestratorWorker/orchestratorModel → dropped, no error
const v1 = validateSettings({ repos: ['', 'C:/x', 42], orchestratorWorker: 'codex', orchestratorModel: 'x' });
assert.deepEqual(v1.repos, ['C:/x'], 'empty/non-string repos must be filtered');
assert.equal(v1.hooksEnabled, true, 'hooksEnabled defaults to true');
assert.ok(!('orchestratorWorker' in v1) && !('orchestratorModel' in v1), 'old CLI brain fields dropped');
const v2 = validateSettings(null);
assert.deepEqual(v2, DEFAULT_SETTINGS, 'null → defaults');
assert.equal(DEFAULT_SETTINGS.brainModel, '', 'brainModel defaults to empty (must choose)');
assert.equal(DEFAULT_SETTINGS.routerDefaultModel, '', 'routerDefaultModel defaults to empty');
assert.equal(v1.brainModel, '', 'missing brainModel → empty');
assert.equal(validateSettings({ brainModel: ' cc/claude-sonnet-5-5 ' }).brainModel, 'cc/claude-sonnet-5-5', 'keeps model (trimmed)');
for (const junk of [42, '', '  ', null, 'worker-claude']) assert.equal(validateSettings({ brainModel: junk }).brainModel, '', `brainModel ${JSON.stringify(junk)} → empty`);
assert.equal(validateSettings({ routerDefaultModel: ' gw/m ' }).routerDefaultModel, 'gw/m');
assert.equal(validateSettings({ routerDefaultModel: 7 }).routerDefaultModel, '');
// old settings (CLI brain + old-style brainModel) still load, no error
const old = validateSettings({ repos: ['C:/a'], activeRepo: 'C:/a', orchestratorWorker: 'claude', orchestratorModel: 'opus', brainModel: 'worker-claude', hooksEnabled: false });
assert.deepEqual([old.activeRepo, old.brainModel, old.routerDefaultModel, old.hooksEnabled], ['C:/a', '', '', false]);
assert.ok(chans.includes('models:list'), 'has channel models:list');
for (const c of ['brain:models', 'chat:new', 'chat:cancel', 'providers:list', 'providers:save', 'providers:delete', 'providers:test', 'router:status', 'chat:sessions', 'chat:open',
  'projects:list', 'project:create', 'project:addRepo', 'project:removeRepo', 'project:rename', 'project:delete', 'memory:get', 'memory:set']) {
  assert.ok(chans.includes(c), `has channel ${c}`);
}
for (const c of ['brain:config', 'vault:set', 'vault:delete', 'providers:import', 'repo:add', 'repo:set-active', 'skills:sync'])assert.ok(!chans.includes(c), `channel ${c} removed`);
for (const c of ['list', 'save', 'remove', 'previewGithub', 'previewLocal', 'install', 'checkUpdate', 'update', 'cancelPreview']) assert.ok(chans.includes(`skills:${c}`), `has channel skills:${c}`);
assert.ok(!('skillSync' in DEFAULT_SETTINGS) && !('skillSync' in validateSettings({ skillSync: true })), 'skillSync setting removed (old settings still load)');
console.log('✓ skills: 9 new channels, skills:sync + skillSync removed');
// projects: valid + unique id, repos = union of project repos, activeRepo falls back to an existing repo
const vp = validateSettings({
  projects: [{ id: 'a-1', name: ' A ', repos: ['C:/a', 'C:/b', 'C:/a'] }, { id: 'a-1', name: 'dup', repos: [] }, { id: '../x', name: 'bad', repos: [] }, { id: 'b-2', name: 'B', repos: ['C:/b', 'C:/c'] }],
  repos: ['C:/zzz'], activeRepo: 'C:/gone',
});
assert.deepEqual(vp.projects, [{ id: 'a-1', name: 'A', repos: ['C:/a', 'C:/b'] }, { id: 'b-2', name: 'B', repos: ['C:/b', 'C:/c'] }]);
assert.deepEqual([vp.repos, vp.activeRepo], [['C:/a', 'C:/b', 'C:/c'], 'C:/a']);
console.log('✓ validateSettings projects: id regex/unique, derived repos, valid activeRepo');
assert.ok(chans.includes('oauth:start') && chans.includes('oauth:finish'), 'R3: has oauth:start + oauth:finish');
assert.ok(chans.includes('i18n:get'), 'has channel i18n:get');
// language: old settings without the field → fallback (main passes OS locale), junk → fallback
assert.equal(DEFAULT_SETTINGS.language, 'en');
assert.equal(old.language, 'en', 'old settings missing language → en');
assert.equal(validateSettings({}, 'vi').language, 'vi', 'fallback = OS locale');
assert.equal(validateSettings({ language: 'vi' }).language, 'vi');
assert.equal(validateSettings({ language: 'fr' }, 'vi').language, 'vi', 'unknown value → fallback');
assert.equal(EVENTS.CHAT_STEP, 'chat:step', 'event chat:step');
const evs = Object.values(EVENTS);
assert.equal(new Set(evs).size, evs.length, 'duplicate EVENTS');
assert.equal(IPC.FLEET_REFRESH, 'fleet:refresh', 'IPC fleet:refresh');
assert.equal(EVENTS.FLEET_CHANGED, 'fleet:changed', 'event fleet:changed');
console.log('✓ validateSettings: filter + defaults correct');

// 2b. default policy found from out/ (desktop + extension); modelsList per router
for (const pkg of ['desktop', 'extension']) {
  const { loadPolicy } = await import(new URL(`../../${pkg}/out/prototype/src/policy.js`, import.meta.url));
  assert.equal(loadPolicy().source, 'proto-default', `${pkg} loadPolicy`);
}
const { modelsList } = await import('../out/extension/src/logic.js'); // desktop/out (rootDir ..)
const ml = modelsList(['gw/opus'], [{ id: 'gw', kind: 'anthropic-compatible', baseUrl: 'x', formats: ['messages'], enabled: true }]);
assert.deepEqual(ml.models, ['gw/opus']);
assert.equal(ml.byWorker.claude[0].ok, true, 'claude + messages');
assert.equal(ml.byWorker.codex[0].ok, true, 'codex + messages via router Responses translation');
console.log('✓ proto-default policy from desktop/out + extension/out; modelsList byWorker correct');

// 3. settingsStore roundtrip
const tmp = mkdtempSync(path.join(os.tmpdir(), 'orch-set-'));
setOrchestraHome(path.join(tmp, 'home')); // migration must not touch the real ~/.orchestra
const file = path.join(tmp, 'settings.json');
saveSettings(file, { ...DEFAULT_SETTINGS, projects: [{ id: 'p-1', name: 'P', repos: ['C:/a', 'C:/b'] }], activeRepo: 'C:/a' });
assert.ok(existsSync(file));
const s2 = loadSettings(file);
assert.equal(s2.activeRepo, 'C:/a');
assert.deepEqual(s2.repos, ['C:/a', 'C:/b']);
// broken file → fallback defaults, no crash
writeFileSync(file, '{broken json');
const s3 = loadSettings(file);
assert.deepEqual(s3, DEFAULT_SETTINGS);
// initLanguage: first run → write OS locale; language already set → keep; broken file → don't overwrite
const f2 = path.join(tmp, 'first.json');
assert.equal(initLanguage(f2, 'vi').language, 'vi');
assert.equal(loadSettings(f2).language, 'vi', 'written to file');
assert.equal(initLanguage(f2, 'en').language, 'vi', 'does not override previous choice');
writeFileSync(f2, JSON.stringify({ repos: ['C:/old'] })); // old settings without language
assert.deepEqual([initLanguage(f2, 'vi').language, loadSettings(f2).repos], ['vi', ['C:/old']]);
assert.equal(initLanguage(file, 'vi').language, 'en', 'broken file → defaults, not written');
assert.equal(readFileSync(file, 'utf8'), '{broken json');
console.log('✓ settingsStore: roundtrip + broken-file fallback + initLanguage');

// migration: old settings (repos only) → 1 project / repo, COPY old sessions, idempotent
const legacy = path.join(tmp, 'svc-a');
mkdirSync(path.join(legacy, '.orchestra', 'chat'), { recursive: true });
writeFileSync(path.join(legacy, '.orchestra', 'chat', 's1.jsonl'), '{"role":"user","content":"hi"}\n');
const f3 = path.join(tmp, 'legacy.json');
writeFileSync(f3, JSON.stringify({ repos: [legacy, 'C:/nope'], activeRepo: 'C:/nope', language: 'en' }));
const m1 = loadSettings(f3);
assert.deepEqual(m1.projects.map((p) => [p.name, p.repos]), [['svc-a', [legacy]], ['nope', ['C:/nope']]]);
assert.ok(m1.projects.every((p) => PROJECT_ID_RE.test(p.id)) && m1.projects[0].id.startsWith('svc-a-'));
assert.equal(m1.activeRepo, 'C:/nope', 'keeps old activeRepo');
const copied = path.join(tmp, 'home', 'projects', m1.projects[0].id, 'chat', 's1.jsonl');
assert.ok(existsSync(copied), 'old session copied into project');
assert.ok(existsSync(path.join(legacy, '.orchestra', 'chat', 's1.jsonl')), 'COPY, not move');
assert.deepEqual(loadSettings(f3).projects, m1.projects, 'idempotent: next load does not migrate again');
assert.equal(copyLegacySessions(legacy, m1.projects[0].id), 0, 'copy again → skips existing files');
rmSync(tmp, { recursive: true, force: true });
console.log('✓ migration: 1 project/repo, copy old sessions, idempotent');

// 4. requireRepo — blocks running in process cwd when no repo (locale-aware error)
setLocale('vi');
assert.throws(() => requireRepo({ activeRepo: '', repos: [] }), /Chưa chọn repo/);
assert.throws(() => requireRepo({ activeRepo: path.join(os.tmpdir(), 'orch-khong-ton-tai-xyz'), repos: [] }), /không tồn tại/);
setLocale('en');
assert.throws(() => requireRepo({ activeRepo: '', repos: [] }), /No repo selected/);
const rdir = mkdtempSync(path.join(os.tmpdir(), 'orch-repo-'));
assert.equal(requireRepo({ activeRepo: rdir, repos: [] }), rdir);
assert.equal(requireRepo({ activeRepo: '', repos: [rdir] }), rdir, 'fallback repos[0]');
rmSync(rdir, { recursive: true, force: true });
console.log('✓ requireRepo: empty/nonexistent → throw, real dir → path');

// 4b. approval inline + permission mode
for (const c of ['approval:respond', 'approval:pending']) assert.ok(chans.includes(c), `has channel ${c}`);
for (const e of ['approval:request', 'approval:resolved', 'approval:focus']) assert.ok(evs.includes(e), `has event ${e}`);
assert.equal(DEFAULT_SETTINGS.permissionMode, 'ask');
assert.equal(old.permissionMode, 'ask', 'old settings missing permissionMode → ask');
for (const m of ['ask', 'auto', 'full']) assert.equal(validateSettings({ permissionMode: m }).permissionMode, m);
assert.equal(DEFAULT_SETTINGS.chatMode, 'chat', 'new chats default to talk');
const pm = (r) => { const s = validateSettings(r); return [s.permissionMode, s.chatMode]; };
assert.deepEqual(pm({ permissionMode: 'plan' }), ['ask', 'plan'], 'old Plan-as-permission → plan + ask');
assert.deepEqual(pm({ permissionMode: 'full', planEnabled: true }), ['full', 'plan'], 'old planEnabled flag → plan');
assert.deepEqual(pm({ permissionMode: 'full', chatMode: 'goal' }), ['full', 'goal'], 'conversation mode independent of permission');
assert.equal(validateSettings({ chatMode: 'yolo' }).chatMode, 'chat');
for (const junk of ['yolo', 1, null, 'FULL']) assert.equal(validateSettings({ permissionMode: junk }).permissionMode, 'ask', `permissionMode ${JSON.stringify(junk)} → ask`);
const { createApprovalBroker, parseApprovalUrl, approvalToastXml } = await import('../out/desktop/src/main/approvals.js');
const sent = [];
const resolved = [];
const br = createApprovalBroker({ onRequest: (r) => sent.push(r), onResolved: (id, a) => resolved.push([id, a]) });
const req = (o = {}) => br.request({ question: 'merge t-1?\nFile: a.ts', kind: 'merge', approveLabel: 'Approve', rejectLabel: 'Reject', ...o });
const p1 = req();
assert.equal(sent.length, 1);
assert.match(sent[0].id, /^[0-9a-f-]{36}$/);
assert.deepEqual(br.pending().map((r) => r.id), [sent[0].id]);
assert.equal(br.respond('nope', true), false, 'unknown id → ignored');
assert.equal(br.respond(sent[0].id, 'yes'), false, 'non-boolean approve → ignored');
assert.equal(br.respond(sent[0].id, true), true);
assert.equal(await p1, true);
assert.equal(br.respond(sent[0].id, false), false, 'second answer → ignored');
assert.deepEqual(resolved, [[sent[0].id, true]]);
const ac = new AbortController();
const p2 = req({ signal: ac.signal });
ac.abort();
assert.equal(await p2, false, 'Stop (abort) → false');
assert.equal(await req({ signal: ac.signal }), false, 'already-aborted signal → false immediately');
const p3 = req();
br.cancelAll();
assert.equal(await p3, false, 'window closed → false');
assert.deepEqual(br.pending(), []);
const id = sent[0].id;
assert.deepEqual(parseApprovalUrl(`orchestra://approval/${id}/approve`), { id, approve: true });
assert.deepEqual(parseApprovalUrl(`orchestra://approval/${id}/reject/`), { id, approve: false });
for (const u of [`orchestra://approval/${id}/merge`, 'orchestra://approval/../x/approve', `https://approval/${id}/approve`, `orchestra://approval/${id}/approve?x=1`, null]) assert.equal(parseApprovalUrl(u), null, String(u));
const xml = approvalToastXml({ ...sent[0], question: 'a <b> & "c"\nline2' }, 'T');
assert.ok(xml.includes('a &lt;b&gt; &amp; &quot;c&quot;') && !xml.includes('line2') && xml.includes(`arguments="orchestra://approval/${id}/approve"`) && xml.includes('activationType="protocol"'));
// chat:exchange images — trust boundary: type allowlist, base64 only, size + count caps, never silently dropped
{
  const png = { mediaType: 'image/png', data: 'iVBORw0KGgo=' };
  assert.deepEqual(validateImages(undefined), { images: [] });
  assert.deepEqual(validateImages([png]), { images: [{ type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' }] });
  for (const bad of ['x', [{ mediaType: 'image/svg+xml', data: 'PHN2Zz4=' }], [{ mediaType: 'image/png', data: 'not base64!' }], [{ mediaType: 'image/png', data: '' }], [{ mediaType: 'image/png', data: 'abc' }], [null]])
    assert.ok('error' in validateImages(bad), `rejects ${JSON.stringify(bad).slice(0, 40)}`);
  assert.ok('error' in validateImages(Array(MAX_IMAGES + 1).fill(png)), 'count cap');
  assert.ok('error' in validateImages([{ mediaType: 'image/jpeg', data: 'A'.repeat(Math.ceil((MAX_IMAGE_BYTES + 3) / 3) * 4) }]), 'size cap');
}
// chat:exchange files — bare safe names only, base64, size caps (zip bigger), legacy Office refused with a hint
{
  const f = (name, data = 'aGk=') => ({ name, data });
  assert.deepEqual(validateFiles(undefined), { files: [] });
  const ok = validateFiles([f('Báo cáo.docx'), f('C:\\Users\\x\\a.txt'), f('empty.txt', '')]);
  assert.deepEqual(ok.files.map((x) => [x.name, x.buf.toString()]), [['Báo cáo.docx', 'hi'], ['a.txt', 'hi'], ['empty.txt', '']], 'path stripped to the bare name');
  for (const bad of ['x', [f('')], [f('..')], [f('a/..')], [f('CON')], [f('a:b.txt')], [f('.meta.json')], [f('a.txt', 'not base64!')], [f('a.txt', 'abc')], [{ name: 1, data: 'aGk=' }], [null]])
    assert.ok('error' in validateFiles(bad), `rejects ${JSON.stringify(bad).slice(0, 40)}`);
  assert.deepEqual(validateFiles([f('old.doc'), f('app.exe')]).files.map((x) => x.name), ['old.doc', 'app.exe'], 'any type accepted — unreadable ones still reach workers');
  assert.ok('error' in validateFiles(Array(MAX_FILES + 1).fill(f('a.txt'))), 'count cap');
  const b64 = (bytes) => 'A'.repeat(Math.ceil(bytes / 3) * 4);
  assert.ok('error' in validateFiles([f('a.pdf', b64(MAX_FILE_BYTES + 3))]), 'file size cap');
  assert.ok('files' in validateFiles([f('a.zip', b64(MAX_FILE_BYTES + 3))]), 'zip may be larger');
  assert.ok('error' in validateFiles([f('a.zip', b64(MAX_ZIP_BYTES + 3))]), 'zip size cap');
}
console.log('✓ approval: channel/event, broker request/respond/abort/cancelAll, URL parse strict, toast xml escape; permissionMode validate + default');

// 5. pages
assert.ok(PAGES.includes('chat') && PAGES.includes('wizard'), 'pages complete');
console.log(`✓ pages: ${PAGES.join(', ')}`);

console.log('DESKTOP CONTRACT TEST PASS ✓');
