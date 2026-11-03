// Orchestra data dir (~/.orchestra — alongside router.json): projects, non-project chats, long-term memory.
// Override via ORCHESTRA_HOME or setOrchestraHome (tests use a temp dir).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let base = process.env.ORCHESTRA_HOME || '';
export const setOrchestraHome = (dir: string): void => {
  base = dir;
};
export const orchestraHome = (): string => base || path.join(os.homedir(), '.orchestra');

export const PROJECT_ID_RE = /^[\w-]+$/;
export function projectDir(id: string): string {
  if (!PROJECT_ID_RE.test(id)) throw new Error(`invalid project id: ${id}`); // id goes into a path — block traversal
  return path.join(orchestraHome(), 'projects', id);
}
/** null = non-project chat */
export const chatDir = (projectId: string | null): string =>
  projectId ? path.join(projectDir(projectId), 'chat') : path.join(orchestraHome(), 'chats');
/** scratch repo for non-project chats — workers need a git repo to create worktrees; created on first use (idempotent) */
export function ensureWorkspace(): string {
  const dir = path.join(orchestraHome(), 'workspace');
  if (existsSync(path.join(dir, '.git'))) return dir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'README.md'), '# Orchestra workspace\n\nScratch git repo for chats outside projects.\n');
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=Orchestra', '-c', 'user.email=orchestra@localhost', 'commit', '-q', '-m', 'init workspace']]) {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    if (r.status !== 0) throw new Error(`workspace: git ${args.join(' ')} failed: ${r.stderr || r.error}`);
  }
  return dir;
}
export const memoryFile = (projectId: string | null): string =>
  projectId ? path.join(projectDir(projectId), 'memory.md') : path.join(orchestraHome(), 'memory.md');
