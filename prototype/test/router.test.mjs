// Router R1 — fake upstream 127.0.0.1, không mạng ngoài, không DPAPI (keyFor inject)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRouter } from '../dist/router/server.js';
import { createProviderStore, normalizeProvider, authHeaders } from '../dist/router/providers.js';
import { messagesToChatRequest, chatToMessagesRequest, ChatToMessagesStream, MessagesToChatStream, responsesToChatRequest, ChatToResponsesStream } from '../dist/router/translate.js';

const TOKEN = 'a'.repeat(64);
const ANT_SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-x","usage":{"input_tokens":7,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_9","name":"calc","input":{}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"1}"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join('');
const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const OAI_SSE = [
  chunk({ role: 'assistant', content: '' }),
  chunk({ content: 'Hi ' }),
  chunk({ content: 'there' }),
  chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'calc', arguments: '' } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: '{"x": [1,' } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: ' 2], "y": "z"}' } }] }),
  chunk({ tool_calls: [{ index: 1, id: 'call_2', type: 'function', function: { name: 'echo', arguments: '{}' } }] }),
  chunk({}, 'tool_calls'),
  `data: ${JSON.stringify({ id: 'c1', choices: [], usage: { prompt_tokens: 11, completion_tokens: 4 } })}\n\n`,
  'data: [DONE]\n\n',
].join('');

function fakeUpstream(handler) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, seen, url: `http://127.0.0.1:${srv.address().port}` })));
}
const json = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

let ant, oai, router, router2, dir;
const last = (up) => up.seen.at(-1);

before(async () => {
  ant = await fakeUpstream((req, res, body) => {
    if (req.url === '/v1/models') return json(res, 200, { data: [{ id: 'claude-x' }] });
    if (body?.model === 'rate') return json(res, 429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } });
    if (body?.stream) return res.writeHead(200, { 'content-type': 'text/event-stream' }).end(ANT_SSE);
    json(res, 200, { id: 'msg_2', type: 'message', model: body.model, content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'tu_1', name: 'calc', input: { a: 1 } }], stop_reason: 'tool_use', usage: { input_tokens: 3, output_tokens: 2 } });
  });
  oai = await fakeUpstream((req, res, body) => {
    if (req.url === '/v1/models') return json(res, 200, { data: [{ id: 'gpt-x' }, { id: 'org/m' }] });
    if (body?.stream) return res.writeHead(200, { 'content-type': 'text/event-stream' }).end(OAI_SSE);
    json(res, 200, { id: 'c2', model: body.model, choices: [{ message: { role: 'assistant', content: 'dùng tool', tool_calls: [{ id: 'call_7', type: 'function', function: { name: 'calc', arguments: '{"n":2}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 9, completion_tokens: 3 } });
  });
  dir = mkdtempSync(path.join(os.tmpdir(), 'orch-router-'));
  const file = path.join(dir, 'router.json');
  writeFileSync(file, JSON.stringify({ providers: [
    { id: 'ant', kind: 'anthropic', baseUrl: `${ant.url}/v1/` },
    { id: 'antc', kind: 'anthropic-compatible', baseUrl: ant.url },
    { id: 'oai', kind: 'openai-compatible', baseUrl: oai.url },
    { id: 'dead', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1' },
    { id: 'off', kind: 'openai', baseUrl: oai.url, enabled: false },
  ] }));
  const store = createProviderStore({ file, keyFor: (id) => `KEY-${id}` });
  router = await startRouter({ store, token: TOKEN, defaultModel: 'ant/claude-x' });
  router2 = await startRouter({ store });
});
after(async () => {
  await router.close();
  await router2.close();
  ant.srv.close();
  oai.srv.close();
});

function call(p, { method = 'POST', body, headers = {}, r = router } = {}) {
  return new Promise((ok, fail) => {
    const req = http.request({ host: '127.0.0.1', port: r.port, path: p, method, headers: { authorization: `Bearer ${r.token}`, 'content-type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on('error', fail);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const sseEvents = (text) => text.split('\n').filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]').map((l) => JSON.parse(l.slice(6)));
const MSG = { max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] };

test('auth: thiếu/sai token → 401, x-api-key đúng → qua; Host lạ → 403', async () => {
  assert.equal((await call('/v1/models', { method: 'GET', headers: { authorization: '' } })).status, 401);
  assert.equal((await call('/v1/models', { method: 'GET', headers: { authorization: 'Bearer nope' } })).status, 401);
  assert.equal((await call('/v1/models', { method: 'GET', headers: { authorization: '', 'x-api-key': TOKEN } })).status, 200);
  assert.equal((await call('/v1/models', { method: 'GET', headers: { host: 'evil.test' } })).status, 403);
  assert.equal(router2.token.length, 64);
  assert.notEqual(router2.token, TOKEN);
});

test('/v1/models: union có prefix, provider chết → header lỗi, disabled bị bỏ', async () => {
  const r = await call('/v1/models', { method: 'GET' });
  assert.equal(r.status, 200);
  const ids = r.json().data.map((m) => m.id).sort();
  assert.deepEqual(ids, ['ant/claude-x', 'antc/claude-x', 'oai/gpt-x', 'oai/org/m']);
  assert.equal(r.json().data.find((m) => m.id === 'oai/gpt-x').owned_by, 'oai');
  assert.equal(r.headers['x-orchestra-model-errors'], '1');
});

test('passthrough messages → anthropic: giữ ?beta=true, rewrite model, x-api-key, không lộ token', async () => {
  const r = await call('/v1/messages?beta=true', { body: { ...MSG, model: 'ant/claude-x' }, headers: { 'anthropic-beta': 'b1', 'x-api-key': TOKEN } });
  assert.equal(r.status, 200);
  assert.equal(r.json().content[0].text, 'ok');
  const s = last(ant);
  assert.equal(s.url, '/v1/messages?beta=true');
  assert.equal(s.body.model, 'claude-x');
  assert.equal(s.headers['x-api-key'], 'KEY-ant');
  assert.equal(s.headers.authorization, undefined);
  assert.equal(s.headers['anthropic-beta'], 'b1');
  assert.ok(!JSON.stringify(s.headers).includes(TOKEN));

  await call('/v1/messages', { body: { ...MSG, model: 'antc/claude-x' } });
  assert.equal(last(ant).headers.authorization, 'Bearer KEY-antc');
  assert.equal(last(ant).headers['x-api-key'], undefined);
  assert.equal(last(ant).headers['anthropic-version'], '2023-06-01');
  assert.ok(!JSON.stringify(last(ant).headers).includes(TOKEN));
});

test('passthrough stream: bytes y hệt upstream', async () => {
  const r = await call('/v1/messages', { body: { ...MSG, model: 'ant/claude-x', stream: true } });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /event-stream/);
  assert.equal(r.text, ANT_SSE);
});

test('model không prefix → defaultModel; không có default → 400 model_not_found', async () => {
  const r = await call('/v1/messages', { body: { ...MSG, model: 'claude-haiku-4-5' } });
  assert.equal(r.status, 200);
  assert.equal(last(ant).body.model, 'claude-x');
  const r2 = await call('/v1/messages', { body: { ...MSG, model: 'nope/x' }, r: router2 });
  assert.equal(r2.status, 400);
  assert.equal(r2.json().error.type, 'model_not_found');
});

test('model upstream chứa "/" — tách ở "/" đầu', async () => {
  await call('/v1/chat/completions', { body: { model: 'oai/org/m', messages: [{ role: 'user', content: 'x' }] } });
  assert.equal(last(oai).body.model, 'org/m');
});

test('messages client → openai-compatible, non-stream: tool round trip', async () => {
  const r = await call('/v1/messages', { body: {
    model: 'oai/gpt-x', max_tokens: 50, system: [{ type: 'text', text: 'sys' }],
    tools: [{ name: 'calc', description: 'd', input_schema: { type: 'object' } }],
    messages: [
      { role: 'user', content: 'tính' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_0', name: 'calc', input: { n: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_0', content: '1' }] },
    ],
  } });
  assert.equal(r.status, 200);
  const s = last(oai);
  assert.equal(s.url, '/v1/chat/completions');
  assert.equal(s.headers.authorization, 'Bearer KEY-oai');
  assert.deepEqual(s.body.messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool']);
  assert.equal(s.body.messages[2].tool_calls[0].function.arguments, '{"n":1}');
  assert.equal(s.body.tools[0].function.name, 'calc');
  const j = r.json();
  assert.equal(j.type, 'message');
  assert.equal(j.model, 'oai/gpt-x');
  assert.equal(j.stop_reason, 'tool_use');
  assert.deepEqual(j.content, [{ type: 'text', text: 'dùng tool' }, { type: 'tool_use', id: 'call_7', name: 'calc', input: { n: 2 } }]);
  assert.deepEqual(j.usage, { input_tokens: 9, output_tokens: 3 });
});

test('messages client → openai-compatible, STREAM: text + tool_use input_json_delta', async () => {
  const r = await call('/v1/messages', { body: { ...MSG, model: 'oai/gpt-x', stream: true } });
  assert.equal(r.status, 200);
  assert.equal(last(oai).body.stream, true);
  const ev = sseEvents(r.text);
  assert.equal(ev[0].type, 'message_start');
  assert.equal(ev.at(-1).type, 'message_stop');
  const text = ev.filter((e) => e.delta?.type === 'text_delta').map((e) => e.delta.text).join('');
  assert.equal(text, 'Hi there');
  const starts = ev.filter((e) => e.type === 'content_block_start');
  assert.deepEqual(starts.map((e) => e.content_block.type), ['text', 'tool_use', 'tool_use']);
  assert.equal(starts[1].content_block.name, 'calc');
  const args = (idx) => ev.filter((e) => e.index === idx && e.delta?.type === 'input_json_delta').map((e) => e.delta.partial_json).join('');
  assert.deepEqual(JSON.parse(args(starts[1].index)), { x: [1, 2], y: 'z' });
  assert.deepEqual(JSON.parse(args(starts[2].index)), {});
  assert.equal(ev.filter((e) => e.type === 'content_block_stop').length, 3);
  const md = ev.find((e) => e.type === 'message_delta');
  assert.equal(md.delta.stop_reason, 'tool_use');
  assert.deepEqual(md.usage, { input_tokens: 11, output_tokens: 4 });
});

test('chat client → anthropic, non-stream', async () => {
  const r = await call('/v1/chat/completions', { body: { model: 'ant/claude-x', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }] } });
  assert.equal(r.status, 200);
  const s = last(ant);
  assert.equal(s.url, '/v1/messages');
  assert.equal(s.headers['x-api-key'], 'KEY-ant');
  assert.equal(s.body.system, 's');
  assert.equal(s.body.max_tokens, 4096);
  const j = r.json();
  assert.equal(j.object, 'chat.completion');
  assert.equal(j.choices[0].message.content, 'ok');
  assert.equal(j.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(JSON.parse(j.choices[0].message.tool_calls[0].function.arguments), { a: 1 });
  assert.equal(j.usage.total_tokens, 5);
});

test('chat client → anthropic, STREAM kết thúc bằng [DONE]', async () => {
  const r = await call('/v1/chat/completions', { body: { model: 'ant/claude-x', stream: true, messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(r.status, 200);
  assert.ok(r.text.endsWith('data: [DONE]\n\n'));
  const ch = sseEvents(r.text);
  assert.equal(ch.map((c) => c.choices[0].delta.content ?? '').join(''), 'Hello');
  const tc = ch.flatMap((c) => c.choices[0].delta.tool_calls ?? []);
  assert.equal(tc[0].function.name, 'calc');
  assert.deepEqual(JSON.parse(tc.map((t) => t.function.arguments).join('')), { a: 1 });
  assert.equal(ch.at(-1).choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(ch.at(-1).usage, { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 });
});

test('count_tokens không native → 404', async () => {
  assert.equal((await call('/v1/messages/count_tokens', { body: { model: 'oai/gpt-x', messages: [] } })).status, 404);
});

// ───── R2b: Responses (codex) → chat / messages ─────
const CODEX = JSON.parse(readFileSync(new URL('./fixtures/codex-responses-request.json', import.meta.url), 'utf8'));
const REAL_SSE = readFileSync(new URL('./fixtures/codex-responses-stream.txt', import.meta.url), 'utf8');
const evNames = (text) => text.split(/\r?\n/).filter((l) => l.startsWith('event: ')).map((l) => l.slice(7));
const collapse = (names) => names.filter((n, i) => n !== names[i - 1]); // gộp delta liên tiếp
function checkResponsesStream(text) {
  assert.ok(text.endsWith('data: [DONE]\n\n'));
  const ev = sseEvents(text);
  assert.deepEqual(ev.map((e) => e.type), evNames(text));
  ev.forEach((e, i) => assert.equal(e.sequence_number, i));
  const done = ev.at(-1);
  assert.equal(done.type, 'response.completed');
  return ev;
}

test('responsesToChatRequest: fixture codex thật', () => {
  const { req, names } = responsesToChatRequest(CODEX, 'm');
  assert.equal(req.model, 'm');
  assert.equal(req.messages.filter((m) => m.role === 'system').length, 1);
  assert.equal(req.messages[0].role, 'system');
  assert.match(req.messages[0].content, /You are a coding agent/);
  assert.match(req.messages[0].content, /skills_instructions/);
  assert.deepEqual(req.messages.slice(1).map((m) => m.role), ['user', 'user', 'assistant', 'tool']);
  const fc = CODEX.input.find((i) => i.type === 'function_call');
  const a = req.messages[3];
  assert.match(a.content, /a\.txt/); // text assistant ngay trước gộp cùng tool_calls
  assert.deepEqual(a.tool_calls, [{ id: fc.call_id, type: 'function', function: { name: 'exec_command', arguments: fc.arguments } }]);
  assert.equal(req.messages[4].tool_call_id, fc.call_id);
  assert.match(req.messages[4].content, /Process exited with code 0/);
  const tn = req.tools.map((t) => t.function.name);
  assert.deepEqual(tn, ['exec_command', 'write_stdin', 'multi_agent_v1__close_agent']); // web_search bỏ
  assert.deepEqual(names.get('multi_agent_v1__close_agent'), { name: 'close_agent', namespace: 'multi_agent_v1' });
  assert.equal(req.tool_choice, 'auto');
  assert.equal(req.parallel_tool_calls, true);
  assert.equal(req.stream, true);
  assert.deepEqual(req.stream_options, { include_usage: true });
  for (const k of ['reasoning', 'include', 'store', 'prompt_cache_key', 'client_metadata', 'input']) assert.equal(req[k], undefined, k);

  const s = responsesToChatRequest({ input: 'hi', instructions: 'be nice', max_output_tokens: 5 }, 'm').req;
  assert.deepEqual(s.messages, [{ role: 'system', content: 'be nice' }, { role: 'user', content: 'hi' }]);
  assert.equal(s.max_tokens, 5);
  assert.equal(s.stream, false);
  // function_call có namespace (lượt sau) → tên dẹt cho upstream
  const n = responsesToChatRequest({ input: [{ type: 'function_call', call_id: 'c', namespace: 'ns', name: 'f', arguments: '{}' }] }, 'm').req;
  assert.equal(n.messages[0].tool_calls[0].function.name, 'ns__f');
});

test('ChatToResponsesStream: text + 2 tool call (args cắt mảnh) + usage, chuỗi event như fixture thật', () => {
  const sse = OAI_SSE.replace('"name":"echo"', '"name":"multi_agent_v1__close_agent"');
  const names = responsesToChatRequest(CODEX, 'm').names;
  const t = new ChatToResponsesStream(names);
  let out = '';
  for (let i = 0; i < sse.length; i += 7) out += t.push(sse.slice(i, i + 7));
  out += t.end();
  const ev = checkResponsesStream(out);
  // mẫu event giống fixture thật (fixture có text rồi 1 function_call; ở đây thêm function_call thứ 2)
  const fcPattern = ['response.output_item.added', 'response.function_call_arguments.delta', 'response.function_call_arguments.done', 'response.output_item.done'];
  const real = collapse(evNames(REAL_SSE)).filter((n) => n !== 'response.function_call_arguments.delta');
  const mine = collapse(ev.map((e) => e.type));
  assert.deepEqual(mine.filter((n) => n !== 'response.function_call_arguments.delta'), [...real.slice(0, -1), ...fcPattern.filter((n) => !n.endsWith('.delta')), 'response.completed']);
  assert.deepEqual(mine.slice(-5, -1), fcPattern);
  // text
  assert.equal(ev.filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta).join(''), 'Hi there');
  assert.equal(ev.find((e) => e.type === 'response.output_text.done').text, 'Hi there');
  // args: done = nối delta, JSON hợp lệ
  const argsDone = ev.filter((e) => e.type === 'response.function_call_arguments.done');
  assert.equal(argsDone.length, 2);
  for (const d of argsDone) {
    const deltas = ev.filter((e) => e.type === 'response.function_call_arguments.delta' && e.item_id === d.item_id).map((e) => e.delta).join('');
    assert.equal(d.arguments, deltas);
    JSON.parse(d.arguments);
  }
  assert.deepEqual(JSON.parse(argsDone[0].arguments), { x: [1, 2], y: 'z' });
  const completed = ev.at(-1).response;
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.output.map((o) => o.type), ['message', 'function_call', 'function_call']);
  assert.deepEqual(ev.filter((e) => e.type === 'response.output_item.added').map((e) => e.output_index), [0, 1, 2]);
  assert.equal(completed.output[0].content[0].text, 'Hi there');
  assert.equal(completed.output[1].call_id, 'call_1');
  assert.equal(completed.output[1].name, 'calc');
  assert.deepEqual([completed.output[2].name, completed.output[2].namespace], ['close_agent', 'multi_agent_v1']); // un-flatten
  assert.deepEqual(completed.usage, { input_tokens: 11, output_tokens: 4, total_tokens: 15 });
  assert.equal(new Set([completed.id, ...completed.output.map((o) => o.id)]).size, 4);
  assert.match(completed.id, /^resp_/);
  assert.match(completed.output[1].id, /^fc_/);
});

for (const [label, model, up, route] of [['chat', 'oai/gpt-x', () => oai, '/v1/chat/completions'], ['messages', 'ant/claude-x', () => ant, '/v1/messages']]) {
  test(`responses client → upstream chỉ ${label}: stream + non-stream + tool round trip`, async () => {
    const r = await call('/v1/responses', { body: { ...CODEX, model } });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /event-stream/);
    const s = last(up());
    assert.equal(s.url, route);
    assert.equal(s.body.stream, true);
    const ev = checkResponsesStream(r.text);
    const out = ev.at(-1).response.output;
    assert.deepEqual(out.map((o) => o.type), label === 'chat' ? ['message', 'function_call', 'function_call'] : ['message', 'function_call']);
    assert.equal(out[1].name, 'calc');
    JSON.parse(out[1].arguments);

    // tool round trip: function_call + function_call_output → chat tool_calls + tool / messages tool_use + tool_result
    const r2 = await call('/v1/responses', { body: { ...CODEX, model, stream: false } });
    assert.equal(r2.status, 200);
    const j = r2.json();
    assert.equal(j.object, 'response');
    assert.equal(j.status, 'completed');
    assert.equal(j.model, model);
    assert.equal(j.output[0].type, 'message');
    assert.equal(j.output[1].type, 'function_call');
    assert.equal(j.output[1].name, 'calc');
    assert.equal(j.output[1].call_id, label === 'chat' ? 'call_7' : 'tu_1');
    assert.ok(j.usage.total_tokens > 0);
    const b = last(up()).body;
    assert.equal(b.stream, false);
    const callId = CODEX.input.find((i) => i.type === 'function_call').call_id;
    if (label === 'chat') {
      assert.equal(b.messages.find((m) => m.tool_calls).tool_calls[0].id, callId);
      assert.equal(b.messages.find((m) => m.role === 'tool').tool_call_id, callId);
    } else {
      assert.match(b.system, /You are a coding agent/);
      const blocks = b.messages.flatMap((m) => m.content);
      assert.equal(blocks.find((x) => x.type === 'tool_use').id, callId);
      assert.equal(blocks.find((x) => x.type === 'tool_result').tool_use_id, callId);
      assert.ok(b.tools.some((t) => t.name === 'multi_agent_v1__close_agent'));
    }
  });
}

test('upstream 429 → pass status + body', async () => {
  const r = await call('/v1/messages', { body: { ...MSG, model: 'ant/rate' } });
  assert.equal(r.status, 429);
  assert.equal(r.json().error.type, 'rate_limit_error');
});

test('body > 20 MB → 413', async () => {
  const r = await call('/v1/messages', { body: { model: 'ant/claude-x', pad: 'x'.repeat(21 * 1024 * 1024) } });
  assert.equal(r.status, 413);
});

// ───── unit: providers + translate ─────
test('normalizeProvider + authHeaders', () => {
  const p = normalizeProvider({ id: 'my-gw', kind: 'openai', baseUrl: 'https://gw.test/api/v1/' });
  assert.equal(p.baseUrl, 'https://gw.test/api');
  assert.deepEqual(p.formats, ['chat', 'responses']);
  assert.equal(p.enabled, true);
  assert.throws(() => normalizeProvider({ id: 'Bad_Id', kind: 'openai', baseUrl: 'https://x' }));
  assert.throws(() => normalizeProvider({ id: 'x', kind: 'openai', baseUrl: 'file:///etc' }));
  assert.deepEqual(authHeaders('anthropic', 'k'), { 'anthropic-version': '2023-06-01', 'x-api-key': 'k' });
  assert.deepEqual(authHeaders('openai', 'k'), { authorization: 'Bearer k' });
});

test('messagesToChatRequest: system blocks, ảnh, tool_result is_error, tool_choice, thinking bỏ', () => {
  const out = messagesToChatRequest({
    system: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
    stop_sequences: ['END'], temperature: 0.2, max_tokens: 9, tool_choice: { type: 'any' },
    messages: [
      { role: 'user', content: [
        { type: 'text', text: 'xem' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
        { type: 'image', source: { type: 'url', url: 'https://img.test/x.png' } },
      ] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', id: 't1', name: 'f', input: { q: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'boom' }] }, { type: 'text', text: 'sửa đi' }] },
    ],
  }, 'm');
  assert.deepEqual(out.messages[0], { role: 'system', content: 'a\nb' });
  assert.deepEqual(out.messages[1].content[1], { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } });
  assert.equal(out.messages[1].content[2].image_url.url, 'https://img.test/x.png');
  assert.deepEqual(out.messages[2], { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{"q":1}' } }] });
  assert.deepEqual(out.messages[3], { role: 'tool', tool_call_id: 't1', content: 'ERROR: boom' });
  assert.deepEqual(out.messages[4], { role: 'user', content: 'sửa đi' });
  assert.equal(out.tool_choice, 'required');
  assert.deepEqual(out.stop, ['END']);
  assert.equal(out.max_tokens, 9);
});

test('chatToMessagesRequest: data URL → base64, tool → tool_result gộp user, args hỏng → {}', () => {
  const out = chatToMessagesRequest({
    messages: [
      { role: 'system', content: 's' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QQ==' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{bad' } }, { id: 'c2', function: { name: 'g', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'r1' },
      { role: 'tool', tool_call_id: 'c2', content: 'r2' },
    ],
    stop: 'X', tool_choice: { type: 'function', function: { name: 'f' } },
  }, 'm');
  assert.equal(out.system, 's');
  assert.deepEqual(out.messages[0].content[0].source, { type: 'base64', media_type: 'image/jpeg', data: 'QQ==' });
  assert.deepEqual(out.messages[1].content[0].input, {});
  assert.equal(out.messages.length, 3);
  assert.deepEqual(out.messages[2].content.map((b) => b.tool_use_id), ['c1', 'c2']);
  assert.deepEqual(out.stop_sequences, ['X']);
  assert.deepEqual(out.tool_choice, { type: 'tool', name: 'f' });
});

test('stream transformer chịu chunk cắt giữa dòng (CRLF) + end() tự đóng khi thiếu [DONE]', () => {
  const t = new ChatToMessagesStream();
  const src = OAI_SSE.replace(/\n/g, '\r\n');
  let out = '';
  for (const ch of src) out += t.push(ch);
  out += t.end();
  assert.equal(sseEvents(out).filter((e) => e.type === 'message_stop').length, 1);

  const m = new MessagesToChatStream();
  const cut = ANT_SSE.slice(0, ANT_SSE.indexOf('event: message_delta'));
  const out2 = m.push(cut) + m.end();
  assert.ok(out2.endsWith('data: [DONE]\n\n'));
  assert.equal(sseEvents(out2).at(-1).choices[0].finish_reason, 'stop');
});

test('request đã dịch luôn có stream tường minh (upstream compat mặc định stream khi thiếu)', async () => {
  const { messagesToChatRequest, chatToMessagesRequest } = await import('../dist/router/translate.js');
  assert.equal(messagesToChatRequest({ messages: [{ role: 'user', content: 'x' }] }, 'm').stream, false);
  assert.equal(chatToMessagesRequest({ messages: [{ role: 'user', content: 'x' }] }, 'm').stream, false);
  assert.equal(messagesToChatRequest({ stream: true, messages: [{ role: 'user', content: 'x' }] }, 'm').stream, true);
});

test('passthrough non-stream: upstream trả chat.completion cho /v1/messages → chuẩn hoá về Messages', async () => {
  const http = await import('node:http');
  const up = http.createServer((q, r) => { q.resume(); q.on('end', () => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'Hi.' }, finish_reason: 'stop' }], usage: {} })); }); });
  await new Promise((ok) => up.listen(0, '127.0.0.1', ok));
  const { createProviderStore } = await import('../dist/router/providers.js');
  const { startRouter } = await import('../dist/router/server.js');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const os = await import('node:os'); const path = await import('node:path');
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'rt-')), 'router.json');
  writeFileSync(file, JSON.stringify({ providers: [{ id: 'gw', kind: 'anthropic-compatible', baseUrl: `http://127.0.0.1:${up.address().port}`, formats: ['messages'] }] }));
  const r = await startRouter({ store: createProviderStore({ file, keyFor: () => 'k' }) });
  try {
    const res = await fetch(`http://127.0.0.1:${r.port}/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${r.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gw/m', max_tokens: 10, stream: false, messages: [{ role: 'user', content: 'hi' }] }) });
    const j = await res.json();
    assert.equal(res.status, 200);
    assert.equal(j.type, 'message');
    assert.equal(j.content[0].text, 'Hi.');
  } finally { await r.close(); up.close(); }
});
