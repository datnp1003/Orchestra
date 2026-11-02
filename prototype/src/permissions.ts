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
        note: 'analysis node — read-only, no write tools',
      };
    case 'implement':
      return {
        sandbox: 'worktree-write',
        net: false,
        note: 'writes only inside the worktree; network off',
      };
    case 'verify':
      return {
        sandbox: 'worktree-write',
        net: false,
        note: 'run tests only — detailed Bash allowlist in P3',
      };
    default:
      return { sandbox: 'read-only', net: false, note: 'safe default' };
  }
}
