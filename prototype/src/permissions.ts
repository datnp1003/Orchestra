// Permission matrix by node type — Worker Protocol spec v0.1 §9 Layer 1
// Layer 2 (FS deny globs) and Layer 3 (supervisor in-flight FS watcher) belong to P3;
// P2 enforces sandbox mode + post-run scope check (Layer 4).
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

// ---------- Chat permission mode (Desktop) — enforced at the tool layer, not just the prompt ----------
export const PERMISSION_MODES = ['plan', 'ask', 'auto', 'full'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export type ApprovalAction = 'dispatch_write' | 'pipeline' | 'merge' | 'policy' | 'repo_attach' | 'plan_approval';
export type ApprovalNeed = 'block' | 'ask' | 'allow';
/** badge of the approval card in chat */
export type ApprovalKind = 'merge' | 'policy' | 'repo' | 'plan' | 'risk';
export const isPermissionMode = (v: unknown): v is PermissionMode => PERMISSION_MODES.includes(v as PermissionMode);

// plan: read-only (repo_attach = read access → still asks) · ask: ask for every change · auto: ask only when risky · full: never ask (merge gate still runs)
const APPROVAL_TABLE: Record<PermissionMode, Record<ApprovalAction, ApprovalNeed>> = {
  plan: { dispatch_write: 'block', pipeline: 'block', merge: 'block', policy: 'block', repo_attach: 'ask', plan_approval: 'ask' },
  ask: { dispatch_write: 'ask', pipeline: 'ask', merge: 'ask', policy: 'ask', repo_attach: 'ask', plan_approval: 'ask' },
  auto: { dispatch_write: 'allow', pipeline: 'allow', merge: 'ask', policy: 'ask', repo_attach: 'allow', plan_approval: 'ask' },
  full: { dispatch_write: 'allow', pipeline: 'allow', merge: 'allow', policy: 'allow', repo_attach: 'allow', plan_approval: 'allow' },
};
/** unknown/missing mode → 'ask' (safe) */
export function needsApproval(mode: unknown, action: ApprovalAction): ApprovalNeed {
  return APPROVAL_TABLE[isPermissionMode(mode) ? mode : 'ask'][action];
}

/** PERMISSION MODE line in the system prompt — always English (prompt ignores UI locale) */
export const MODE_PROMPT: Record<PermissionMode, string> = {
  plan: 'plan before editing. Only survey (repo tools) and fleet_dispatch with readonly:true. Code-changing dispatch, fleet_pipeline, fleet_merge and policy_promote are refused by the system — describe the plan and ask the user to switch mode to execute it.',
  ask: 'ask before changes. The user approves every code-changing dispatch/pipeline, merge, policy change and repo attach (the system shows the approval card when you call the tool).',
  auto: 'ask only when there is risk. Code-changing dispatch (isolated worktree) and repo attach run without asking; merge, policy changes and pipeline plan approval still ask the user.',
  full: 'fewer confirmations. No human confirmation is asked; merge gates (task ok, scope ok, tests pass) still apply. Report what you did.',
};
export const PLAN_BLOCKED = 'plan mode: describe the plan and ask the user to switch mode';
