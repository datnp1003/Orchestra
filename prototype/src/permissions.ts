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

// ---------- Chat permission (Desktop) — enforced at the tool layer, not just the prompt ----------
// Two independent axes (ZCode: mode + planEnabled/goal):
//   permission (ask/auto/full) = how often Orchestra asks before acting
//   conversation mode (chat/plan/goal) = what the user's messages ARE — talk, plan, or a goal to complete
// A conversation mode only tightens: it refuses tools whatever the permission and never loosens one.
export const PERMISSION_MODES = ['ask', 'auto', 'full'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export type ApprovalAction = 'dispatch_read' | 'dispatch_write' | 'pipeline' | 'merge' | 'policy' | 'repo_attach' | 'plan_approval';
export type ApprovalNeed = 'block' | 'ask' | 'allow';
/** badge of the approval card in chat */
export type ApprovalKind = 'merge' | 'policy' | 'repo' | 'plan' | 'risk';
export const isPermissionMode = (v: unknown): v is PermissionMode => PERMISSION_MODES.includes(v as PermissionMode);

export const CONVERSATION_MODES = ['chat', 'plan', 'goal'] as const;
export type ConversationMode = (typeof CONVERSATION_MODES)[number];
export const isConversationMode = (v: unknown): v is ConversationMode => CONVERSATION_MODES.includes(v as ConversationMode);

// ask: ask for every change · auto: ask only when risky · full: never ask (merge gate still runs)
const APPROVAL_TABLE: Record<PermissionMode, Record<ApprovalAction, ApprovalNeed>> = {
  ask: { dispatch_read: 'allow', dispatch_write: 'ask', pipeline: 'ask', merge: 'ask', policy: 'ask', repo_attach: 'ask', plan_approval: 'ask' },
  auto: { dispatch_read: 'allow', dispatch_write: 'allow', pipeline: 'allow', merge: 'ask', policy: 'ask', repo_attach: 'allow', plan_approval: 'ask' },
  full: { dispatch_read: 'allow', dispatch_write: 'allow', pipeline: 'allow', merge: 'allow', policy: 'allow', repo_attach: 'allow', plan_approval: 'allow' },
};
/** refused by the conversation mode whatever the permission; repo_attach (read access) always follows the permission */
const CONV_BLOCKS: Record<ConversationMode, ReadonlySet<ApprovalAction>> = {
  chat: new Set(['dispatch_read', 'dispatch_write', 'pipeline', 'merge', 'policy']), // talk only — no worker is started
  plan: new Set(['dispatch_write', 'pipeline', 'merge', 'policy']), // read-only survey allowed
  goal: new Set(),
};
/** unknown/missing permission → 'ask', unknown/missing conversation mode → none (safe: permission still applies) */
export function needsApproval(mode: unknown, action: ApprovalAction, conv?: unknown): ApprovalNeed {
  if (isConversationMode(conv) && CONV_BLOCKS[conv].has(action)) return 'block';
  return APPROVAL_TABLE[isPermissionMode(mode) ? mode : 'ask'][action];
}

/** PERMISSION MODE line in the system prompt — always English (prompt ignores UI locale) */
export const MODE_PROMPT: Record<PermissionMode, string> = {
  ask: 'ask before changes. The user approves every code-changing dispatch/pipeline, merge, policy change and repo attach (the system shows the approval card when you call the tool).',
  auto: 'ask only when there is risk. Code-changing dispatch (isolated worktree) and repo attach run without asking; merge, policy changes and pipeline plan approval still ask the user.',
  full: 'fewer confirmations. No human confirmation is asked; merge gates (task ok, scope ok, tests pass) still apply. Report what you did.',
};
/** tool result when the conversation mode refuses a tool */
export const CONV_BLOCKED: Record<ConversationMode, string> = {
  chat: 'chat mode: talk only — no work is started. Answer, or suggest the user switch to Plan or Goal mode',
  plan: 'plan mode: describe the plan and ask the user to switch to Goal mode to execute it',
  goal: '',
};

// ---------- Conversation mode lives IN the conversation (ZCode runtime_mode reminders) ----------
// Every user message carries a <system-reminder> text block naming the mode it was sent in: full text when the mode
// changes (or on the first message), a short one while it stays. Saved with the message → the brain (and a reopened
// session) knows which messages were talk, plan or goal. Always English (prompt ignores UI locale).
const REMINDER_OPEN = '<system-reminder>';
const REMINDER_CLOSE = '</system-reminder>';
const HEAD = 'Conversation mode: ';
export const CONV_REMINDER: Record<ConversationMode, { full: string; sparse: string }> = {
  chat: {
    full: [
      `${HEAD}chat. The user is talking with you — answer, discuss, explain, give opinions. This message is NOT a work order.`,
      'Do not start work: fleet_dispatch (even readonly), fleet_pipeline, fleet_merge and policy_promote are refused by the system. You may read (repo_glob, repo_grep, repo_read, git_diff, task_diff, fleet_status) to answer accurately, and save memory.',
      'If the user asks for something to be built or changed, say briefly what you would do and suggest switching to Plan mode (plan it) or Goal mode (do it).',
    ].join('\n'),
    sparse: `${HEAD}chat (unchanged). Talk only — do not start work.`,
  },
  plan: {
    full: [
      `${HEAD}plan. The user wants a plan, not execution — do NOT change anything yet. This supersedes other instructions about executing work.`,
      'Allowed: repo_glob, repo_grep, repo_read, git_diff, task_diff, fleet_status, and fleet_dispatch with readonly:true to survey. Code-changing fleet_dispatch, fleet_pipeline, fleet_merge and policy_promote are refused by the system.',
      'Workflow: 1) Understand the request — survey the relevant code first and reuse existing patterns; ask the user when scope or approach is unclear. 2) Reply with ONE recommended plan: context (why), repos + glob scope to change, ordered steps, and how it will be verified. 3) End by asking the user to approve; the user switches to Goal mode to execute it.',
    ].join('\n'),
    sparse: `${HEAD}plan (unchanged). Survey and plan only — do not execute.`,
  },
  goal: {
    full: [
      `${HEAD}goal. The user's message is a goal to complete — execute it under the PERMISSION MODE in the system prompt. If a plan was agreed earlier in this conversation, carry it out.`,
      'Work until the goal is done: survey, dispatch workers with explicit scope, read task_diff, merge per the permission mode, and fix failures by dispatching again. Stop early only to ask the user when a requirement is genuinely unclear or an approval was rejected.',
      'Before your final reply, verify the result against the goal (diff, tests, acceptance) and end with one line: `GOAL: done` or `GOAL: not done — <what is missing>`.',
    ].join('\n'),
    sparse: `${HEAD}goal (unchanged). Keep working until the goal is verified done; end with the GOAL: line.`,
  },
};
export const systemReminder = (body: string) => `${REMINDER_OPEN}\n${body}\n${REMINDER_CLOSE}`;
/** a whole text block that is one injected reminder (display/memory/title skip it) */
// ponytail: a user who types an entire <system-reminder>…</system-reminder> message has it hidden on reload — harmless (tool layer enforces the mode), add a block marker if that ever matters
export const isSystemReminder = (text: string) => text.startsWith(REMINDER_OPEN) && text.trimEnd().endsWith(REMINDER_CLOSE);

type HistMsg = { role: string; content: string | { type: string; text?: string }[] };
/** mode named by the last conversation-mode reminder in a user message; null = none yet */
export function convModeOf(history: readonly HistMsg[]): ConversationMode | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role !== 'user' || typeof m.content === 'string') continue;
    for (const b of m.content) {
      if (b.type !== 'text' || typeof b.text !== 'string' || !isSystemReminder(b.text)) continue;
      const mode = /^Conversation mode: (\w+)/.exec(b.text.slice(REMINDER_OPEN.length).trimStart())?.[1];
      if (isConversationMode(mode)) return mode;
    }
  }
  return null;
}
/** images attached to this message, saved as files — the brain passes these ids to fleet_dispatch.images */
export const imagesReminder = (ids: string[]) =>
  systemReminder(`Images attached to this message are saved as ${ids.join(', ')}. When a worker must see them (UI mockup, screenshot, diagram), pass these ids in fleet_dispatch.images — workers cannot see this conversation, and your text description alone loses visual detail. Still state in goal/acceptance what to change in the image.`);
/** files attached to this message — readable via attachment_read, handed to workers via fleet_dispatch.files */
export const filesReminder = (ids: string[]) =>
  systemReminder(`Files attached to this message: ${ids.join(', ')} (contents in the <attachment> blocks below). Long text is truncated — attachment_read reads on (and opens files inside a zip). Workers cannot see this conversation: when a worker needs a file, pass its id in fleet_dispatch.files — it gets the original plus extracted text (.txt next to Office files) and unpacked zips under .orchestra/files/<id>/.`);
/** reminder for the next user message: mode changed (or first message) → full, unchanged → sparse */
export const convReminder = (prev: ConversationMode | null, mode: ConversationMode) =>
  systemReminder(prev === mode ? CONV_REMINDER[mode].sparse : CONV_REMINDER[mode].full);
