// Regression: guard hook resolve (path có dấu cách) + guard path-escape + fixer commit trên worktree tái dùng
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGuardHook, withHookArgs, runHeadless } from '../dist/runner.js';
import { getManifest } from '../dist/manifests.js';
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

test('guard apply_patch envelope (codex): path ngoài worktree → deny', () => {
  const root = path.join(tmpdir(), 'wt', 't-abc');
  const patch = (...files) => `*** Begin Patch\n${files.map((f) => `*** Add File: ${f}\n+hello`).join('\n')}\n*** End Patch`;
  const viaBash = (p) => ({ command: `apply_patch <<'PATCH'\n${p}\nPATCH` });
  for (const [tool, input] of [['Bash', viaBash], ['apply_patch', (p) => ({ command: p })]]) {
    assert.equal(runGuard(tool, input(patch('../evil.txt')), root), 'deny', `${tool} ../evil.txt`);
    assert.equal(runGuard(tool, input(patch('src/ok.ts')), root), 'allow', `${tool} src/ok.ts`);
    assert.equal(runGuard(tool, input(patch(path.join(tmpdir(), 'outside.txt'))), root), 'deny', `${tool} absolute`);
    assert.equal(runGuard(tool, input(patch('src/ok.ts', '../../x.ts')), root), 'deny', `${tool} file thứ 2 thoát`);
    assert.equal(runGuard(tool, input('*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: ../b.ts\n*** End Patch'), root), 'deny', `${tool} move`);
  }
});

test('codex hook args: -c hooks.PreToolUse + bypass trust, trước prompt', () => {
  const m = getManifest('codex');
  assert.equal(m.hooksSupport, true);
  const spec = m.headless('PROMPT', { sandbox: 'worktree-write' });
  const args = withHookArgs(m, spec.args, 'C:\\a b\\hooks\\guard.cjs', tmpdir());
  assert.equal(args.at(-1), 'PROMPT');
  const c = args.indexOf('-c');
  assert.equal(args[c + 1], 'hooks.PreToolUse=[{matcher=".*",hooks=[{type="command",command="node \\"C:/a b/hooks/guard.cjs\\"",timeout=30}]}]');
  assert.ok(args.indexOf('--dangerously-bypass-hook-trust') > c && args.indexOf('--dangerously-bypass-hook-trust') < args.length - 1);
  // claude giữ --settings <file>
  const cl = withHookArgs(getManifest('claude'), ['-p', 'P'], 'x.cjs', mkdtempSync(path.join(tmpdir(), 'orch-hk-')));
  assert.deepEqual([cl[0], cl[1], cl.at(-1)], ['-p', '--settings', 'P']);
});

test('runHeadless: abort → kill_reason aborted', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orch-abort-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = {
    id: 'fake', display: 'f', bin: 'node', versionCmd: { cmd: 'node', args: [] }, versionRegex: /x/, requiredEvents: [], notes: [],
    headless: (prompt) => ({ cmd: process.execPath, args: ['-e', 'setTimeout(()=>{},60000)', prompt] }),
    mapEvent: () => ({ events: [], known: true }),
  };
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  const started = Date.now();
  const r = await runHeadless(fake, 'p', { cwd: dir, rawDir: dir, signal: ac.signal });
  assert.equal(r.killReason, 'aborted');
  assert.equal(r.events.at(-1).kill_reason, 'aborted');
  assert.ok(Date.now() - started < 20_000);
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
