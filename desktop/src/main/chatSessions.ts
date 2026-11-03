// Session chat — parse <repo>/.orchestra/chat/<id>.jsonl để resume hội thoại brain; mỗi session thuộc 1 repo
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Block, Msg } from '../../../prototype/src/brain.js';
import { t } from '../../../prototype/src/i18n/index.js';

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

const chatDir = (repo: string) => path.join(repo, '.orchestra', 'chat');
export const repoName = (repo: string) => repo.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? repo;

/** session của mọi repo (bỏ repo/thư mục không tồn tại), mới nhất trước, top `limit` */
export function listChatSessions(repos: string[], limit = 30) {
  const files = repos.flatMap((repo) => {
    const dir = chatDir(repo);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => {
      const file = path.join(dir, f);
      return { repo, file, id: f.slice(0, -'.jsonl'.length), updatedAt: statSync(file).mtime.toISOString() };
    });
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
  // ponytail: parse cả file của top `limit` mỗi lần list — chậm khi session rất dài → cache theo mtime
  return files.map(({ repo, file, id, updatedAt }) => {
    const { title, turns } = parseChatSession(readFileSync(file, 'utf8'));
    return { id, title, turns, updatedAt, repo, repoName: repoName(repo) };
  });
}

/** trust boundary chat:open — repo phải nằm trong settings.repos, id không chứa path */
export function sessionFile(repos: string[], repo: unknown, id: unknown): { file: string } | { error: string } {
  if (typeof repo !== 'string' || !repos.includes(repo)) return { error: t('desktop.repo.notAllowed', { repo: String(repo) }) };
  if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) return { error: t('desktop.chat.err.badSession') };
  return { file: path.join(chatDir(repo), `${id}.jsonl`) };
}

const repoKey = (p: string) => {
  const n = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? n.toLowerCase() : n;
};
/** repo:add — chỉ nhận thư mục có .git; lưu dạng '/' như các entry khác; trùng → trả entry cũ */
export function addRepoDir(repos: string[], dir: string): { ok: true; repo: string; repos: string[] } | { ok: false; error: string } {
  if (!dir || !existsSync(path.join(dir, '.git'))) return { ok: false, error: t('desktop.repo.notGit', { dir }) };
  const hit = repos.find((r) => repoKey(r) === repoKey(dir));
  const repo = hit ?? dir.replace(/\\/g, '/').replace(/\/+$/, '');
  return { ok: true, repo, repos: hit ? repos : [...repos, repo] };
}

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
    title: first.length > 60 ? first.slice(0, 59) + '…' : first || t('desktop.chat.untitled'),
    turns: messages.filter((m) => m.role === 'user').length,
  };
}
