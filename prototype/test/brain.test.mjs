// M1: Orchestra brain agent loop — fake fetch, no real network
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBrainTurn, listBrainModels, callBrainText } from '../dist/brain.js';
import { t } from '../dist/i18n/index.js';

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
const toolUse = (id) => ({ body: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'working' }, { type: 'tool_use', id, name: 'dummy', input: { x: 1 } }] } });

test('tool_use → tool_result sent back → end_turn', async () => {
  const { fn, calls } = fakeFetch([toolUse('tu_1'), { body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'xong' }] } }]);
  const steps = [];
  const executed = [];
  const r = await runBrainTurn({
    baseUrl: 'https://gw.test/', apiKey: KEY, history: [], userText: 'do it', model: 'worker-claude', system: 'sys', tools: TOOLS,
    execTool: async (name, input) => (executed.push([name, input]), { ok: false, content: 'fake error' }),
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
  assert.deepEqual(last.content, [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'fake error', is_error: true }]);
  assert.deepEqual(steps.map((s) => s.kind), ['text', 'tool_call', 'tool_result']);
  assert.equal(r.history.length, 4); // user, assistant(tool_use), user(tool_result), assistant(text)
  assert.ok(!JSON.stringify(r.history).includes(KEY));
});

test('images: sent and saved as image blocks after the reminder, before the text; image-only message allowed', async () => {
  const img = { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' };
  const run = async (o) => {
    const { fn, calls } = fakeFetch([{ body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } }]);
    const r = await runBrainTurn({ baseUrl: 'https://gw.test/', apiKey: KEY, history: [], model: 'm', system: 's', tools: TOOLS, execTool: async () => ({ ok: true, content: '' }), fetchImpl: fn, ...o });
    assert.deepEqual(calls[0].body.messages[0], r.history[0], 'sent = saved');
    return r.history[0].content;
  };
  assert.deepEqual(await run({ userText: 'what is this', reminder: 'R', images: [img] }), [{ type: 'text', text: 'R' }, { type: 'image', source: img }, { type: 'text', text: 'what is this' }]);
  assert.deepEqual(await run({ userText: '', images: [img] }), [{ type: 'image', source: img }]);
  assert.equal(await run({ userText: 'plain' }), 'plain', 'no reminder/images → plain string');
  const doc = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERg==' }, title: 'a.pdf' };
  assert.deepEqual(await run({ userText: 'tóm tắt', images: [img], attachments: [doc, { type: 'text', text: '<attachment id="file-1">…</attachment>' }] }),
    [{ type: 'image', source: img }, doc, { type: 'text', text: '<attachment id="file-1">…</attachment>' }, { type: 'text', text: 'tóm tắt' }], 'images, then files, then the text');
  assert.deepEqual(await run({ userText: 'x', reminder: ['A', 'B'] }), [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }, { type: 'text', text: 'x' }], 'several reminders in order');
});

test('reminder: sent and saved in the SAME user message, before the user text', async () => {
  const { fn, calls } = fakeFetch([{ body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'plan' }] } }]);
  const reminder = '<system-reminder>\nPlan mode is active.\n</system-reminder>';
  const r = await runBrainTurn({ baseUrl: 'https://gw.test/', apiKey: KEY, history: [], userText: 'add X', reminder, model: 'm', system: 's', tools: TOOLS, execTool: async () => ({ ok: true, content: '' }), fetchImpl: fn });
  const want = { role: 'user', content: [{ type: 'text', text: reminder }, { type: 'text', text: 'add X' }] };
  assert.deepEqual(calls[0].body.messages, [want]);
  assert.deepEqual(r.history[0], want);
});

test('maxTurns cap', async () => {
  const { fn, calls } = fakeFetch([toolUse('tu_x')]);
  const r = await runBrainTurn({
    baseUrl: 'https://gw.test', apiKey: KEY, history: [], userText: 'loop', model: 'm', system: 's', tools: TOOLS,
    execTool: async () => ({ ok: true, content: 'x'.repeat(30_000) }), maxTurns: 3, fetchImpl: fn,
  });
  assert.equal(calls.length, 3);
  assert.equal(r.text, t('brain.turnCap', { n: 3 }));
  assert.ok(calls[2].body.messages.at(-1).content[0].content.length < 21_000, 'tool_result truncated to ~20k');
  assert.equal(r.history.at(-1).role, 'assistant');
});

test('HTTP 500 → throw, key not leaked', async () => {
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

test('abort mid-tool → valid history (every tool_use has tool_result, ends with assistant)', async () => {
  const two = { body: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'a', name: 'dummy', input: {} }, { type: 'tool_use', id: 'b', name: 'dummy', input: {} }] } };
  const { fn, calls } = fakeFetch([two]);
  const ac = new AbortController();
  const r = await runBrainTurn({
    baseUrl: 'https://gw.test', apiKey: KEY, history: [], userText: 'x', model: 'm', system: 's', tools: TOOLS, signal: ac.signal, fetchImpl: fn,
    execTool: (_n, _i) => new Promise((res) => {
      ac.signal.addEventListener('abort', () => res({ ok: false, content: 'killed' }));
      setTimeout(() => ac.abort(), 20);
    }),
  });
  assert.equal(r.aborted, true);
  assert.equal(calls.length, 1, 'no further API call after abort');
  const h = r.history;
  assert.deepEqual(h.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.deepEqual(h[2].content.map((b) => [b.tool_use_id, b.is_error]), [['a', true], ['b', true]]);
  assert.equal(h[2].content[1].content, 'aborted');
  assert.equal(h[3].content[0].text, t('brain.aborted'));
  // abort before the API call → fetch rejects → still returns valid history
  const ac2 = new AbortController();
  ac2.abort();
  const r2 = await runBrainTurn({
    baseUrl: 'https://gw.test', apiKey: KEY, history: [], userText: 'x', model: 'm', system: 's', tools: TOOLS, signal: ac2.signal,
    fetchImpl: async () => { throw new DOMException('aborted', 'AbortError'); }, execTool: async () => ({ ok: true, content: '' }),
  });
  assert.equal(r2.aborted, true);
  assert.deepEqual(r2.history.map((m) => m.role), ['user', 'assistant']);
});

test('listBrainModels: ok + error', async () => {
  const ok = fakeFetch([{ body: { data: [{ id: 'worker-claude' }, { id: 'cc/claude-sonnet-5-5' }, {}] } }]);
  assert.deepEqual(await listBrainModels({ baseUrl: 'https://gw.test/v1', apiKey: KEY }, ok.fn), { models: ['worker-claude', 'cc/claude-sonnet-5-5'] });
  assert.equal(ok.calls[0].url, 'https://gw.test/v1/models');
  const bad = fakeFetch([{ status: 401, body: 'nope' }]);
  const r = await listBrainModels({ baseUrl: 'https://gw.test', apiKey: KEY }, bad.fn);
  assert.deepEqual(r.models, []);
  assert.match(r.error, /HTTP 401/);
});

// reasoning boundary: leading reasoning envelopes never reach display/history/tools (synthetic sentinel only)
const SENT = 'PRIVATE_SENTINEL';
const LEAK_TEXT = `antml:thinking_mode\n${SENT} plan steps.Câu trả lời`;
const final = (content) => ({ body: { stop_reason: 'end_turn', content } });
const turn = (fn, extra = {}) => {
  const steps = [];
  const executed = [];
  const p = runBrainTurn({
    baseUrl: 'https://gw.test', apiKey: KEY, history: [], userText: 'hi', model: 'm', system: 's', tools: TOOLS,
    execTool: async (n, i) => (executed.push([n, i]), { ok: true, content: 'done' }), onStep: (s) => steps.push(s), fetchImpl: fn, ...extra,
  });
  return { p, steps, executed };
};
const failsClosed = (err) => {
  assert.equal(err.message, t('brain.reasoningLeak'));
  assert.ok(!err.message.includes(SENT));
  return true;
};

test('reasoning: bare marker in final reply → localized error, nothing leaked', async () => {
  const { fn } = fakeFetch([final([{ type: 'text', text: LEAK_TEXT }])]);
  const { p, steps } = turn(fn);
  await assert.rejects(p, failsClosed);
  assert.ok(!JSON.stringify(steps).includes(SENT));
});

test('reasoning: bare marker / unclosed envelope in tool turn → no step, no tool executed', async () => {
  for (const text of [LEAK_TEXT, `<thinking>${SENT} never closed`, `  <think>${SENT}`, `<analysis>${SENT}`]) {
    const { fn, calls } = fakeFetch([{ body: { stop_reason: 'tool_use', content: [{ type: 'text', text }, { type: 'tool_use', id: 'x', name: 'dummy', input: {} }] } }]);
    const { p, steps, executed } = turn(fn);
    await assert.rejects(p, failsClosed);
    assert.deepEqual([steps, executed, calls.length], [[], [], 1]);
  }
});

test('reasoning: typed thinking/redacted_thinking/reasoning blocks never stored or replayed', async () => {
  const { fn, calls } = fakeFetch([
    { body: { stop_reason: 'tool_use', content: [
      { type: 'thinking', thinking: SENT, signature: 'sig' }, { type: 'redacted_thinking', data: SENT }, { type: 'reasoning', text: SENT },
      { type: 'text', text: 'working' }, { type: 'tool_use', id: 't', name: 'dummy', input: {} },
    ] } },
    final([{ type: 'thinking', thinking: SENT }, { type: 'text', text: 'xong' }]),
  ]);
  const { p, steps, executed } = turn(fn);
  const r = await p;
  assert.equal(r.text, 'xong');
  assert.equal(executed.length, 1);
  assert.deepEqual(r.history[1].content.map((b) => b.type), ['text', 'tool_use']);
  assert.ok(!JSON.stringify([r.history, steps, calls[1].body.messages]).includes(SENT));
});

test('reasoning: closed leading envelope stripped, answer kept', async () => {
  const { fn, calls } = fakeFetch([
    { body: { stop_reason: 'tool_use', content: [{ type: 'text', text: `<think>${SENT}</think>\n\nKhảo sát` }, { type: 'tool_use', id: 't', name: 'dummy', input: {} }] } },
    final([{ type: 'text', text: `<analysis>${SENT}</analysis><thinking>${SENT}</thinking>Xin chào` }]),
  ]);
  const { p, steps } = turn(fn);
  const r = await p;
  assert.equal(r.text, 'Xin chào');
  assert.deepEqual(steps[0], { kind: 'text', text: 'Khảo sát' });
  assert.ok(!JSON.stringify([r.history, steps, calls[1].body.messages]).includes(SENT));
});

test('reasoning: ordinary text mentioning <think> stays intact', async () => {
  for (const text of ['Use `<think>` tags like <think>x</think> in prompts', 'Thinking about it: yes', 'analysis: done', '```\n<think>\n```', 'The antml:thinking_mode marker']) {
    const { fn } = fakeFetch([final([{ type: 'text', text }])]);
    assert.equal((await turn(fn).p).text, text);
  }
});

test('reasoning: leaked prior assistant history is not replayed', async () => {
  const { fn, calls } = fakeFetch([final([{ type: 'text', text: 'ok' }])]);
  const history = [{ role: 'user', content: 'q' }, { role: 'assistant', content: [{ type: 'thinking', thinking: SENT }, { type: 'text', text: LEAK_TEXT }] }];
  await turn(fn, { history }).p;
  const sent = calls[0].body.messages;
  assert.deepEqual(sent.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.ok(!JSON.stringify(sent).includes(SENT));
});

test('reasoning: callBrainText strips closed envelope, drops typed thinking, fails closed on bare marker', async () => {
  const c = (content) => ({ baseUrl: 'https://gw.test', apiKey: KEY, model: 'm', fetchImpl: fakeFetch([final(content)]).fn });
  assert.equal(await callBrainText(c([{ type: 'thinking', thinking: SENT }, { type: 'text', text: `<think>${SENT}</think>- fact` }]), 's', 'u'), '- fact');
  await assert.rejects(callBrainText(c([{ type: 'text', text: LEAK_TEXT }]), 's', 'u'), failsClosed);
});
