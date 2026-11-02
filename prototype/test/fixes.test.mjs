// Regression: guard hook resolve (path có dấu cách) + guard path-escape + fixer commit trên worktree tái dùng
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGuardHook } from '../dist/runner.js';
import { shouldCommit } from '../dist/dispatch.js';
import { createWorktree, stageAll, changedFiles, commitAll, mergeBranch } from '../dist/worktree.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const guard = path.join(here, '..', 'hooks', 'guard.cjs');

test('resolveGuardHook tìm thấy guard.cjs từ prototype/dist', () => {
  const p = resolveGuardHook();
  assert.ok(p && existsSync(p), `không thấy: ${p}`);
});

function runGuard(tool, tool_input, root) {
  const r = spawnSync(process.execPath, [guard], {
    input: JSON.stringify({ tool_name: tool, tool_input }),
    env: { ...process.env, ORCH_GUARD_ROOT: root, ORCH_GUARD_NET: 'on' },
    encoding: 'utf8',
  });
  return r.stdout.includes('"deny"') ? 'deny' : 'allow';
}

test('guard path-escape + git push', () => {
  const root = path.join(tmpdir(), 'wt', 't-abc');
  const fwd = root.replace(/\\/g, '/');
  assert.equal(runGuard('Write', { file_path: root + '2/x.ts' }, root), 'deny');
  assert.equal(runGuard('Write', { file_path: fwd + '/src/x.ts' }, root), 'allow');
  assert.equal(runGuard('Write', { file_path: fwd.replace(/\//g, '\\') + '\\src\\x.ts' }, root), 'allow');
  assert.equal(runGuard('Write', { file_path: 'src/x.ts' }, root), 'allow');
  assert.equal(runGuard('Write', { file_path: '../t-abc2/x.ts' }, root), 'deny');
  assert.equal(runGuard('Bash', { command: 'git push origin main' }, root), 'deny');
});

test('shouldCommit: chỉ node ghi code', () => {
  assert.equal(shouldCommit('implement'), true);
  for (const n of ['plan', 'verify', 'review']) assert.equal(shouldCommit(n), false);
});

test('fix trên worktree tái dùng được merge vào main', (t) => {
  const repo = mkdtempSync(path.join(tmpdir(), 'orch fix-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...a) => assert.equal(spawnSync('git', a, { cwd: repo }).status, 0, a.join(' '));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(path.join(repo, 'a.txt'), 'a');
  git('add', '-A');
  git('commit', '-qm', 'init');

  const wt = createWorktree(repo, 't-1');
  // implement → commit lần 1
  writeFileSync(path.join(wt.path, 'impl.txt'), 'impl');
  stageAll(wt.path);
  if (shouldCommit('implement')) commitAll(wt.path, 'impl');
  // fixer (node implement, reuseWorktree) → files_changed chỉ chứa fix, rồi commit
  writeFileSync(path.join(wt.path, 'fix.txt'), 'fix');
  stageAll(wt.path);
  assert.deepEqual(changedFiles(wt.path), ['fix.txt']);
  if (shouldCommit('implement')) commitAll(wt.path, 'fix');

  assert.ok(mergeBranch(repo, wt.branch).ok);
  assert.ok(existsSync(path.join(repo, 'fix.txt')), 'fix không lên main');
  assert.ok(existsSync(path.join(repo, 'impl.txt')));
});
