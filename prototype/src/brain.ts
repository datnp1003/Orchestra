// M1 — Orchestra brain: agent loop riêng gọi LLM API (Anthropic Messages, tool calling).
// CLI chỉ là worker, chỉ chạm được qua tool fleet_dispatch / fleet_pipeline.
// R2a: gọi qua Orchestra router (baseUrl router, apiKey = token router) — key không log, không vào prompt/record/lỗi.

export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
export interface Msg {
  role: 'user' | 'assistant';
  content: string | Block[];
}
export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}
export interface ToolResult {
  ok: boolean;
  content: string;
}
export type BrainStep =
  | { kind: 'tool_call'; name: string; input: unknown }
  | { kind: 'tool_result'; name: string; ok: boolean; preview: string }
  | { kind: 'text'; text: string }
  | { kind: 'error'; text: string };

export interface BrainCreds {
  baseUrl: string;
  apiKey: string;
}
type FetchFn = typeof fetch;

// chấp nhận cả "https://gw" lẫn "https://gw/v1/"
const apiUrl = (baseUrl: string, p: string) => `${baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/${p}`;
const headers = (apiKey: string) => ({
  authorization: `Bearer ${apiKey}`,
  'anthropic-version': '2023-06-01',
  'content-type': 'application/json',
});

async function callJson(fetchImpl: FetchFn, url: string, init: RequestInit, apiKey: string): Promise<any> {
  const res = await fetchImpl(url, init);
  const body = await res.text();
  const fail = (why: string) => new Error(`brain ${why}: ${body.slice(0, 200).split(apiKey).join('***')}`);
  if (!res.ok) throw fail(`HTTP ${res.status}`);
  try {
    return JSON.parse(body);
  } catch {
    throw fail(`HTTP ${res.status} non-JSON`);
  }
}

export async function listBrainModels(c: BrainCreds, fetchImpl: FetchFn = fetch): Promise<{ models: string[]; error?: string }> {
  try {
    const r = await callJson(fetchImpl, apiUrl(c.baseUrl, 'models'), { headers: headers(c.apiKey) }, c.apiKey);
    return { models: Array.isArray(r?.data) ? r.data.map((m: { id?: unknown }) => m?.id).filter((x: unknown) => typeof x === 'string') : [] };
  } catch (err) {
    return { models: [], error: err instanceof Error ? err.message : String(err) };
  }
}

const MAX_RESULT = 20_000;

export interface BrainTurnOpts extends BrainCreds {
  history: Msg[];
  userText: string;
  model: string;
  system: string;
  tools: ToolDef[];
  execTool: (name: string, input: unknown) => Promise<ToolResult>;
  onStep?: (s: BrainStep) => void;
  maxTurns?: number;
  signal?: AbortSignal;
  fetchImpl?: FetchFn;
}

export const ABORTED_TEXT = '⏹ đã dừng';

export async function runBrainTurn(o: BrainTurnOpts): Promise<{ text: string; history: Msg[]; aborted?: boolean }> {
  const history: Msg[] = [...o.history, { role: 'user', content: o.userText }];
  const maxTurns = o.maxTurns ?? 12;
  // dừng giữa chừng: history luôn kết thúc bằng assistant, mọi tool_use đều có tool_result
  const stopped = () => {
    history.push({ role: 'assistant', content: [{ type: 'text', text: ABORTED_TEXT }] });
    return { text: ABORTED_TEXT, history, aborted: true };
  };
  for (let turn = 0; turn < maxTurns; turn++) {
    let r: any;
    try {
      r = await callJson(
        o.fetchImpl ?? fetch,
        apiUrl(o.baseUrl, 'messages'),
        {
          method: 'POST',
          headers: headers(o.apiKey),
          body: JSON.stringify({ model: o.model, max_tokens: 8192, system: o.system, messages: history, tools: o.tools, stream: false }),
          signal: o.signal,
        },
        o.apiKey,
      );
    } catch (err) {
      if (o.signal?.aborted) return stopped();
      throw err;
    }
    const content: Block[] = Array.isArray(r?.content) ? r.content : [];
    const text = content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim();
    const uses = content.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');
    if (r?.stop_reason !== 'tool_use' || !uses.length) {
      // tool_use mồ côi (vd. max_tokens) không được nằm lại history — lượt sau API sẽ từ chối
      history.push({ role: 'assistant', content: [{ type: 'text', text: text || '(trống)' }] });
      return { text, history };
    }
    history.push({ role: 'assistant', content });
    if (text) o.onStep?.({ kind: 'text', text }); // text giữa các tool call; text cuối do caller hiển thị

    const results: Block[] = [];
    for (const u of uses) {
      if (o.signal?.aborted) {
        results.push({ type: 'tool_result', tool_use_id: u.id, content: 'aborted', is_error: true });
        continue;
      }
      o.onStep?.({ kind: 'tool_call', name: u.name, input: u.input });
      let res: ToolResult;
      try {
        res = await o.execTool(u.name, u.input);
      } catch (err) {
        res = { ok: false, content: err instanceof Error ? err.message : String(err) };
      }
      const c = res.content.length > MAX_RESULT ? `${res.content.slice(0, MAX_RESULT)}\n…(cắt, ${res.content.length} ký tự)` : res.content;
      o.onStep?.({ kind: 'tool_result', name: u.name, ok: res.ok, preview: c.slice(0, 200) });
      results.push({ type: 'tool_result', tool_use_id: u.id, content: c, ...(res.ok ? {} : { is_error: true }) });
    }
    history.push({ role: 'user', content: results });
    if (o.signal?.aborted) return stopped();
  }
  const text = `Đã chạm trần ${maxTurns} lượt tool — dừng lượt này. Nhắn tiếp để Orchestra làm tiếp.`;
  o.onStep?.({ kind: 'error', text });
  history.push({ role: 'assistant', content: [{ type: 'text', text }] }); // giữ user/assistant xen kẽ cho lượt sau
  return { text, history };
}
