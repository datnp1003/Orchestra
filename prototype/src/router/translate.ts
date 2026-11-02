// Router R1 — dịch Anthropic Messages ⇄ OpenAI Chat Completions (request, response, SSE stream).
// Hàm thuần, input là JSON client gửi (đã parse) — không validate sâu, upstream sẽ báo lỗi schema.
// Lossy có chủ ý: thinking/redacted_thinking/reasoning bị bỏ; ảnh trong tool_result bị bỏ;
// cache_control, metadata, top_k, logprobs, n>1 không map.
/* eslint-disable @typescript-eslint/no-explicit-any */

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
      } else if (b.type === 'tool_use') {
        toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
      } else if (b.type === 'tool_result') {
        // tool message phải đứng ngay sau assistant tool_calls → push trước phần text của user
        messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: `${b.is_error ? 'ERROR: ' : ''}${textOf(b.content)}` });
      }
      // thinking / redacted_thinking: bỏ (Chat không có chỗ chứa)
    }
    if (m.role === 'assistant') {
      const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('');
      if (text || toolCalls.length) messages.push({ role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    } else if (parts.length) {
      // toàn text → string (nhiều server OpenAI-compatible không nhận mảng parts)
      messages.push({ role: 'user', content: parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('\n') : parts });
    }
  }
  const out: any = { model, messages };
  if (body.max_tokens !== undefined) out.max_tokens = body.max_tokens;
  if (body.stop_sequences?.length) out.stop = body.stop_sequences;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  // stream LUÔN tường minh: nhiều upstream compat mặc định stream khi thiếu field (gặp thật với gateway 9router)
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
  // Anthropic bắt buộc user/assistant xen kẽ → gộp message liền kề cùng role
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
        }
      }
      for (const t of m.tool_calls ?? []) {
        blocks.push({ type: 'tool_use', id: t.id, name: t.function?.name, input: parseArgs(t.function?.arguments) });
      }
      push(m.role === 'assistant' ? 'assistant' : 'user', blocks);
    }
  }
  // Anthropic bắt buộc max_tokens; client OpenAI hay bỏ trống → mặc định 4096 (lossy)
  const out: any = { model, messages, max_tokens: body.max_completion_tokens ?? body.max_tokens ?? 4096 };
  if (system.length) out.system = system.join('\n');
  if (body.stop) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  out.stream = !!body.stream; // tường minh — xem messagesToChatRequest
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

// ───────────── response (non-stream) ─────────────
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
// push(text) nhận chunk thô (có thể cắt giữa dòng), trả SSE output; end() flush + đóng nếu upstream không gửi kết thúc.
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
    if (this.done || !l.startsWith('data:')) return ''; // bỏ 'event:', comment, dòng trống
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
 *  Giả định tool_calls stream tuần tự theo index (OpenAI và đa số compat làm vậy). */
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

/** upstream Messages SSE → client Chat SSE (kết thúc bằng `data: [DONE]`) */
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
        return ''; // thinking_delta / signature_delta: bỏ
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
