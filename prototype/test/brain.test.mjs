// M1: agent loop của Orchestra brain — fake fetch, không mạng thật
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBrainTurn, listBrainModels } from '../dist/brain.js';

const KEY = 'SECRET-123';
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
  };
  return { fn, calls };
}
const TOOLS = [{ name: 'dummy', description: 'd', input_schema: { type: 'object', properties: {} } }];
const toolUse = (id) => ({ body: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'đang làm' }, { type: 'tool_use', id, name: 'dummy', input: { x: 1 } }] } });

test('tool_use → tool_result gửi lại → end_turn', async () => {
  const { fn, calls } = fakeFetch([toolUse('tu_1'), { body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'xong' }] } }]);
  const steps = [];
  const executed = [];
  const r = await runBrainTurn({
    baseUrl: 'https://gw.test/', apiKey: KEY, history: [], userText: 'làm đi', model: 'worker-claude', system: 'sys', tools: TOOLS,
    execTool: async (name, input) => (executed.push([name, input]), { ok: false, content: 'lỗi giả' }),
    onStep: (s) => steps.push(s), fetchImpl: fn,
  });
  assert.equal(r.text, 'xong');
  assert.deepEqual(executed, [['dummy', { x: 1 }]]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://gw.test/v1/messages');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`);
  for (const c of calls) {
    assert.equal(c.body.stream, false);
    assert.deepEqual(c.body.tools, TOOLS);
    assert.equal(c.body.system, 'sys');
  }
  const last = calls[1].body.messages.at(-1);
  assert.equal(last.role, 'user');
  assert.deepEqual(last.content, [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'lỗi giả', is_error: true }]);
  assert.deepEqual(steps.map((s) => s.kind), ['text', 'tool_call', 'tool_result']);
  assert.equal(r.history.length, 4); // user, assistant(tool_use), user(tool_result), assistant(text)
  assert.ok(!JSON.stringify(r.history).includes(KEY));
});

test('maxTurns cap', async () => {
  const { fn, calls } = fakeFetch([toolUse('tu_x')]);
  const r = await runBrainTurn({
    baseUrl: 'https://gw.test', apiKey: KEY, history: [], userText: 'loop', model: 'm', system: 's', tools: TOOLS,
    execTool: async () => ({ ok: true, content: 'x'.repeat(30_000) }), maxTurns: 3, fetchImpl: fn,
  });
  assert.equal(calls.length, 3);
  assert.match(r.text, /chạm trần 3 lượt/);
  assert.ok(calls[2].body.messages.at(-1).content[0].content.length < 21_000, 'tool_result bị cắt ~20k');
  assert.equal(r.history.at(-1).role, 'assistant');
});

test('HTTP 500 → throw, không lộ key', async () => {
  const { fn } = fakeFetch([{ status: 500, body: `boom auth=${KEY} ` + 'y'.repeat(500) }]);
  await assert.rejects(
    runBrainTurn({ baseUrl: 'https://gw.test', apiKey: KEY, history: [], userText: 'x', model: 'm', system: 's', tools: [], execTool: async () => ({ ok: true, content: '' }), fetchImpl: fn }),
    (err) => {
      assert.match(err.message, /HTTP 500/);
      assert.ok(!err.message.includes(KEY), err.message);
      assert.ok(err.message.length < 260);
      return true;
    },
  );
});

test('non-JSON → throw', async () => {
  const { fn } = fakeFetch([{ body: '<html>gateway</html>' }]);
  await assert.rejects(
    runBrainTurn({ baseUrl: 'https://gw.test', apiKey: KEY, history: [], userText: 'x', model: 'm', system: 's', tools: [], execTool: async () => ({ ok: true, content: '' }), fetchImpl: fn }),
    /non-JSON: <html>/,
  );
});

test('listBrainModels: ok + lỗi', async () => {
  const ok = fakeFetch([{ body: { data: [{ id: 'worker-claude' }, { id: 'cc/claude-sonnet-5-5' }, {}] } }]);
  assert.deepEqual(await listBrainModels({ baseUrl: 'https://gw.test/v1', apiKey: KEY }, ok.fn), { models: ['worker-claude', 'cc/claude-sonnet-5-5'] });
  assert.equal(ok.calls[0].url, 'https://gw.test/v1/models');
  const bad = fakeFetch([{ status: 401, body: 'nope' }]);
  const r = await listBrainModels({ baseUrl: 'https://gw.test', apiKey: KEY }, bad.fn);
  assert.deepEqual(r.models, []);
  assert.match(r.error, /HTTP 401/);
});
