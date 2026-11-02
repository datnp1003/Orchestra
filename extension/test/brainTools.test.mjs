// M1: tool executor của Orchestra brain — temp dir + temp git repo, không CLI/mạng thật
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { brainToolExecutor, BRAIN_TOOLS } from '../out/extension/src/logic.js';

const tmp = (t) => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'orch brain-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
};
const exec = (repo, approve = async () => true) => brainToolExecutor(repo, { approve, hooksEnabled: false, skillSync: false });

test('tool defs: tên unique, có schema', () => {
  const names = BRAIN_TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(BRAIN_TOOLS.every((t) => t.input_schema.type === 'object'));
});

test('repo_read chặn thoát repo', async (t) => {
  const repo = tmp(t);
  writeFileSync(path.join(repo, 'a.txt'), 'l1\nl2\nl3');
  const x = exec(repo);
  assert.equal((await x('repo_read', { path: '../x' })).ok, false);
  assert.equal((await x('repo_read', { path: 'sub/../../x' })).ok, false);
  assert.equal((await x('repo_read', { path: path.join(os.tmpdir(), 'x') })).ok, false);
  assert.equal((await x('repo_read', { path: 'C:/Windows/win.ini' })).ok, false);
  assert.equal((await x('repo_read', {})).ok, false);
  const r = await x('repo_read', { path: 'a.txt', offset: 2, limit: 1 });
  assert.ok(r.ok);
  assert.match(r.content, /^2\tl2\n\(3 dòng tổng\)$/);
});

test('repo_glob / repo_grep trên temp dir, bỏ .git/node_modules', async (t) => {
  const repo = tmp(t);
  for (const d of ['src/x', 'node_modules/p', '.git']) mkdirSync(path.join(repo, d), { recursive: true });
  writeFileSync(path.join(repo, 'src/a.ts'), 'const pay = 1;\n// TODO pay');
  writeFileSync(path.join(repo, 'src/x/b.ts'), 'pay()');
  writeFileSync(path.join(repo, 'src/c.md'), 'pay doc');
  writeFileSync(path.join(repo, 'node_modules/p/i.ts'), 'pay');
  writeFileSync(path.join(repo, '.git/config'), 'pay');
  const x = exec(repo);
  assert.deepEqual((await x('repo_glob', { pattern: 'src/**/*.ts' })).content.split('\n'), ['src/a.ts', 'src/x/b.ts']);
  assert.equal((await x('repo_glob', { pattern: '' })).ok, false);
  const g = await x('repo_grep', { pattern: 'pay', glob: '**/*.ts' });
  assert.deepEqual(g.content.split('\n').map((l) => l.split(':').slice(0, 2).join(':')), ['src/a.ts:1', 'src/a.ts:2', 'src/x/b.ts:1']);
  assert.equal((await x('repo_grep', { pattern: '(' })).ok, false);
});

test('fleet_dispatch / fleet_pipeline validate input, không throw', async (t) => {
  const x = exec(tmp(t));
  for (const input of [{ goal: 'g', scope: [] }, { goal: 'g' }, { goal: '', scope: ['src/**'] }, { goal: 'g', scope: [1] }, null]) {
    const r = await x('fleet_dispatch', input);
    assert.equal(r.ok, false, JSON.stringify(input));
  }
  assert.match((await x('fleet_dispatch', { goal: 'g', scope: [] })).content, /scope/);
  assert.equal((await x('fleet_pipeline', { template: '../evil', goal: 'g', scope: ['a'] })).ok, false);
  assert.equal((await x('nope', {})).ok, false);
});

test('T2 fleet_merge: approve=false → không merge; true → merge', async (t) => {
  const repo = tmp(t);
  const git = (...a) => assert.equal(spawnSync('git', a, { cwd: repo }).status, 0, a.join(' '));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(path.join(repo, 'a.txt'), 'a');
  git('add', '-A');
  git('commit', '-qm', 'init');
  git('checkout', '-qb', 'orch/t-1');
  writeFileSync(path.join(repo, 'b.txt'), 'b');
  git('add', '-A');
  git('commit', '-qm', 'work');
  git('checkout', '-q', 'main');
  mkdirSync(path.join(repo, '.orchestra', 'tasks'), { recursive: true });
  writeFileSync(path.join(repo, '.orchestra', 'tasks', 't-1.json'), JSON.stringify({ id: 't-1', worktree: { branch: 'orch/t-1' } }));
  const merged = () => spawnSync('git', ['merge-base', '--is-ancestor', 'orch/t-1', 'HEAD'], { cwd: repo }).status === 0;

  const asked = [];
  const no = await exec(repo, async (q) => (asked.push(q), false))('fleet_merge', { taskId: 't-1' });
  assert.deepEqual(no, { ok: false, content: 'user từ chối' });
  assert.equal(asked.length, 1);
  assert.equal(merged(), false, 'không được merge khi user từ chối');

  const bad = await exec(repo, async () => assert.fail('không hỏi khi input sai'))('fleet_merge', {});
  assert.equal(bad.ok, false);

  const yes = await exec(repo)('fleet_merge', { taskId: 't-1' });
  assert.ok(yes.ok, yes.content);
  assert.equal(merged(), true);

  const pr = await exec(repo, async () => false)('policy_promote', { role: 'coder', cli: 'codex' });
  assert.deepEqual(pr, { ok: false, content: 'user từ chối' });
});
