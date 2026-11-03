// Thư mục dữ liệu Orchestra (~/.orchestra — cùng chỗ router.json): project, chat ngoài project, memory dài hạn.
// Override bằng ORCHESTRA_HOME hoặc setOrchestraHome (test dùng temp dir).
import os from 'node:os';
import path from 'node:path';

let base = process.env.ORCHESTRA_HOME || '';
export const setOrchestraHome = (dir: string): void => {
  base = dir;
};
export const orchestraHome = (): string => base || path.join(os.homedir(), '.orchestra');

export const PROJECT_ID_RE = /^[\w-]+$/;
export function projectDir(id: string): string {
  if (!PROJECT_ID_RE.test(id)) throw new Error(`invalid project id: ${id}`); // id đi vào path — chặn traversal
  return path.join(orchestraHome(), 'projects', id);
}
/** null = chat ngoài project */
export const chatDir = (projectId: string | null): string =>
  projectId ? path.join(projectDir(projectId), 'chat') : path.join(orchestraHome(), 'chats');
export const memoryFile = (projectId: string | null): string =>
  projectId ? path.join(projectDir(projectId), 'memory.md') : path.join(orchestraHome(), 'memory.md');
