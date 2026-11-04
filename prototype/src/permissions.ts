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
// Permission (how often to ask) and Plan (plan vs execute) are independent, like ZCode's mode + planEnabled:
// Plan only tightens — it blocks execution under ANY permission and never loosens one.
export const PERMISSION_MODES = ['ask', 'auto', 'full'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export type ApprovalAction = 'dispatch_write' | 'pipeline' | 'merge' | 'policy' | 'repo_attach' | 'plan_approval';
export type ApprovalNeed = 'block' | 'ask' | 'allow';
/** badge of the approval card in chat */
export type ApprovalKind = 'merge' | 'policy' | 'repo' | 'plan' | 'risk';
export const isPermissionMode = (v: unknown): v is PermissionMode => PERMISSION_MODES.includes(v as PermissionMode);

// ask: ask for every change · auto: ask only when risky · full: never ask (merge gate still runs)
const APPROVAL_TABLE: Record<PermissionMode, Record<ApprovalAction, ApprovalNeed>> = {
  ask: { dispatch_write: 'ask', pipeline: 'ask', merge: 'ask', policy: 'ask', repo_attach: 'ask', plan_approval: 'ask' },
  auto: { dispatch_write: 'allow', pipeline: 'allow', merge: 'ask', policy: 'ask', repo_attach: 'allow', plan_approval: 'ask' },
  full: { dispatch_write: 'allow', pipeline: 'allow', merge: 'allow', policy: 'allow', repo_attach: 'allow', plan_approval: 'allow' },
};
/** Plan on → execution actions are refused whatever the permission; repo_attach (read access) follows the permission */
const PLAN_BLOCKS: ReadonlySet<ApprovalAction> = new Set(['dispatch_write', 'pipeline', 'merge', 'policy']);
/** unknown/missing mode → 'ask' (safe) */
export function needsApproval(mode: unknown, action: ApprovalAction, plan = false): ApprovalNeed {
  if (plan && PLAN_BLOCKS.has(action)) return 'block';
  return APPROVAL_TABLE[isPermissionMode(mode) ? mode : 'ask'][action];
}

/** PERMISSION MODE line in the system prompt — always English (prompt ignores UI locale) */
export const MODE_PROMPT: Record<PermissionMode, string> = {
  ask: 'ask before changes. The user approves every code-changing dispatch/pipeline, merge, policy change and repo attach (the system shows the approval card when you call the tool).',
  auto: 'ask only when there is risk. Code-changing dispatch (isolated worktree) and repo attach run without asking; merge, policy changes and pipeline plan approval still ask the user.',
  full: 'fewer confirmations. No human confirmation is asked; merge gates (task ok, scope ok, tests pass) still apply. Report what you did.',
};
export const PLAN_BLOCKED = 'plan mode: describe the plan and ask the user to turn Plan off to execute it';

// ---------- Plan lives IN the conversation (ZCode runtime_mode / plan_mode_exit reminders) ----------
// Each user message sent with Plan on carries a <system-reminder> text block; the first message after Plan is
// turned off carries the exit reminder. Saved with the message → the brain (and a reopened session) knows which
// messages were plan-only vs. execution. Always English (prompt ignores UI locale).
const REMINDER_OPEN = '<system-reminder>';
const REMINDER_CLOSE = '</system-reminder>';
export const PLAN_REMINDER = {
  full: [
    'Plan mode is active. The user wants a plan, not execution — do NOT change anything yet. This supersedes other instructions about executing work.',
    'Allowed: repo_glob, repo_grep, repo_read, git_diff, task_diff, fleet_status, and fleet_dispatch with readonly:true to survey. Code-changing fleet_dispatch, fleet_pipeline, fleet_merge and policy_promote are refused by the system.',
    'Workflow: 1) Understand the request — survey the relevant code first and reuse existing patterns; ask the user when scope or approach is unclear. 2) Reply with ONE recommended plan: context (why), repos + glob scope to change, ordered steps, and how it will be verified. 3) End by asking the user to approve; the user turns Plan off to execute it.',
  ].join('\n'),
  sparse: 'Plan mode still active (full instructions earlier in the conversation). Survey and plan only — do not execute.',
  exit: 'Plan mode is now off. You may execute work under the PERMISSION MODE in the system prompt; if the user asks to proceed with a plan agreed earlier in this conversation, carry it out.',
} as const;
const PLAN_ON = [PLAN_REMINDER.full, PLAN_REMINDER.sparse];
export const systemReminder = (body: string) => `${REMINDER_OPEN}\n${body}\n${REMINDER_CLOSE}`;
/** a whole text block that is one injected reminder (display/memory/title skip it) */
// ponytail: a user who types an entire <system-reminder>…</system-reminder> message has it hidden on reload — harmless (tool layer enforces Plan), add a block marker if that ever matters
export const isSystemReminder = (text: string) => text.startsWith(REMINDER_OPEN) && text.trimEnd().endsWith(REMINDER_CLOSE);

type HistMsg = { role: string; content: string | { type: string; text?: string }[] };
/** Plan state of a conversation = last plan reminder in a user message (none / exit → off) */
export function planStateOf(history: readonly HistMsg[]): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role !== 'user' || typeof m.content === 'string') continue;
    for (const b of m.content) {
      if (b.type !== 'text' || typeof b.text !== 'string' || !isSystemReminder(b.text)) continue;
      const body = b.text.slice(REMINDER_OPEN.length, b.text.trimEnd().length - REMINDER_CLOSE.length).trim();
      if (body === PLAN_REMINDER.exit) return false;
      if (PLAN_ON.includes(body as (typeof PLAN_ON)[number])) return true;
    }
  }
  return false;
}
/** reminder for the next user message: entering Plan → full, staying → sparse, leaving → exit once, else none */
export function planReminder(wasPlan: boolean, plan: boolean): string | undefined {
  if (plan) return systemReminder(wasPlan ? PLAN_REMINDER.sparse : PLAN_REMINDER.full);
  return wasPlan ? systemReminder(PLAN_REMINDER.exit) : undefined;
}
