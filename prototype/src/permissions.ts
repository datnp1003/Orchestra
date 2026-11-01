// Permission matrix theo node type — Worker Protocol spec v0.1 §9 Lớp 1
// Lớp 2 (deny globs ở FS) và Lớp 3 (supervisor in-flight FS watcher) thuộc P3;
// P2 enforce sandbox mode + scope check sau khi chạy (Lớp 4).
import type { NodeType } from './brief.js';

export interface PermissionPlan {
  sandbox: 'read-only' | 'worktree-write';
  net: boolean;
  note: string;
}

export function permissionFor(node: NodeType): PermissionPlan {
  switch (node) {
    case 'plan':
    case 'review':
      return {
        sandbox: 'read-only',
        net: false,
        note: 'node phân tích — chỉ đọc, không tool ghi',
      };
    case 'implement':
      return {
        sandbox: 'worktree-write',
        net: false,
        note: 'ghi chỉ trong worktree; network off',
      };
    case 'verify':
      return {
        sandbox: 'worktree-write',
        net: false,
        note: 'chỉ chạy test — allowlist Bash chi tiết ở P3',
      };
    default:
      return { sandbox: 'read-only', net: false, note: 'mặc định an toàn' };
  }
}
