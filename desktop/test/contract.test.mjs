// Unit test contract + settings store — node thường, không Electron
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IPC, EVENTS, PAGES, DEFAULT_SETTINGS, validateSettings, requireRepo } from '../out/desktop/src/main/contract.js';
import { loadSettings, saveSettings, initLanguage } from '../out/desktop/src/main/settingsStore.js';
import { setLocale } from '../out/prototype/src/i18n/index.js';

// 1. channels unique + đầy đủ
const chans = Object.values(IPC);
assert.equal(new Set(chans).size, chans.length, 'IPC channels trùng nhau');
assert.ok(chans.length >= 18, `quá ít channels: ${chans.length}`);
assert.ok(Object.values(EVENTS).every((e) => !chans.includes(e)), 'EVENTS không được trùng IPC channel');
console.log(`✓ contract: ${chans.length} channels unique + ${Object.keys(EVENTS).length} events`);

// 2. validateSettings — merge defaults, chặn rác
// settings cũ còn orchestratorWorker/orchestratorModel → bị bỏ, không lỗi
const v1 = validateSettings({ repos: ['', 'C:/x', 42], orchestratorWorker: 'codex', orchestratorModel: 'x' });
assert.deepEqual(v1.repos, ['C:/x'], 'repo rỗng/không string phải bị lọc');
assert.equal(v1.hooksEnabled, true, 'hooksEnabled mặc định true');
assert.ok(!('orchestratorWorker' in v1) && !('orchestratorModel' in v1), 'field CLI brain cũ bị bỏ');
const v2 = validateSettings(null);
assert.deepEqual(v2, DEFAULT_SETTINGS, 'null → defaults');
assert.equal(DEFAULT_SETTINGS.brainModel, '', 'brainModel mặc định rỗng (phải chọn)');
assert.equal(DEFAULT_SETTINGS.routerDefaultModel, '', 'routerDefaultModel mặc định rỗng');
assert.equal(v1.brainModel, '', 'brainModel thiếu → rỗng');
assert.equal(validateSettings({ brainModel: ' cc/claude-sonnet-5-5 ' }).brainModel, 'cc/claude-sonnet-5-5', 'giữ model (trim)');
for (const junk of [42, '', '  ', null, 'worker-claude']) assert.equal(validateSettings({ brainModel: junk }).brainModel, '', `brainModel ${JSON.stringify(junk)} → rỗng`);
assert.equal(validateSettings({ routerDefaultModel: ' gw/m ' }).routerDefaultModel, 'gw/m');
assert.equal(validateSettings({ routerDefaultModel: 7 }).routerDefaultModel, '');
// settings cũ (CLI brain + brainModel kiểu cũ) vẫn load, không lỗi
const old = validateSettings({ repos: ['C:/a'], activeRepo: 'C:/a', orchestratorWorker: 'claude', orchestratorModel: 'opus', brainModel: 'worker-claude', hooksEnabled: false });
assert.deepEqual([old.activeRepo, old.brainModel, old.routerDefaultModel, old.hooksEnabled], ['C:/a', '', '', false]);
assert.ok(chans.includes('models:list'), 'có channel models:list');
for (const c of ['brain:models', 'chat:new', 'repo:add','chat:cancel', 'providers:list', 'providers:save', 'providers:delete', 'providers:test', 'router:status', 'chat:sessions', 'chat:open']) {
  assert.ok(chans.includes(c), `có channel ${c}`);
}
for (const c of ['brain:config', 'vault:set', 'vault:delete', 'providers:import'])assert.ok(!chans.includes(c), `đã bỏ channel ${c}`);
assert.ok(chans.includes('oauth:start') && chans.includes('oauth:finish'), 'R3: có oauth:start + oauth:finish');
assert.ok(chans.includes('i18n:get'), 'có channel i18n:get');
// language: settings cũ không có field → fallback (main truyền locale OS), rác → fallback
assert.equal(DEFAULT_SETTINGS.language, 'en');
assert.equal(old.language, 'en', 'settings cũ thiếu language → en');
assert.equal(validateSettings({}, 'vi').language, 'vi', 'fallback = locale OS');
assert.equal(validateSettings({ language: 'vi' }).language, 'vi');
assert.equal(validateSettings({ language: 'fr' }, 'vi').language, 'vi', 'giá trị lạ → fallback');
assert.equal(EVENTS.CHAT_STEP, 'chat:step', 'event chat:step');
const evs = Object.values(EVENTS);
assert.equal(new Set(evs).size, evs.length, 'EVENTS trùng nhau');
console.log('✓ validateSettings: filter + defaults đúng');

// 2b. policy mặc định tìm được từ out/ (desktop + extension); modelsList theo router
for (const pkg of ['desktop', 'extension']) {
  const { loadPolicy } = await import(new URL(`../../${pkg}/out/prototype/src/policy.js`, import.meta.url));
  assert.equal(loadPolicy().source, 'proto-default', `${pkg} loadPolicy`);
}
const { modelsList } = await import('../out/extension/src/logic.js'); // desktop/out (rootDir ..)
const ml = modelsList(['gw/opus'], [{ id: 'gw', kind: 'anthropic-compatible', baseUrl: 'x', formats: ['messages'], enabled: true }]);
assert.deepEqual(ml.models, ['gw/opus']);
assert.equal(ml.byWorker.claude[0].ok, true, 'claude + messages');
assert.equal(ml.byWorker.codex[0].ok, true, 'codex + messages qua router dịch Responses');
console.log('✓ proto-default policy từ desktop/out + extension/out; modelsList byWorker đúng');

// 3. settingsStore roundtrip
const tmp = mkdtempSync(path.join(os.tmpdir(), 'orch-set-'));
const file = path.join(tmp, 'settings.json');
const s1 = saveSettings(file, { ...DEFAULT_SETTINGS, repos: ['C:/a', 'C:/b'], activeRepo: 'C:/a' });
assert.ok(existsSync(file));
const s2 = loadSettings(file);
assert.equal(s2.activeRepo, 'C:/a');
assert.deepEqual(s2.repos, ['C:/a', 'C:/b']);
// file hỏng → fallback defaults, không crash
writeFileSync(file, '{broken json');
const s3 = loadSettings(file);
assert.deepEqual(s3, DEFAULT_SETTINGS);
// initLanguage: lần đầu → ghi locale OS; đã có language → giữ; file hỏng → không ghi đè
const f2 = path.join(tmp, 'first.json');
assert.equal(initLanguage(f2, 'vi').language, 'vi');
assert.equal(loadSettings(f2).language, 'vi', 'đã ghi xuống file');
assert.equal(initLanguage(f2, 'en').language, 'vi', 'không đè lựa chọn cũ');
writeFileSync(f2, JSON.stringify({ repos: ['C:/old'] })); // settings cũ chưa có language
assert.deepEqual([initLanguage(f2, 'vi').language, loadSettings(f2).repos], ['vi', ['C:/old']]);
assert.equal(initLanguage(file, 'vi').language, 'en', 'file hỏng → defaults, không ghi');
assert.equal(readFileSync(file, 'utf8'), '{broken json');
rmSync(tmp, { recursive: true, force: true });
console.log('✓ settingsStore: roundtrip + broken-file fallback + initLanguage');

// 4. requireRepo — chặn chạy trong process cwd khi chưa có repo (lỗi theo locale)
setLocale('vi');
assert.throws(() => requireRepo({ activeRepo: '', repos: [] }), /Chưa chọn repo/);
assert.throws(() => requireRepo({ activeRepo: path.join(os.tmpdir(), 'orch-khong-ton-tai-xyz'), repos: [] }), /không tồn tại/);
setLocale('en');
assert.throws(() => requireRepo({ activeRepo: '', repos: [] }), /No repo selected/);
const rdir = mkdtempSync(path.join(os.tmpdir(), 'orch-repo-'));
assert.equal(requireRepo({ activeRepo: rdir, repos: [] }), rdir);
assert.equal(requireRepo({ activeRepo: '', repos: [rdir] }), rdir, 'fallback repos[0]');
rmSync(rdir, { recursive: true, force: true });
console.log('✓ requireRepo: rỗng/không tồn tại → throw, dir thật → path');

// 5. pages
assert.ok(PAGES.includes('chat') && PAGES.includes('wizard'), 'pages đủ');
console.log(`✓ pages: ${PAGES.join(', ')}`);

console.log('DESKTOP CONTRACT TEST PASS ✓');
