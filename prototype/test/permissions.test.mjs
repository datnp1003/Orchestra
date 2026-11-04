// needsApproval: permission mode × action table (Desktop chat)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsApproval, PERMISSION_MODES, MODE_PROMPT, isPermissionMode, planReminder, planStateOf, isSystemReminder, PLAN_REMINDER } from '../dist/permissions.js';

test('needsApproval: mode × action table; unknown mode → ask', () => {
  const actions = ['dispatch_write', 'pipeline', 'merge', 'policy', 'repo_attach', 'plan_approval'];
  const want = {
    ask: ['ask', 'ask', 'ask', 'ask', 'ask', 'ask'],
    auto: ['allow', 'allow', 'ask', 'ask', 'allow', 'ask'],
    full: ['allow', 'allow', 'allow', 'allow', 'allow', 'allow'],
  };
  assert.deepEqual([...PERMISSION_MODES], Object.keys(want));
  for (const m of PERMISSION_MODES) assert.deepEqual(actions.map((a) => needsApproval(m, a)), want[m], m);
  assert.equal(needsApproval('bogus', 'merge'), 'ask');
  assert.equal(needsApproval(undefined, 'dispatch_write'), 'ask');
  assert.ok(PERMISSION_MODES.every((m) => MODE_PROMPT[m].length > 20));
  assert.deepEqual(['ask', 'x', null, 'plan'].map(isPermissionMode), [true, false, false, false], 'plan is no longer a permission');
});

test('Plan is independent of permission: blocks execution under every permission, never loosens', () => {
  for (const m of PERMISSION_MODES) {
    for (const a of ['dispatch_write', 'pipeline', 'merge', 'policy']) assert.equal(needsApproval(m, a, true), 'block', `${m}+plan ${a}`);
    for (const a of ['repo_attach', 'plan_approval']) assert.equal(needsApproval(m, a, true), needsApproval(m, a), `${m}+plan ${a} follows permission`);
  }
});

test('Plan reminder lives in the conversation: full on entry, sparse while on, exit once, none otherwise', () => {
  const u = (...texts) => ({ role: 'user', content: texts.map((text) => ({ type: 'text', text })) });
  assert.equal(planReminder(false, false), undefined);
  const full = planReminder(false, true);
  assert.ok(isSystemReminder(full) && full.includes(PLAN_REMINDER.full));
  assert.ok(planReminder(true, true).includes(PLAN_REMINDER.sparse));
  assert.ok(planReminder(true, false).includes(PLAN_REMINDER.exit));
  assert.equal(planStateOf([]), false);
  assert.equal(planStateOf([u(full, 'plan it'), { role: 'assistant', content: 'plan…' }]), true);
  assert.equal(planStateOf([u(full, 'a'), u(planReminder(true, false), 'go')]), false, 'exit reminder turns it off');
  assert.equal(planStateOf([u(full, 'a'), { role: 'user', content: 'plain string turn' }, u('tool result only')]), true, 'later turns without reminder keep the state');
  assert.equal(planStateOf([u('<system-reminder>\nsomething else\n</system-reminder>', 'x')]), false, 'unrelated reminder ignored');
  assert.equal(isSystemReminder('hello <system-reminder>'), false);
});
