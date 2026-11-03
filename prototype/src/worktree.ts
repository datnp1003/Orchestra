// Git worktree isolation — Worker Protocol §9 Layer 2 + DSL spec §2 (`.orchestra/wt`)
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { t } from './i18n/index.js';

export interface Worktree {
  path: string;
  branch: string;
}

function git(repo: string, args: string[]): { ok: boolean; out: string } {
  try {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    return { ok: r.status === 0, out };
  } catch (err) {
    return { ok: false, out: err instanceof Error ? err.message : String(err) };
  }
}

export function isGitRepo(repo: string): boolean {
  return git(repo, ['rev-parse', '--is-inside-work-tree']).ok;
}

export function createWorktree(repo: string, taskId: string): Worktree {
  const wtPath = path.join(repo, '.orchestra', 'wt', taskId);
  const branch = `orchestra/task-${taskId}`;
  let r = git(repo, ['worktree', 'add', '-b', branch, wtPath]);
  if (!r.ok) r = git(repo, ['worktree', 'add', wtPath]); // branch already exists → use detached
  if (!r.ok) throw new Error(t('core.worktree.addFailed', { out: r.out }));
  return { path: wtPath, branch };
}

export function removeWorktree(repo: string, wtPath: string): void {
  git(repo, ['worktree', 'remove', '--force', wtPath]);
  git(repo, ['worktree', 'prune']);
}

export function stageAll(wtPath: string): void {
  git(wtPath, ['add', '-A']);
}

export function changedFiles(wtPath: string): string[] {
  const r = git(wtPath, ['status', '--porcelain']);
  if (!r.ok) return [];
  return r.out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

// do NOT trim: losing the final newline / trailing whitespace on context lines = corrupt patch (git apply rejects it)
export function diffPatch(wtPath: string): string {
  const r = spawnSync('git', ['diff', '--cached'], { cwd: wtPath, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return r.status === 0 ? r.stdout ?? '' : '';
}

export function commitAll(wtPath: string, message: string): { ok: boolean; out: string } {
  const hasChanges = changedFiles(wtPath).length > 0;
  if (!hasChanges) return { ok: true, out: 'nothing-to-commit' };
  const r = git(wtPath, ['commit', '-m', message]);
  return { ok: r.ok, out: r.out };
}

export function mergeBranch(repo: string, branch: string): { ok: boolean; out: string } {
  const r = git(repo, ['merge', '--no-ff', branch, '-m', `orchestra: merge ${branch}`]);
  return { ok: r.ok, out: r.out };
}
