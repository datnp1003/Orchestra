// needsApproval: permission mode × action table (Desktop chat)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsApproval, PERMISSION_MODES, MODE_PROMPT, isPermissionMode } from '../dist/permissions.js';

test('needsApproval: mode × action table; unknown mode → ask', () => {
  const actions = ['dispatch_write', 'pipeline', 'merge', 'policy', 'repo_attach', 'plan_approval'];
  const want = {
    plan: ['block', 'block', 'block', 'block', 'ask', 'ask'],
    ask: ['ask', 'ask', 'ask', 'ask', 'ask', 'ask'],
    auto: ['allow', 'allow', 'ask', 'ask', 'allow', 'ask'],
    full: ['allow', 'allow', 'allow', 'allow', 'allow', 'allow'],
  };
  assert.deepEqual([...PERMISSION_MODES], Object.keys(want));
  for (const m of PERMISSION_MODES) assert.deepEqual(actions.map((a) => needsApproval(m, a)), want[m], m);
  assert.equal(needsApproval('bogus', 'merge'), 'ask');
  assert.equal(needsApproval(undefined, 'dispatch_write'), 'ask');
  assert.ok(PERMISSION_MODES.every((m) => MODE_PROMPT[m].length > 20));
  assert.deepEqual(['ask', 'x', null].map(isPermissionMode), [true, false, false]);
});
