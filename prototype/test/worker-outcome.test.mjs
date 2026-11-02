// Regression E2E t-mvyyi9rd-agyn: codex sandbox Windows + implement no-op không được tính ok + fs cross-check noise
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { codexSandbox, getManifest } from '../dist/manifests.js';
import { buildFleetStats } from '../dist/memory.js';
import { computeFsCrossCheck, filterRealChanges } from '../dist/runner.js';

test('codex sandbox: worktree-write win32 → danger-full-access, linux → workspace-write, read-only giữ nguyên', () => {
  assert.equal(codexSandbox('worktree-write', 'win32'), 'danger-full-access');
  assert.equal(codexSandbox('worktree-write', 'linux'), 'workspace-write');
  assert.equal(codexSandbox('read-only', 'win32'), 'read-only');
  assert.equal(codexSandbox('read-only', 'linux'), 'read-only');
  const args = getManifest('codex').headless('p', { sandbox: 'read-only' }).args;
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
});

test('buildFleetStats: implement không đổi file / outcome no_change = thất bại', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orch-stats-'));
  const rec = (id, extra) =>
    writeFileSync(
      path.join(dir, `${id}.json`),
      JSON.stringify({ id, ts: new Date().toISOString(), node: 'implement', role: 'impl', routing: { pick: 'codex' }, run: { exit: 0, killed: false }, scope_check: { ok: true }, ...extra }),
    );
  rec('empty', { artifacts: { files_changed: [] } });
  rec('nochange', { outcome: 'no_change', artifacts: { files_changed: ['x.ts'] } });
  rec('good', { artifacts: { files_changed: ['a.ts'] } });
  const s = buildFleetStats(dir).get('codex|impl');
  assert.equal(s.dispatched, 3);
  assert.equal(s.passed, 1);
  assert.ok(Math.abs(s.ema - 1 / 3) < 1e-6);
});

test('filterRealChanges: file checkout không đổi bị loại, untracked đổi thật vẫn bị báo', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'orch-fsx-'));
  const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q');
  writeFileSync(path.join(repo, 'README.md'), 'x\n');
  g('add', '-A');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  writeFileSync(path.join(repo, 'new.txt'), 'y\n');
  const real = filterRealChanges(repo, ['README.md', 'new.txt']);
  assert.deepEqual(real, ['new.txt']);
  assert.deepEqual(computeFsCrossCheck(real, []).unreported, ['new.txt']);
  // không phải git → giữ nguyên
  const plain = mkdtempSync(path.join(tmpdir(), 'orch-fsx-plain-'));
  assert.deepEqual(filterRealChanges(plain, ['a.txt']), ['a.txt']);
});
