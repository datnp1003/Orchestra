// Session chat — parse ~/.orchestra/{projects/<id>/chat,chats}/<sessionId>.jsonl to resume brain conversations.
// Each session belongs to 1 project (many repos) or is a chat outside any project (projectId null).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { safeAssistantMsg, type Block, type Msg } from '../../../prototype/src/brain.js';
import { chatDir, projectDir } from '../../../prototype/src/home.js';
import { isSystemReminder } from '../../../prototype/src/permissions.js';
import { t } from '../../../prototype/src/i18n/index.js';
import type { Project } from './contract.js';

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

const legacyChatDir = (repo: string) => path.join(repo, '.orchestra', 'chat');

/** sessions in 1 chat dir, newest first, top `limit`. Empty files (chat created, nothing sent) are listed only
 *  when it is the open session `keepId` — an abandoned empty chat (e.g. app closed) never clutters the sidebar */
export function listChatSessions(dir: string, limit = 30, keepId = '') {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).flatMap((f) => {
    const file = path.join(dir, f);
    const st = statSync(file);
    const id = f.slice(0, -'.jsonl'.length);
    return st.size > 0 || id === keepId ? [{ file, id, updatedAt: st.mtime.toISOString() }] : [];
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
  // ponytail: parses whole files of top `limit` on every list — slow for very long sessions → cache by mtime
  return files.map(({ file, id, updatedAt }) => {
    const { title, turns } = parseChatSession(readFileSync(file, 'utf8'));
    return { id, title: turns ? title : t('desktop.sessions.new'), turns, updatedAt };
  });
}

/** chat:sessions — grouped by project + chats outside projects; active = currently open session */
export function chatSessionsView(projects: Project[], active: { projectId: string | null; id: string }) {
  const mark = (projectId: string | null) => (x: ReturnType<typeof listChatSessions>[number]) => ({ ...x, active: !!active.id && x.id === active.id && projectId === active.projectId });
  return {
    projects: projects.map((p) => ({ id: p.id, name: p.name, repos: p.repos, sessions: listChatSessions(chatDir(p.id), 30, active.projectId === p.id ? active.id : '').map(mark(p.id)) })),
    chats: listChatSessions(chatDir(null), 30, active.projectId === null ? active.id : '').map(mark(null)),
  };
}

/** projectId null/undefined = chat outside a project; a string must be an existing project */
export function findProject(projects: Project[], projectId: unknown): { project: Project | null } | { error: string } {
  if (projectId === null || projectId === undefined) return { project: null };
  const p = projects.find((x) => x.id === projectId);
  return p ? { project: p } : { error: t('desktop.project.notFound', { id: String(projectId) }) };
}

/** trust boundary chat:open — project must exist, id must not contain a path */
export function sessionFile(projects: Project[], projectId: unknown, id: unknown): { file: string; project: Project | null } | { error: string } {
  const f = findProject(projects, projectId);
  if ('error' in f) return f;
  if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) return { error: t('desktop.chat.err.badSession') };
  return { file: path.join(chatDir(f.project?.id ?? null), `${id}.jsonl`), project: f.project };
}

const slug = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/_/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'project';
export function newProjectId(name: string, taken: string[] = []): string {
  for (;;) {
    const id = `${slug(name)}-${randomBytes(2).toString('hex')}`;
    if (!taken.includes(id)) return id;
  }
}

/** old settings without projects → 1 project / repo; COPY (not move) old sessions <repo>/.orchestra/chat → project. Idempotent. */
export function migrateRepos(repos: string[]): Project[] {
  const projects: Project[] = [];
  for (const repo of repos) {
    const p = { id: newProjectId(path.basename(repo), projects.map((x) => x.id)), name: path.basename(repo.replace(/[\\/]+$/, '')) || repo, repos: [repo] };
    projects.push(p);
    copyLegacySessions(repo, p.id);
  }
  return projects;
}
export function copyLegacySessions(repo: string, projectId: string): number {
  const from = legacyChatDir(repo);
  if (!existsSync(from)) return 0;
  const to = chatDir(projectId);
  mkdirSync(to, { recursive: true });
  let n = 0;
  for (const f of readdirSync(from).filter((x) => x.endsWith('.jsonl') && SESSION_ID_RE.test(x))) {
    if (existsSync(path.join(to, f))) continue;
    copyFileSync(path.join(from, f), path.join(to, f));
    n++;
  }
  return n;
}

/** delete the project's Orchestra data (sessions + memory) — NEVER touches the repo */
export function deleteProjectData(id: string): void {
  rmSync(projectDir(id), { recursive: true, force: true });
}

const repoKey = (p: string) => {
  const n = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? n.toLowerCase() : n;
};
/** repo:add — only accepts dirs with .git; stored with '/' like other entries; duplicate → returns the existing entry */
export function addRepoDir(repos: string[], dir: string): { ok: true; repo: string; repos: string[] } | { ok: false; error: string } {
  if (!dir || !existsSync(path.join(dir, '.git'))) return { ok: false, error: t('desktop.repo.notGit', { dir }) };
  const hit = repos.find((r) => repoKey(r) === repoKey(dir));
  const repo = hit ?? dir.replace(/\\/g, '/').replace(/\/+$/, '');
  return { ok: true, repo, repos: hit ? repos : [...repos, repo] };
}

// injected <system-reminder> blocks (Plan mode) stay in history for the brain, never in the visible text/title
const userText = (m: Msg): string =>
  typeof m.content === 'string' ? m.content : m.content.flatMap((b) => (b.type === 'text' && !isSystemReminder(b.text) ? [b.text] : [])).join('\n');
const hasToolUse = (m: Msg) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use');

export function parseChatSession(text: string): ChatSession {
  const history: Msg[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let raw: { role?: unknown; content?: unknown };
    try {
      raw = JSON.parse(line);
    } catch {
      continue; // corrupt line (partial write) — skip
    }
    if ((raw.role !== 'user' && raw.role !== 'assistant') || (typeof raw.content !== 'string' && !Array.isArray(raw.content))) continue;
    // thinking carries a per-model signature — switching model after resume fails validation → drop
    const content = typeof raw.content === 'string'
      ? raw.content
      : (raw.content as { type?: string }[]).filter((b) => b && b.type !== 'thinking' && b.type !== 'redacted_thinking') as Block[];
    // older records may carry reasoning leaked into text → placeholder (display only; file untouched)
    const m = safeAssistantMsg({ role: raw.role, content });
    if (Array.isArray(m.content) && !m.content.length) continue;
    history.push(m);
  }
  // history must end with a finished assistant reply — drop trailing dangling tool_use / unanswered user
  // ponytail: only handles dangling turns at end of file (persistChat only writes finished turns); mid-file → filter by tool_use_id
  while (history.length && (history.at(-1)!.role === 'user' || hasToolUse(history.at(-1)!))) history.pop();

  const messages: ChatView[] = [];
  for (const m of history) {
    if (m.role === 'user') {
      const t = userText(m);
      if (t.trim()) messages.push({ role: 'user', text: t }); // tool_result-only turn → skip
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
