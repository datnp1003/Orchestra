// needsApproval: permission mode × action table (Desktop chat)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsApproval, PERMISSION_MODES, MODE_PROMPT, isPermissionMode, CONVERSATION_MODES, convReminder, convModeOf, isSystemReminder, CONV_REMINDER } from '../dist/permissions.js';

test('needsApproval: mode × action table; unknown mode → ask', () => {
  const actions = ['dispatch_read', 'dispatch_write', 'pipeline', 'merge', 'policy', 'repo_attach', 'plan_approval'];
  const want = {
    ask: ['allow', 'ask', 'ask', 'ask', 'ask', 'ask', 'ask'],
    auto: ['allow', 'allow', 'allow', 'ask', 'ask', 'allow', 'ask'],
    full: ['allow', 'allow', 'allow', 'allow', 'allow', 'allow', 'allow'],
  };
  assert.deepEqual([...PERMISSION_MODES], Object.keys(want));
  for (const m of PERMISSION_MODES) assert.deepEqual(actions.map((a) => needsApproval(m, a)), want[m], m);
  assert.equal(needsApproval('bogus', 'merge'), 'ask');
  assert.equal(needsApproval(undefined, 'dispatch_write'), 'ask');
  assert.ok(PERMISSION_MODES.every((m) => MODE_PROMPT[m].length > 20));
  assert.deepEqual(['ask', 'x', null, 'plan'].map(isPermissionMode), [true, false, false, false], 'plan is no longer a permission');
});

test('conversation mode is independent of permission: chat refuses all work, plan refuses execution, goal adds nothing', () => {
  const exec = ['dispatch_write', 'pipeline', 'merge', 'policy'];
  assert.deepEqual([...CONVERSATION_MODES], ['chat', 'plan', 'goal']);
  for (const m of PERMISSION_MODES) {
    for (const a of exec) {
      assert.equal(needsApproval(m, a, 'chat'), 'block', `${m}+chat ${a}`);
      assert.equal(needsApproval(m, a, 'plan'), 'block', `${m}+plan ${a}`);
      assert.equal(needsApproval(m, a, 'goal'), needsApproval(m, a), `${m}+goal ${a} = permission`);
    }
    assert.equal(needsApproval(m, 'dispatch_read', 'chat'), 'block', 'chat starts no worker, even read-only');
    assert.equal(needsApproval(m, 'dispatch_read', 'plan'), 'allow', 'plan may survey with read-only workers');
    for (const c of CONVERSATION_MODES) assert.equal(needsApproval(m, 'repo_attach', c), needsApproval(m, 'repo_attach'), `${m}+${c} repo_attach follows permission`);
  }
  assert.equal(needsApproval('full', 'merge', 'bogus'), 'allow', 'unknown conversation mode adds no limit (permission still applies)');
});

test('conversation mode reminder lives in the conversation: full on change / first message, sparse while unchanged', () => {
  const u = (...texts) => ({ role: 'user', content: texts.map((text) => ({ type: 'text', text })) });
  for (const c of CONVERSATION_MODES) {
    const full = convReminder(null, c);
    assert.ok(isSystemReminder(full) && full.includes(CONV_REMINDER[c].full), `${c} first → full`);
    assert.ok(convReminder(c, c).includes(CONV_REMINDER[c].sparse), `${c} unchanged → sparse`);
    assert.equal(convModeOf([u(full, 'x')]), c);
    assert.equal(convModeOf([u(convReminder(c, c), 'x')]), c, 'sparse names the mode too');
  }
  assert.ok(convReminder('chat', 'goal').includes(CONV_REMINDER.goal.full), 'change → full');
  assert.equal(convModeOf([]), null);
  assert.equal(convModeOf([u(convReminder(null, 'plan'), 'a'), { role: 'assistant', content: 'p' }, u(convReminder('plan', 'goal'), 'go')]), 'goal', 'latest wins');
  assert.equal(convModeOf([u(convReminder(null, 'goal'), 'a'), { role: 'user', content: 'plain string turn' }, u('tool result only')]), 'goal', 'turns without reminder keep the mode');
  assert.equal(convModeOf([u('<system-reminder>\nsomething else\n</system-reminder>', 'x')]), null, 'unrelated reminder ignored');
  assert.equal(isSystemReminder('hello <system-reminder>'), false);
});
