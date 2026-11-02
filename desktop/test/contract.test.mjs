// Unit test contract + settings store — node thường, không Electron
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IPC, EVENTS, PAGES, DEFAULT_SETTINGS, validateSettings, requireRepo } from '../out/desktop/src/main/contract.js';
import { loadSettings, saveSettings } from '../out/desktop/src/main/settingsStore.js';

// 1. channels unique + đầy đủ
const chans = Object.values(IPC);
assert.equal(new Set(chans).size, chans.length, 'IPC channels trùng nhau');
assert.ok(chans.length >= 18, `quá ít channels: ${chans.length}`);
assert.ok(Object.values(EVENTS).every((e) => !chans.includes(e)), 'EVENTS không được trùng IPC channel');
console.log(`✓ contract: ${chans.length} channels unique + ${Object.keys(EVENTS).length} events`);

// 2. validateSettings — merge defaults, chặn rác
const v1 = validateSettings({ repos: ['', 'C:/x', 42], orchestratorWorker: '' });
assert.deepEqual(v1.repos, ['C:/x'], 'repo rỗng/không string phải bị lọc');
assert.equal(v1.orchestratorWorker, 'claude', 'worker rỗng → default');
assert.equal(v1.hooksEnabled, true, 'hooksEnabled mặc định true');
const v2 = validateSettings(null);
assert.deepEqual(v2, DEFAULT_SETTINGS, 'null → defaults');
console.log('✓ validateSettings: filter + defaults đúng');

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
rmSync(tmp, { recursive: true, force: true });
console.log('✓ settingsStore: roundtrip + broken-file fallback');

// 4. requireRepo — chặn chạy trong process cwd khi chưa có repo
assert.throws(() => requireRepo({ activeRepo: '', repos: [] }), /Chưa chọn repo/);
assert.throws(() => requireRepo({ activeRepo: path.join(os.tmpdir(), 'orch-khong-ton-tai-xyz'), repos: [] }), /không tồn tại/);
const rdir = mkdtempSync(path.join(os.tmpdir(), 'orch-repo-'));
assert.equal(requireRepo({ activeRepo: rdir, repos: [] }), rdir);
assert.equal(requireRepo({ activeRepo: '', repos: [rdir] }), rdir, 'fallback repos[0]');
rmSync(rdir, { recursive: true, force: true });
console.log('✓ requireRepo: rỗng/không tồn tại → throw, dir thật → path');

// 5. pages
assert.ok(PAGES.includes('chat') && PAGES.includes('wizard'), 'pages đủ');
console.log(`✓ pages: ${PAGES.join(', ')}`);

console.log('DESKTOP CONTRACT TEST PASS ✓');
