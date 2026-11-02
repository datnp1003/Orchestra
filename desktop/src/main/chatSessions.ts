// Session chat — parse <repo>/.orchestra/chat/<id>.jsonl (thuần, không fs) để resume hội thoại brain
import type { Block, Msg } from '../../../prototype/src/brain.js';

export interface ChatView {
  role: 'user' | 'orch' | 'step';
  text: string;
}
export interface ChatSession {
  history: Msg[];
  messages: ChatView[];
  title: string;
  turns: number;
}

export const SESSION_ID_RE = /^[\w.-]+$/;

const userText = (m: Msg): string =>
  typeof m.content === 'string' ? m.content : m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
const hasToolUse = (m: Msg) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use');

export function parseChatSession(text: string): ChatSession {
  const history: Msg[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let raw: { role?: unknown; content?: unknown };
    try {
      raw = JSON.parse(line);
    } catch {
      continue; // dòng hỏng (ghi dở) — bỏ
    }
    if ((raw.role !== 'user' && raw.role !== 'assistant') || (typeof raw.content !== 'string' && !Array.isArray(raw.content))) continue;
    // thinking có signature theo model — đổi model sau khi resume sẽ không validate được → bỏ
    const content = typeof raw.content === 'string'
      ? raw.content
      : (raw.content as { type?: string }[]).filter((b) => b && b.type !== 'thinking' && b.type !== 'redacted_thinking') as Block[];
    if (Array.isArray(content) && !content.length) continue;
    history.push({ role: raw.role, content });
  }
  // history phải kết thúc bằng assistant trả lời xong — bỏ tool_use treo ở cuối / user chưa có phản hồi
  // ponytail: chỉ xử lý treo ở cuối file (persistChat chỉ ghi lượt đã xong); treo giữa file → cần lọc theo tool_use_id
  while (history.length && (history.at(-1)!.role === 'user' || hasToolUse(history.at(-1)!))) history.pop();

  const messages: ChatView[] = [];
  for (const m of history) {
    if (m.role === 'user') {
      const t = userText(m);
      if (t.trim()) messages.push({ role: 'user', text: t }); // lượt chỉ có tool_result → bỏ
      continue;
    }
    const t = userText(m);
    if (t.trim()) messages.push({ role: 'orch', text: t });
    const tools = Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_use').map((b) => (b as { name: string }).name) : [];
    if (tools.length) messages.push({ role: 'step', text: `🔧 ${tools.join(', ')}` });
  }
  const first = messages.find((m) => m.role === 'user')?.text.trim().replace(/\s+/g, ' ') ?? '';
  return {
    history,
    messages,
    title: first.length > 60 ? first.slice(0, 59) + '…' : first || '(trống)',
    turns: messages.filter((m) => m.role === 'user').length,
  };
}
