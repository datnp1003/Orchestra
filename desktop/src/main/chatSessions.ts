// Session chat — parse ~/.orchestra/{projects/<id>/chat,chats}/<sessionId>.jsonl to resume brain conversations.
// Each session belongs to 1 project (many repos) or is a chat outside any project (projectId null).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { safeAssistantMsg, type Block, type Msg } from '../../../prototype/src/brain.js';
import { chatDir, projectDir } from '../../../prototype/src/home.js';
import { isSystemReminder } from '../../../prototype/src/permissions.js';
import { attachmentName, extractText, isAttachmentText, readZip, safeEntryPath, sliceText, decodeText, PDF_INLINE_BYTES, type AttachmentInfo } from '../../../prototype/src/attachments.js';
import { t } from '../../../prototype/src/i18n/index.js';
import type { Project } from './contract.js';

export interface ChatView {
  role: 'user' | 'orch' | 'step';
  text: string;
  /** user message images as data: URLs (renderer shows thumbnails) */
  images?: string[];
  /** names of files attached to the user message (renderer shows chips) */
  files?: string[];
}
export interface ChatSession {
  history: Msg[];
  messages: ChatView[];
  title: string;
  turns: number;
}

export const SESSION_ID_RE = /^[\w.-]+$/;

// ---------- attached images as files (workers can't read the conversation) ----------
// <chat dir>/<sessionId>.images/img-N.<ext> — id img-N is announced to the brain, which passes it to fleet_dispatch
export const IMAGE_ID_RE = /^img-\d{1,4}$/;
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
export const imagesDir = (projectId: string | null, sessionId: string) => path.join(chatDir(projectId), `${sessionId}.images`);
/** save base64 images → ids continuing the session's numbering */
export function saveSessionImages(projectId: string | null, sessionId: string, images: { media_type: string; data: string }[]): string[] {
  if (!images.length) return [];
  const dir = imagesDir(projectId, sessionId);
  mkdirSync(dir, { recursive: true });
  let n = existsSync(dir) ? readdirSync(dir).filter((f) => IMAGE_ID_RE.test(f.replace(/\.\w+$/, ''))).length : 0;
  return images.map((im) => {
    const id = `img-${++n}`;
    writeFileSync(path.join(dir, `${id}.${EXT[im.media_type] ?? 'png'}`), Buffer.from(im.data, 'base64'));
    return id;
  });
}
// ---------- attached files: <chat dir>/<sessionId>.files/file-N/{<name>, <name>.txt (Office text), <zip stem>/ (unpacked), .meta.json} ----------
export const FILE_ID_RE = /^file-\d{1,4}$/;
export const filesDir = (projectId: string | null, sessionId: string) => path.join(chatDir(projectId), `${sessionId}.files`);
const OFFICE = new Set(['docx', 'xlsx', 'pptx']);
interface FileMeta { name: string; kind: AttachmentInfo['kind']; size: number; zipDir?: string; tree?: { path: string; size: number }[] }
/** unpack with safe paths only (no absolute / `..` / reserved names) — readZip already capped count + total size */
function unzipTo(buf: Buffer, dest: string): { tree: { path: string; size: number }[]; skipped: number } {
  const tree: { path: string; size: number }[] = [];
  let skipped = 0;
  for (const e of readZip(buf)) {
    const rel = safeEntryPath(e.name);
    if (!rel) { skipped++; continue; }
    try {
      const out = path.join(dest, rel);
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, e.read());
      tree.push({ path: rel, size: e.size });
    } catch {
      skipped++; // file/dir name clash, corrupt entry
    }
  }
  return { tree, skipped };
}
/** save + extract; pdfBudget = bytes still allowed inline in this conversation (PDFs are resent every turn) */
export function saveSessionFiles(projectId: string | null, sessionId: string, files: { name: string; buf: Buffer }[], pdfBudget = PDF_INLINE_BYTES): AttachmentInfo[] {
  if (!files.length) return [];
  const root = filesDir(projectId, sessionId);
  mkdirSync(root, { recursive: true });
  let n = readdirSync(root).filter((f) => FILE_ID_RE.test(f)).length;
  return files.map(({ name, buf }) => {
    const id = `file-${++n}`;
    const dir = path.join(root, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, name), buf);
    const info: AttachmentInfo = { id, name, kind: 'binary', size: buf.length };
    const meta: FileMeta = { name, kind: 'binary', size: buf.length };
    try {
      const r = extractText(name, buf);
      info.kind = meta.kind = r.kind;
      info.text = r.text;
      if (OFFICE.has(r.kind)) writeFileSync(path.join(dir, `${name}.txt`), r.text ?? '', 'utf8');
      if (r.kind === 'zip') {
        meta.zipDir = name.replace(/\.zip$/i, '') || 'unzipped';
        const u = unzipTo(buf, path.join(dir, meta.zipDir));
        info.tree = meta.tree = u.tree;
        info.skipped = u.skipped;
      }
      if (r.kind === 'pdf' && buf.length <= Math.min(PDF_INLINE_BYTES, pdfBudget)) {
        info.pdfBase64 = buf.toString('base64');
        pdfBudget -= buf.length;
      }
    } catch (err) {
      info.kind = meta.kind = /\.(docx|xlsx|pptx|zip)$/i.test(name) ? (name.split('.').pop()!.toLowerCase() as AttachmentInfo['kind']) : info.kind;
      info.error = err instanceof Error ? err.message : String(err);
    }
    writeFileSync(path.join(dir, '.meta.json'), JSON.stringify(meta), 'utf8');
    return info;
  });
}
const readMeta = (projectId: string | null, sessionId: string, id: string): FileMeta | null => {
  if (!FILE_ID_RE.test(id)) return null;
  try { return JSON.parse(readFileSync(path.join(filesDir(projectId, sessionId), id, '.meta.json'), 'utf8')); } catch { return null; }
};
const knownFiles = (projectId: string | null, sessionId: string) => {
  const root = filesDir(projectId, sessionId);
  return existsSync(root) ? readdirSync(root).filter((f) => FILE_ID_RE.test(f)) : [];
};
/** attachment_read: text of an attached file (or a file inside an attached zip), paged */
export function readSessionFile(projectId: string | null, sessionId: string, id: string, inner: string | undefined, offset: number): { ok: boolean; content: string } {
  const meta = readMeta(projectId, sessionId, id);
  if (!meta) return { ok: false, content: `unknown file id: ${id} — attached: ${knownFiles(projectId, sessionId).join(', ') || 'none'}` };
  const dir = path.join(filesDir(projectId, sessionId), id);
  let text: string | null;
  if (inner !== undefined) {
    if (meta.kind !== 'zip' || !meta.zipDir) return { ok: false, content: `${id} (${meta.name}) is not a zip — omit path` };
    const rel = safeEntryPath(inner);
    const f = rel && path.join(dir, meta.zipDir, rel);
    if (!f || !existsSync(f) || !statSync(f).isFile()) return { ok: false, content: `no such file in ${meta.name}: ${inner}` };
    if (statSync(f).size > 20 * 1024 * 1024) return { ok: false, content: `${inner} is too large to read here — hand ${id} to a worker via fleet_dispatch.files` };
    try {
      text = extractText(rel, readFileSync(f)).text;
    } catch (err) {
      return { ok: false, content: `could not read ${inner}: ${err instanceof Error ? err.message : err}` };
    }
    if (text === null) return { ok: true, content: `(${inner} is not readable as text here — hand ${id} to a worker via fleet_dispatch.files)` };
  } else if (meta.kind === 'zip') {
    return { ok: true, content: `${meta.name}: pass path= one of\n${(meta.tree ?? []).map((e) => e.path).join('\n')}` };
  } else if (OFFICE.has(meta.kind)) {
    text = existsSync(path.join(dir, `${meta.name}.txt`)) ? readFileSync(path.join(dir, `${meta.name}.txt`), 'utf8') : null;
  } else {
    text = meta.kind === 'text' ? decodeText(readFileSync(path.join(dir, meta.name))) : null;
  }
  if (text === null) return { ok: true, content: `(${meta.name} is a ${meta.kind} file — not readable as text here; hand ${id} to a worker via fleet_dispatch.files)` };
  return { ok: true, content: sliceText(text, offset) };
}
/** file ids → this session's attachment dirs (for fleet_dispatch.files) */
export function sessionFileDirs(projectId: string | null, sessionId: string, ids: string[]): { paths: string[] } | { error: string } {
  const paths: string[] = [];
  for (const id of [...new Set(ids)]) {
    if (!readMeta(projectId, sessionId, id)) return { error: `unknown file id: ${id} — attached: ${knownFiles(projectId, sessionId).join(', ') || 'none'}` };
    paths.push(path.join(filesDir(projectId, sessionId), id));
  }
  return { paths };
}
export const hasSessionFiles = (projectId: string | null, sessionId: string) => !!sessionId && knownFiles(projectId, sessionId).length > 0;

/** ids → absolute files of THIS session only (id format checked → no traversal) */
export function sessionImageFiles(projectId: string | null, sessionId: string, ids: string[]): { paths: string[] } | { error: string } {
  const dir = imagesDir(projectId, sessionId);
  const files = existsSync(dir) ? readdirSync(dir) : [];
  const paths: string[] = [];
  for (const id of [...new Set(ids)]) {
    const f = IMAGE_ID_RE.test(id) ? files.find((x) => x.replace(/\.\w+$/, '') === id) : undefined;
    if (!f) return { error: `unknown image id: ${id} — use ids named in the conversation (${files.map((x) => x.replace(/\.\w+$/, '')).join(', ') || 'none attached'})` };
    paths.push(path.join(dir, f));
  }
  return { paths };
}

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
  typeof m.content === 'string' ? m.content : m.content.flatMap((b) => (b.type === 'text' && !isSystemReminder(b.text) && !isAttachmentText(b.text) ? [b.text] : [])).join('\n');
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
      const images = Array.isArray(m.content) ? m.content.flatMap((b) => (b.type === 'image' ? [`data:${b.source.media_type};base64,${b.source.data}`] : [])) : [];
      const files = Array.isArray(m.content) ? m.content.flatMap((b) => (b.type === 'text' && isAttachmentText(b.text) ? [attachmentName(b.text)!] : [])) : [];
      if (t.trim() || images.length || files.length) messages.push({ role: 'user', text: t, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) }); // tool_result-only turn → skip
      continue;
    }
    const t = userText(m);
    if (t.trim()) messages.push({ role: 'orch', text: t });
    const tools = Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_use').map((b) => (b as { name: string }).name) : [];
    if (tools.length) messages.push({ role: 'step', text: `🔧 ${tools.join(', ')}` });
  }
  const u0 = messages.find((m) => m.role === 'user');
  const first = u0?.text.trim().replace(/\s+/g, ' ') || (u0?.files ? `📎 ${u0.files.join(', ')}` : u0?.images ? `🖼 ×${u0.images.length}` : '');
  return {
    history,
    messages,
    title: first.length > 60 ? first.slice(0, 59) + '…' : first || t('desktop.chat.untitled'),
    turns: messages.filter((m) => m.role === 'user').length,
  };
}
