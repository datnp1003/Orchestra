// M1: tool executor của Orchestra brain — temp dir + temp git repo, không CLI/mạng thật
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { brainToolExecutor, brainSystemPrompt, BRAIN_TOOLS, brainTools, projectToolExecutor, repoRefs } from '../out/extension/src/logic.js';
import { setOrchestraHome } from '../out/prototype/src/home.js';
import { loadMemory } from '../out/prototype/src/agentMemory.js';

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
  assert.match(r.content, /^2\tl2\n\(3 lines total\)$/);
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

test('fleet_dispatch readonly → node plan/planner, kèm câu trả lời worker; mặc định implement/coder', async (t) => {
  const repo = tmp(t);
  const calls = [];
  const dispatch = async (_repo, o) => (calls.push(o), {
    result: { ok: true, taskId: 't-x', stage: 'done', record: { routing: { pick: 'claude' }, artifacts: { files_changed: [] }, scope_check: { ok: true }, last_message: 'a.ts\nb.ts' } },
  });
  const x = brainToolExecutor(repo, { approve: async () => true, dispatch });
  const ro = await x('fleet_dispatch', { goal: 'list files', scope: ['src/**'], readonly: true });
  assert.equal(ro.ok, true);
  assert.deepEqual([calls[0].node, calls[0].role], ['plan', 'planner']);
  assert.match(calls[0].promptOverride, /READ-ONLY/);
  assert.match(ro.content, /worker answer:\na\.ts\nb\.ts/);
  await x('fleet_dispatch', { goal: 'fix', scope: ['src/**'] });
  assert.deepEqual([calls[1].node, calls[1].role, calls[1].promptOverride], ['implement', 'coder', undefined]);
  assert.equal((await x('fleet_dispatch', { goal: 'g', scope: ['a'], readonly: 'yes' })).ok, false);
  assert.equal(calls.length, 2, 'readonly sai kiểu → không dispatch');
  assert.ok(BRAIN_TOOLS.find((d) => d.name === 'fleet_dispatch').input_schema.properties.readonly.type === 'boolean');
  const sys = brainSystemPrompt({ project: { name: 'P', repos: repoRefs([repo]) }, globalMemory: '' });
  assert.ok(sys.includes(`- ${path.basename(repo)}: ${path.resolve(repo)}`), 'system prompt có REPOS');
  assert.match(sys, /readonly:true for tasks that only read/);
});

test('repoRefs: basename, trùng tên → -2', () => {
  assert.deepEqual(repoRefs(['/a/api', '/b/api', '/c/web']).map((r) => r.name), ['api', 'api-2', 'web']);
});

test('projectToolExecutor: route theo repo; >1 repo bắt buộc repo; 1 repo mặc định', async (t) => {
  const A = tmp(t);
  const B = tmp(t);
  writeFileSync(path.join(A, 'a.txt'), 'from A');
  writeFileSync(path.join(B, 'a.txt'), 'from B');
  const refs = repoRefs([A, B]);
  const x = projectToolExecutor(refs, { approve: async () => true, projectId: 'p-1' });
  assert.match((await x('repo_read', { path: 'a.txt', repo: refs[1].name })).content, /from B/);
  assert.match((await x('repo_read', { path: 'a.txt', repo: refs[0].name })).content, /from A/);
  const miss = await x('repo_read', { path: 'a.txt' });
  assert.equal(miss.ok, false);
  assert.match(miss.content, /repo is required — one of: /);
  assert.ok(miss.content.includes(refs[1].name));
  assert.match((await x('repo_read', { path: 'a.txt', repo: 'nope' })).content, /unknown repo "nope"/);
  const one = projectToolExecutor([refs[0]], { approve: async () => true, projectId: 'p-1' });
  assert.match((await one('repo_read', { path: 'a.txt' })).content, /from A/, '1 repo → mặc định');
  const none = projectToolExecutor([], { approve: async () => true, projectId: null });
  assert.equal((await none('repo_read', { path: 'a.txt' })).ok, false, 'chat global không có repo tool');
  assert.equal((await x('nope', {})).ok, false);
  // schema: repo tool có `repo` enum; global chỉ có memory_update
  const tools = brainTools(refs);
  assert.deepEqual(tools.find((d) => d.name === 'repo_read').input_schema.properties.repo.enum, refs.map((r) => r.name));
  assert.ok(tools.some((d) => d.name === 'memory_update'));
  assert.deepEqual(brainTools(null).map((d) => d.name), ['memory_update']);
});

test('memory_update: global vs project; project bị chặn ngoài project', async (t) => {
  setOrchestraHome(tmp(t));
  const inProj = projectToolExecutor([], { approve: async () => true, projectId: 'p-1' });
  const global = projectToolExecutor([], { approve: async () => true, projectId: null });
  assert.ok((await inProj('memory_update', { scope: 'project', action: 'add', text: 'uses pnpm' })).ok);
  assert.ok((await inProj('memory_update', { scope: 'global', action: 'add', text: 'likes short answers' })).ok);
  assert.match((await inProj('memory_update', { scope: 'global', action: 'add', text: 'likes short answers' })).content, /no change/);
  const blocked = await global('memory_update', { scope: 'project', action: 'add', text: 'leak' });
  assert.equal(blocked.ok, false, 'chat global không ghi project memory');
  assert.equal((await global('memory_update', { scope: 'x', action: 'add', text: 'y' })).ok, false);
  assert.match(loadMemory('p-1'), /uses pnpm/);
  assert.match(loadMemory(null), /likes short answers/);
  assert.ok(!loadMemory(null).includes('pnpm') && !loadMemory('p-1').includes('leak'));
});

test('system prompt: chat global chỉ thấy global memory; project thấy cả hai + PROJECT/REPOS', () => {
  const g = brainSystemPrompt({ globalMemory: '- G1', projectMemory: '- P1' });
  assert.match(g, /USER\/GLOBAL MEMORY:\n- G1/);
  assert.ok(!g.includes('P1') && !g.includes('PROJECT MEMORY') && !g.includes('REPOS:'), 'global không thấy project');
  assert.match(g, /open a chat inside a project/);
  const p = brainSystemPrompt({ project: { name: 'Shop', repos: repoRefs(['/x/api', '/x/web']) }, globalMemory: '- G1', projectMemory: '- P1' });
  assert.match(p, /PROJECT: Shop\nREPOS:\n- api: .*api\n- web: .*web/);
  assert.match(p, /USER\/GLOBAL MEMORY:\n- G1/);
  assert.match(p, /PROJECT MEMORY \(Shop\):\n- P1/);
  assert.match(p, /one fleet_dispatch per repo/);
  assert.match(p, /memory_update/);
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
  writeFileSync(path.join(repo, '.orchestra', 'tasks', 't-1.json'), JSON.stringify({ id: 't-1', worktree: { branch: 'orch/t-1' }, artifacts: { files_changed: ['b.txt'] } }));
  const merged = () => spawnSync('git', ['merge-base', '--is-ancestor', 'orch/t-1', 'HEAD'], { cwd: repo }).status === 0;

  const asked = [];
  const no = await exec(repo, async (q) => (asked.push(q), false))('fleet_merge', { taskId: 't-1' });
  assert.deepEqual(no, { ok: false, content: 'user declined' });
  assert.equal(asked.length, 1);
  assert.equal(merged(), false, 'không được merge khi user từ chối');

  const bad = await exec(repo, async () => assert.fail('không hỏi khi input sai'))('fleet_merge', {});
  assert.equal(bad.ok, false);

  const yes = await exec(repo)('fleet_merge', { taskId: 't-1' });
  assert.ok(yes.ok, yes.content);
  assert.equal(merged(), true);

  const pr = await exec(repo, async () => false)('policy_promote', { role: 'coder', cli: 'codex' });
  assert.deepEqual(pr, { ok: false, content: 'user declined' });
});

// repo main + branch orchestra/task-<id> đổi feature.ts + record (+ patch file) + "worktree" có package.json tuỳ chọn
function taskRepo(t, { id = 't-ab1', record = {}, testScript, patchFile = true } = {}) {
  const repo = tmp(t);
  const git = (...a) => {
    const r = spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
    assert.equal(r.status, 0, a.join(' '));
    return r.stdout;
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(path.join(repo, 'a.txt'), 'a');
  git('add', '-A');
  git('commit', '-qm', 'init');
  const branch = `orchestra/task-${id}`;
  git('checkout', '-qb', branch);
  writeFileSync(path.join(repo, 'feature.ts'), 'export const x = 1;\n');
  git('add', '-A');
  const patch = git('diff', '--cached');
  git('commit', '-qm', 'work');
  git('checkout', '-q', 'main');
  const tasks = path.join(repo, '.orchestra', 'tasks');
  mkdirSync(tasks, { recursive: true });
  const wt = tmp(t);
  if (testScript) writeFileSync(path.join(wt, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: testScript } }));
  const patchRef = path.join(tasks, `${id}.patch`);
  if (patchFile) writeFileSync(patchRef, patch);
  writeFileSync(path.join(tasks, `${id}.json`), JSON.stringify({
    id, routing: { pick: 'codex' }, worktree: { path: wt, branch },
    artifacts: { files_changed: ['feature.ts'], patch_ref: patchFile ? patchRef : null }, scope_check: { ok: true, violations: [] }, ...record,
  }));
  const merged = () => spawnSync('git', ['merge-base', '--is-ancestor', branch, 'HEAD'], { cwd: repo }).status === 0;
  return { repo, id, merged };
}

test('task_diff: patch_ref → patch; không có patch file → git diff nhánh; git_diff ref=taskId delegate', async (t) => {
  const { repo, id } = taskRepo(t);
  const r = await exec(repo)('task_diff', { taskId: id });
  assert.ok(r.ok, r.content);
  assert.match(r.content, /worker=codex/);
  assert.match(r.content, /files_changed: feature\.ts/);
  assert.match(r.content, /\+export const x = 1;/);
  assert.deepEqual(await exec(repo)('git_diff', { ref: id }), r);
  assert.equal((await exec(repo)('task_diff', { taskId: '../x' })).ok, false);
  assert.equal((await exec(repo)('task_diff', { taskId: 't-nope' })).ok, false);
  const nf = taskRepo(t, { patchFile: false });
  const r2 = await exec(nf.repo)('task_diff', { taskId: nf.id });
  assert.match(r2.content, /\+export const x = 1;/);
  assert.match(r2.content, /feature\.ts \| 1 \+/);
});

test('fleet_merge gate: no_change / không file / scope fail → từ chối, không hỏi', async (t) => {
  for (const record of [{ outcome: 'no_change' }, { artifacts: { files_changed: [] } }, { scope_check: { ok: false, violations: [{ file: 'x' }] } }]) {
    const { repo, id, merged } = taskRepo(t, { record });
    const r = await exec(repo, async () => assert.fail('không được hỏi approve'))('fleet_merge', { taskId: id });
    assert.equal(r.ok, false, JSON.stringify(record));
    assert.match(r.content, /^not merging/);
    assert.equal(merged(), false);
  }
});

test('fleet_merge: test fail → từ chối không hỏi; test pass → hỏi (file + test) rồi merge', async (t) => {
  const red = taskRepo(t, { testScript: 'node -e "process.exit(1)"' });
  const r = await exec(red.repo, async () => assert.fail('không được hỏi approve'))('fleet_merge', { taskId: red.id });
  assert.equal(r.ok, false);
  assert.match(r.content, /^test fail/);
  assert.equal(red.merged(), false);

  const green = taskRepo(t, { testScript: 'node -e "process.exit(0)"' });
  const asked = [];
  const ok = await exec(green.repo, async (q) => (asked.push(q), true))('fleet_merge', { taskId: green.id });
  assert.ok(ok.ok, ok.content);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /feature\.ts/);
  assert.match(asked[0], /test pass/);
  assert.equal(green.merged(), true);
});
