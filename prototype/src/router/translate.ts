// Router R1 — translate Anthropic Messages ⇄ OpenAI Chat Completions (request, response, SSE stream).
// Pure functions, input is the client's (parsed) JSON — no deep validation, upstream reports schema errors.
// Lossy on purpose: thinking/redacted_thinking/reasoning dropped; images in tool_result dropped;
// cache_control, metadata, top_k, logprobs, n>1 not mapped.
// R2b: Responses (codex) → Chat (→ Messages via chatToMessagesRequest, 2 steps — lossiness compounds), response/stream translated back.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from 'node:crypto';

const parseArgs = (s: unknown): Record<string, unknown> => {
  try {
    const v = JSON.parse(String(s || '{}'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
};
const textOf = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '';

const STOP_TO_MSG: Record<string, string> = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'end_turn' };
const STOP_TO_CHAT: Record<string, string> = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls', pause_turn: 'stop', refusal: 'content_filter' };
export const stopToMessages = (r: unknown) => (r ? STOP_TO_MSG[String(r)] ?? 'end_turn' : null);
export const stopToChat = (r: unknown) => (r ? STOP_TO_CHAT[String(r)] ?? 'stop' : null);

// ───────────── request: Messages → Chat ─────────────
export function messagesToChatRequest(body: any, model: string): any {
  const messages: any[] = [];
  const sys = textOf(body.system);
  if (sys) messages.push({ role: 'system', content: sys });
  for (const m of body.messages ?? []) {
    if (typeof m.content === 'string') {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    const parts: any[] = [];
    const toolCalls: any[] = [];
    for (const b of m.content ?? []) {
      if (b.type === 'text') parts.push({ type: 'text', text: b.text });
      else if (b.type === 'image') {
        const s = b.source ?? {};
        parts.push({ type: 'image_url', image_url: { url: s.type === 'base64' ? `data:${s.media_type};base64,${s.data}` : s.url } });
      } else if (b.type === 'document' && b.source?.type === 'base64') {
        parts.push({ type: 'file', file: { filename: b.title || 'document.pdf', file_data: `data:${b.source.media_type};base64,${b.source.data}` } });
      } else if (b.type === 'tool_use') {
        toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
      } else if (b.type === 'tool_result') {
        // tool message must directly follow assistant tool_calls → push before the user's text
        messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: `${b.is_error ? 'ERROR: ' : ''}${textOf(b.content)}` });
      }
      // thinking / redacted_thinking: dropped (Chat has nowhere to put them)
    }
    if (m.role === 'assistant') {
      const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('');
      if (text || toolCalls.length) messages.push({ role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    } else if (parts.length) {
      // all text → string (many OpenAI-compatible servers don't accept a parts array)
      messages.push({ role: 'user', content: parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('\n') : parts });
    }
  }
  const out: any = { model, messages };
  if (body.max_tokens !== undefined) out.max_tokens = body.max_tokens;
  if (body.stop_sequences?.length) out.stop = body.stop_sequences;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  // stream ALWAYS explicit: many compat upstreams default to streaming when the field is missing (seen with the 9router gateway)
  out.stream = !!body.stream;
  if (body.stream) {
    out.stream_options = { include_usage: true };
  }
  if (body.tools?.length) {
    out.tools = body.tools.map((t: any) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema ?? { type: 'object' } } }));
  }
  const tc = body.tool_choice;
  if (tc) {
    out.tool_choice = tc.type === 'any' ? 'required' : tc.type === 'tool' ? { type: 'function', function: { name: tc.name } } : tc.type; // auto | none
    if (tc.disable_parallel_tool_use) out.parallel_tool_calls = false;
  }
  return out;
}

// ───────────── request: Chat → Messages ─────────────
function imagePart(url: string): any {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
  return { type: 'image', source: m ? { type: 'base64', media_type: m[1], data: m[2] } : { type: 'url', url } };
}

export function chatToMessagesRequest(body: any, model: string): any {
  const system: string[] = [];
  const messages: any[] = [];
  // Anthropic requires alternating user/assistant → merge adjacent same-role messages
  const push = (role: string, blocks: any[]) => {
    if (!blocks.length) return;
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const m of body.messages ?? []) {
    if (m.role === 'system' || m.role === 'developer') {
      system.push(textOf(m.content));
    } else if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: textOf(m.content) }]);
    } else {
      const blocks: any[] = [];
      if (typeof m.content === 'string') {
        if (m.content) blocks.push({ type: 'text', text: m.content });
      } else {
        for (const p of m.content ?? []) {
          if (p.type === 'text') blocks.push({ type: 'text', text: p.text });
          else if (p.type === 'image_url') blocks.push(imagePart(p.image_url?.url ?? ''));
          else if (p.type === 'file' && /^data:application\/pdf;base64,/.test(p.file?.file_data ?? '')) {
            blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.file.file_data.slice(p.file.file_data.indexOf(',') + 1) }, ...(p.file.filename ? { title: p.file.filename } : {}) });
          }
        }
      }
      for (const t of m.tool_calls ?? []) {
        blocks.push({ type: 'tool_use', id: t.id, name: t.function?.name, input: parseArgs(t.function?.arguments) });
      }
      push(m.role === 'assistant' ? 'assistant' : 'user', blocks);
    }
  }
  // Anthropic requires max_tokens; OpenAI clients often omit it → default 4096 (lossy)
  const out: any = { model, messages, max_tokens: body.max_completion_tokens ?? body.max_tokens ?? 4096 };
  if (system.length) out.system = system.join('\n');
  if (body.stop) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  out.stream = !!body.stream; // explicit — see messagesToChatRequest
  if (body.tools?.length) {
    out.tools = body.tools.map((t: any) => ({ name: t.function?.name, description: t.function?.description, input_schema: t.function?.parameters ?? { type: 'object' } }));
  }
  const tc = body.tool_choice;
  if (tc === 'required') out.tool_choice = { type: 'any' };
  else if (tc === 'auto' || tc === 'none') out.tool_choice = { type: tc };
  else if (tc?.function?.name) out.tool_choice = { type: 'tool', name: tc.function.name };
  if (body.parallel_tool_calls === false && out.tool_choice) out.tool_choice.disable_parallel_tool_use = true;
  return out;
}

// ───────────── request: Responses → Chat ─────────────
// Lossy: reasoning/include/store/prompt_cache_key/client_metadata dropped; reasoning/custom_tool_call items dropped;
// hosted tools (web_search, file_search…) and custom dropped; developer/system merged into 1 leading system (mid-conversation position lost);
// namespaced tools (MCP) flattened to `${ns}__${fn}` — names maps back when returning function_call (original name + namespace).
export type ToolNames = Map<string, { name: string; namespace: string }>;
const partsText = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => typeof p?.text === 'string').map((p) => p.text).join('\n') : '';

export function responsesToChatRequest(body: any, model: string): { req: any; names: ToolNames } {
  const names: ToolNames = new Map();
  const system: string[] = body.instructions ? [String(body.instructions)] : [];
  const messages: any[] = [];
  const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : Array.isArray(body.input) ? body.input : [];
  for (const it of input) {
    const type = it?.type ?? 'message'; // EasyInputMessage doesn't require type
    if (type === 'message') {
      if (it.role === 'system' || it.role === 'developer') system.push(partsText(it.content));
      else if (it.role === 'assistant') {
        const text = partsText(it.content);
        if (text) messages.push({ role: 'assistant', content: text });
      } else {
        const parts: any[] = typeof it.content === 'string' ? [{ type: 'text', text: it.content }] : (it.content ?? []).flatMap((p: any) =>
          p.type === 'input_image' && p.image_url ? [{ type: 'image_url', image_url: { url: p.image_url } }] : typeof p.text === 'string' ? [{ type: 'text', text: p.text }] : []);
        if (parts.length) messages.push({ role: 'user', content: parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('\n') : parts });
      }
    } else if (type === 'function_call') {
      // consecutive function_calls (+ assistant text right before) → 1 assistant message
      const call = { id: it.call_id, type: 'function', function: { name: it.namespace ? `${it.namespace}__${it.name}` : it.name, arguments: it.arguments || '{}' } };
      const last = messages.at(-1);
      if (last?.role === 'assistant') (last.tool_calls ??= []).push(call);
      else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
    } else if (type === 'function_call_output') {
      messages.push({ role: 'tool', tool_call_id: it.call_id, content: partsText(it.output) });
    }
  }
  const fn = (t: any, name: string) => ({ type: 'function', function: { name, description: t.description, parameters: t.parameters ?? { type: 'object' } } });
  const tools: any[] = [];
  for (const t of body.tools ?? []) {
    if (t.type === 'function') tools.push(fn(t, t.name));
    else if (t.type === 'namespace') {
      for (const f of t.tools ?? []) {
        if (f.type !== 'function') continue;
        names.set(`${t.name}__${f.name}`, { name: f.name, namespace: t.name });
        tools.push(fn(f, `${t.name}__${f.name}`));
      }
    }
  }
  const req: any = { model, messages: system.length ? [{ role: 'system', content: system.join('\n\n') }, ...messages] : messages };
  if (body.max_output_tokens !== undefined) req.max_tokens = body.max_output_tokens;
  if (body.temperature !== undefined) req.temperature = body.temperature;
  if (body.top_p !== undefined) req.top_p = body.top_p;
  req.stream = !!body.stream; // explicit — see messagesToChatRequest
  if (body.stream) req.stream_options = { include_usage: true };
  if (tools.length) {
    req.tools = tools;
    const tc = body.tool_choice;
    if (typeof tc === 'string') req.tool_choice = tc; // auto | none | required
    else if (tc?.type === 'function' && tc.name) req.tool_choice = { type: 'function', function: { name: tc.name } };
    if (typeof body.parallel_tool_calls === 'boolean') req.parallel_tool_calls = body.parallel_tool_calls; // OpenAI rejects this field when there are no tools
  }
  return { req, names };
}

// ───────────── response (non-stream) ─────────────
const rid = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '')}`;
const outText = (text: string) => ({ type: 'output_text', annotations: [], text });
const msgItem = (id: string, text: string, status: string) => ({ id, type: 'message', status, role: 'assistant', content: status === 'completed' ? [outText(text)] : [] });
const fcItem = (names: ToolNames, id: string, callId: string, flat: string, args: string, status: string) => {
  const n = names.get(flat);
  return { id, type: 'function_call', status, call_id: callId, name: n?.name ?? flat, ...(n ? { namespace: n.namespace } : {}), arguments: args };
};
const resUsage = (u: any) => {
  const i = u?.prompt_tokens ?? 0;
  const o = u?.completion_tokens ?? 0;
  return { input_tokens: i, output_tokens: o, total_tokens: i + o };
};

/** Chat completion → Responses object (upstream messages: go through messagesToChatResponse first) */
export function chatToResponsesResponse(r: any, names: ToolNames = new Map()): any {
  const msg = r.choices?.[0]?.message ?? {};
  const output: any[] = [];
  const text = textOf(msg.content);
  if (text) output.push(msgItem(rid('msg'), text, 'completed'));
  (msg.tool_calls ?? []).forEach((t: any, i: number) => output.push(fcItem(names, rid('fc'), t.id ?? `call_${i}`, t.function?.name ?? '', t.function?.arguments ?? '', 'completed')));
  return { id: rid('resp'), object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: r.model, output, usage: resUsage(r.usage) };
}

export function chatToMessagesResponse(r: any): any {
  const choice = r.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const content: any[] = [];
  const text = textOf(msg.content);
  if (text) content.push({ type: 'text', text });
  for (const t of msg.tool_calls ?? []) {
    content.push({ type: 'tool_use', id: t.id, name: t.function?.name, input: parseArgs(t.function?.arguments) });
  }
  return {
    id: r.id ?? 'msg_orchestra',
    type: 'message',
    role: 'assistant',
    model: r.model,
    content,
    stop_reason: stopToMessages(choice.finish_reason) ?? 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: r.usage?.prompt_tokens ?? 0, output_tokens: r.usage?.completion_tokens ?? 0 },
  };
}

export function messagesToChatResponse(r: any): any {
  const blocks: any[] = r.content ?? [];
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const toolCalls = blocks
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
  const input = r.usage?.input_tokens ?? 0;
  const output = r.usage?.output_tokens ?? 0;
  return {
    id: r.id ?? 'chatcmpl-orchestra',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: r.model,
    choices: [{ index: 0, message: { role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: stopToChat(r.stop_reason) ?? 'stop' }],
    usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
  };
}

// ───────────── stream: line-based SSE transformers ─────────────
// push(text) takes raw chunks (may split mid-line), returns SSE output; end() flushes + closes if upstream sent no terminator.
abstract class SseLines {
  private buf = '';
  protected done = false;
  push(chunk: string): string {
    this.buf += chunk;
    const lines = this.buf.split('\n');
    this.buf = lines.pop() ?? '';
    return lines.map((l) => this.line(l.replace(/\r$/, ''))).join('');
  }
  end(): string {
    const rest = this.buf ? this.line(this.buf) : '';
    this.buf = '';
    return rest + (this.done ? '' : this.finish());
  }
  private line(l: string): string {
    if (this.done || !l.startsWith('data:')) return ''; // skip 'event:', comments, blank lines
    const data = l.slice(5).trim();
    if (data === '[DONE]') return this.finish();
    try {
      return this.data(JSON.parse(data));
    } catch {
      return '';
    }
  }
  protected abstract data(j: any): string;
  protected abstract finish(): string;
}

const sse = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

/** upstream Chat SSE → client Messages SSE.
 *  Assumes tool_calls stream sequentially by index (OpenAI and most compat servers do). */
export class ChatToMessagesStream extends SseLines {
  private started = false;
  private open: { kind: 'text' } | { kind: 'tool'; index: number } | null = null;
  private block = -1;
  private stop: string | null = null;
  private usage = { input_tokens: 0, output_tokens: 0 };

  private start(j: any): string {
    if (this.started) return '';
    this.started = true;
    const message = { id: j?.id ?? 'msg_orchestra', type: 'message', role: 'assistant', model: j?.model ?? '', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
    return sse('message_start', { message });
  }
  private close(): string {
    if (!this.open) return '';
    this.open = null;
    return sse('content_block_stop', { index: this.block });
  }
  protected data(j: any): string {
    if (j.error) {
      this.done = true;
      return sse('error', { error: { type: 'api_error', message: j.error.message ?? JSON.stringify(j.error) } });
    }
    let out = this.start(j);
    if (j.usage) this.usage = { input_tokens: j.usage.prompt_tokens ?? 0, output_tokens: j.usage.completion_tokens ?? 0 };
    const choice = j.choices?.[0];
    if (!choice) return out;
    const d = choice.delta ?? {};
    if (typeof d.content === 'string' && d.content) {
      if (this.open?.kind !== 'text') {
        out += this.close();
        this.open = { kind: 'text' };
        out += sse('content_block_start', { index: ++this.block, content_block: { type: 'text', text: '' } });
      }
      out += sse('content_block_delta', { index: this.block, delta: { type: 'text_delta', text: d.content } });
    }
    for (const t of d.tool_calls ?? []) {
      const index = t.index ?? 0;
      if (this.open?.kind !== 'tool' || this.open.index !== index) {
        out += this.close();
        this.open = { kind: 'tool', index };
        out += sse('content_block_start', { index: ++this.block, content_block: { type: 'tool_use', id: t.id ?? `toolu_${index}`, name: t.function?.name ?? '', input: {} } });
      }
      if (t.function?.arguments) out += sse('content_block_delta', { index: this.block, delta: { type: 'input_json_delta', partial_json: t.function.arguments } });
    }
    if (choice.finish_reason) this.stop = stopToMessages(choice.finish_reason);
    return out;
  }
  protected finish(): string {
    this.done = true;
    return (
      this.start(null) +
      this.close() +
      sse('message_delta', { delta: { stop_reason: this.stop ?? 'end_turn', stop_sequence: null }, usage: this.usage }) +
      sse('message_stop', {})
    );
  }
}

/** upstream Chat SSE → client Responses SSE (event sequence as real OpenAI — see test/fixtures/codex-responses-stream.txt).
 *  Upstream Messages: chain MessagesToChatStream → this class. Same sequential-by-index tool_calls assumption. */
export class ChatToResponsesStream extends SseLines {
  private id = rid('resp');
  private model = '';
  private seq = 0;
  private started = false;
  private open: { kind: 'msg'; id: string; idx: number; text: string } | { kind: 'fc'; index: number; item: any; idx: number } | null = null;
  private output: any[] = [];
  private finishReason: string | null = null;
  private usage = resUsage(null);
  constructor(private names: ToolNames = new Map()) {
    super();
  }

  private ev(type: string, data: object): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...data, sequence_number: this.seq++ })}\n\n`;
  }
  private resp(status: string, extra: object = {}) {
    return { id: this.id, object: 'response', created_at: Math.floor(Date.now() / 1000), status, model: this.model, output: this.output, ...extra };
  }
  private start(j: any): string {
    if (this.started) return '';
    this.started = true;
    this.model = j?.model ?? '';
    return this.ev('response.created', { response: this.resp('in_progress', { output: [] }) }) + this.ev('response.in_progress', { response: this.resp('in_progress', { output: [] }) });
  }
  private close(): string {
    const o = this.open;
    if (!o) return '';
    this.open = null;
    if (o.kind === 'msg') {
      const item = msgItem(o.id, o.text, 'completed');
      this.output.push(item);
      const at = { item_id: o.id, output_index: o.idx, content_index: 0 };
      return this.ev('response.output_text.done', { ...at, text: o.text }) + this.ev('response.content_part.done', { ...at, part: outText(o.text) }) + this.ev('response.output_item.done', { output_index: o.idx, item });
    }
    o.item.status = 'completed';
    this.output.push(o.item);
    return this.ev('response.function_call_arguments.done', { item_id: o.item.id, output_index: o.idx, arguments: o.item.arguments }) + this.ev('response.output_item.done', { output_index: o.idx, item: o.item });
  }
  protected data(j: any): string {
    if (j.error) {
      this.done = true;
      return this.start(j) + this.ev('response.failed', { response: this.resp('failed', { error: { code: 'upstream_error', message: j.error.message ?? JSON.stringify(j.error) } }) }) + 'data: [DONE]\n\n';
    }
    let out = this.start(j);
    if (j.usage) this.usage = resUsage(j.usage);
    const choice = j.choices?.[0];
    if (!choice) return out;
    const d = choice.delta ?? {};
    // output_index = output.length after close() (the just-closed item is already in output)
    if (typeof d.content === 'string' && d.content) {
      if (this.open?.kind !== 'msg') {
        out += this.close();
        const id = rid('msg');
        this.open = { kind: 'msg', id, idx: this.output.length, text: '' };
        out += this.ev('response.output_item.added', { output_index: this.open.idx, item: msgItem(id, '', 'in_progress') });
        out += this.ev('response.content_part.added', { item_id: id, output_index: this.open.idx, content_index: 0, part: outText('') });
      }
      this.open.text += d.content;
      out += this.ev('response.output_text.delta', { item_id: this.open.id, output_index: this.open.idx, content_index: 0, delta: d.content });
    }
    for (const t of d.tool_calls ?? []) {
      const index = t.index ?? 0;
      if (this.open?.kind !== 'fc' || this.open.index !== index) {
        out += this.close();
        const item = fcItem(this.names, rid('fc'), t.id ?? `call_${index}`, t.function?.name ?? '', '', 'in_progress');
        this.open = { kind: 'fc', index, item, idx: this.output.length };
        out += this.ev('response.output_item.added', { output_index: this.open.idx, item: { ...item } });
      }
      const a = t.function?.arguments;
      if (a) {
        this.open.item.arguments += a;
        out += this.ev('response.function_call_arguments.delta', { item_id: this.open.item.id, output_index: this.open.idx, delta: a });
      }
    }
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    return out;
  }
  protected finish(): string {
    this.done = true;
    const out = this.start(null) + this.close();
    const extra = this.finishReason === 'length' ? { incomplete_details: { reason: 'max_output_tokens' } } : {};
    const status = this.finishReason === 'length' ? 'incomplete' : 'completed';
    return out + this.ev(`response.${status}`, { response: this.resp(status, { ...extra, usage: this.usage }) }) + 'data: [DONE]\n\n';
  }
}

/** upstream Messages SSE → client Chat SSE (ends with `data: [DONE]`) */
export class MessagesToChatStream extends SseLines {
  private id = 'chatcmpl-orchestra';
  private model = '';
  private created = Math.floor(Date.now() / 1000);
  private tools = new Map<number, number>(); // block index Anthropic → tool_calls index
  private stop: string | null = null;
  private usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  private chunk(delta: object, finish: string | null = null, extra: object = {}): string {
    const c = { id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra };
    return `data: ${JSON.stringify(c)}\n\n`;
  }
  protected data(j: any): string {
    switch (j.type) {
      case 'message_start':
        this.id = j.message?.id ?? this.id;
        this.model = j.message?.model ?? '';
        this.usage.prompt_tokens = j.message?.usage?.input_tokens ?? 0;
        return this.chunk({ role: 'assistant', content: '' });
      case 'content_block_start': {
        const b = j.content_block ?? {};
        if (b.type === 'text' && b.text) return this.chunk({ content: b.text });
        if (b.type !== 'tool_use') return '';
        const i = this.tools.size;
        this.tools.set(j.index, i);
        return this.chunk({ tool_calls: [{ index: i, id: b.id, type: 'function', function: { name: b.name, arguments: '' } }] });
      }
      case 'content_block_delta': {
        const d = j.delta ?? {};
        if (d.type === 'text_delta') return this.chunk({ content: d.text });
        if (d.type === 'input_json_delta' && this.tools.has(j.index)) {
          return this.chunk({ tool_calls: [{ index: this.tools.get(j.index), function: { arguments: d.partial_json } }] });
        }
        return ''; // thinking_delta / signature_delta: dropped
      }
      case 'message_delta':
        this.stop = stopToChat(j.delta?.stop_reason);
        if (j.usage?.input_tokens) this.usage.prompt_tokens = j.usage.input_tokens;
        this.usage.completion_tokens = j.usage?.output_tokens ?? this.usage.completion_tokens;
        return '';
      case 'message_stop':
        return this.finish();
      case 'error':
        this.done = true;
        return `data: ${JSON.stringify({ error: j.error })}\n\ndata: [DONE]\n\n`;
      default:
        return ''; // ping, content_block_stop
    }
  }
  protected finish(): string {
    this.done = true;
    this.usage.total_tokens = this.usage.prompt_tokens + this.usage.completion_tokens;
    return this.chunk({}, this.stop ?? 'stop', { usage: this.usage }) + 'data: [DONE]\n\n';
  }
}
