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

// ---------- Permission mode của chat (Desktop) — enforce ở tool layer, không chỉ ở prompt ----------
export const PERMISSION_MODES = ['plan', 'ask', 'auto', 'full'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export type ApprovalAction = 'dispatch_write' | 'pipeline' | 'merge' | 'policy' | 'repo_attach' | 'plan_approval';
export type ApprovalNeed = 'block' | 'ask' | 'allow';
/** badge của approval card trong chat */
export type ApprovalKind = 'merge' | 'policy' | 'repo' | 'plan' | 'risk';
export const isPermissionMode = (v: unknown): v is PermissionMode => PERMISSION_MODES.includes(v as PermissionMode);

// plan: chỉ đọc (repo_attach = quyền đọc → vẫn hỏi) · ask: hỏi mọi thay đổi · auto: chỉ hỏi khi rủi ro · full: không hỏi (gate merge vẫn chạy)
const APPROVAL_TABLE: Record<PermissionMode, Record<ApprovalAction, ApprovalNeed>> = {
  plan: { dispatch_write: 'block', pipeline: 'block', merge: 'block', policy: 'block', repo_attach: 'ask', plan_approval: 'ask' },
  ask: { dispatch_write: 'ask', pipeline: 'ask', merge: 'ask', policy: 'ask', repo_attach: 'ask', plan_approval: 'ask' },
  auto: { dispatch_write: 'allow', pipeline: 'allow', merge: 'ask', policy: 'ask', repo_attach: 'allow', plan_approval: 'ask' },
  full: { dispatch_write: 'allow', pipeline: 'allow', merge: 'allow', policy: 'allow', repo_attach: 'allow', plan_approval: 'allow' },
};
/** mode lạ/thiếu → 'ask' (an toàn) */
export function needsApproval(mode: unknown, action: ApprovalAction): ApprovalNeed {
  return APPROVAL_TABLE[isPermissionMode(mode) ? mode : 'ask'][action];
}

/** dòng PERMISSION MODE trong system prompt — tiếng Anh cố định (prompt không theo locale UI) */
export const MODE_PROMPT: Record<PermissionMode, string> = {
  plan: 'plan before editing. Only survey (repo tools) and fleet_dispatch with readonly:true. Code-changing dispatch, fleet_pipeline, fleet_merge and policy_promote are refused by the system — describe the plan and ask the user to switch mode to execute it.',
  ask: 'ask before changes. The user approves every code-changing dispatch/pipeline, merge, policy change and repo attach (the system shows the approval card when you call the tool).',
  auto: 'ask only when there is risk. Code-changing dispatch (isolated worktree) and repo attach run without asking; merge, policy changes and pipeline plan approval still ask the user.',
  full: 'fewer confirmations. No human confirmation is asked; merge gates (task ok, scope ok, tests pass) still apply. Report what you did.',
};
export const PLAN_BLOCKED = 'plan mode: describe the plan and ask the user to switch mode';
