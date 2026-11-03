// Skills — mỗi skill = 1 thư mục có SKILL.md (frontmatter name/description/tags?/workers?) + references/ templates/ scripts/ assets/ tuỳ chọn.
// Lưu: global ~/.orchestra/skills/<name>/, project ~/.orchestra/projects/<id>/skills/<name>/ (project đè global cùng tên).
// Nguồn: tự viết | GitHub (clone → preview → install chọn lọc, ghim commit) | import ~/.claude/skills, ~/.codex/skills.
// Orchestra CHỈ copy file — KHÔNG BAO GIỜ chạy script nào trong skill.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { t } from './i18n/index.js';
import { orchestraHome, projectDir } from './home.js';

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SKILL_WORKERS = ['claude', 'codex'];
export const SKILL_FILE = 'SKILL.md';
export const SOURCE_FILE = '.orchestra-source.json';
const MAX_DESC = 1024; // theo spec Agent Skills (Claude Code/Codex): description ≤ 1024 ký tự
const MAX_BODY = 100_000;
const MAX_SKILL_BYTES = 5 * 1024 * 1024;
const LARGE_FILE = 1024 * 1024;
const CODEX_CAP = 12_000;
const PREVIEW_TTL = 10 * 60_000;

export type SkillScope = 'global' | 'project';
export interface SkillMeta {
  name: string;
  description: string;
  tags: string[];
  workers: string[];
}
export interface SkillSource {
  type: 'local' | 'github';
  url?: string;
  ref?: string;
  commit?: string;
  path?: string;
  installedAt: string;
}
export interface Skill extends SkillMeta {
  scope: SkillScope;
  body: string;
  source: SkillSource | null;
}
export interface SkillWarning {
  level: 'red' | 'yellow';
  code: 'script' | 'large' | 'suspicious';
  file: string;
}
export interface PreviewItem {
  name: string;
  description: string;
  origin: string;
  files: { path: string; size: number }[];
  bytes: number;
  warnings: SkillWarning[];
  /** có error = không cài được: symlink | tooBig | invalid | duplicate */
  error?: string;
  errorDetail?: string;
}
export interface Preview {
  previewId: string;
  source: { type: 'local' | 'github'; owner?: string; repo?: string; ref?: string; commit?: string; subpath?: string };
  skills: PreviewItem[];
}

// ---------- frontmatter ----------
export function parseSkillMd(raw: string): { meta: SkillMeta; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) throw new Error(t('core.skills.noFrontmatter'));
  const fm = (yaml.load(m[1]!) ?? {}) as Record<string, unknown>;
  const name = fm['name'];
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) throw new Error(t('core.skills.badName', { name: String(name ?? '') }));
  const description = typeof fm['description'] === 'string' ? fm['description'].trim() : '';
  if (!description || description.length > MAX_DESC) throw new Error(t('core.skills.badDescription', { max: MAX_DESC }));
  const tags = fm['tags'] ?? [];
  if (!Array.isArray(tags) || tags.some((x) => typeof x !== 'string')) throw new Error(t('core.skills.badTags'));
  const workers = fm['workers'] ?? SKILL_WORKERS;
  if (!Array.isArray(workers) || !workers.length || workers.some((w) => !SKILL_WORKERS.includes(w as string)))
    throw new Error(t('core.skills.badWorkers', { workers: SKILL_WORKERS.join('|') }));
  return { meta: { name, description, tags: tags as string[], workers: [...new Set(workers as string[])] }, body: (m[2] ?? '').trim() };
}

// ---------- storage ----------
export function skillsDir(scope: SkillScope, projectId?: string | null): string {
  if (scope === 'global') return path.join(orchestraHome(), 'skills');
  if (scope !== 'project' || !projectId) throw new Error(t('core.skills.needProject'));
  return path.join(projectDir(projectId), 'skills');
}
function skillDir(scope: SkillScope, projectId: string | null | undefined, name: string): string {
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) throw new Error(t('core.skills.badName', { name: String(name) }));
  return path.join(skillsDir(scope, projectId), name);
}
function readSource(dir: string): SkillSource | null {
  try {
    return JSON.parse(readFileSync(path.join(dir, SOURCE_FILE), 'utf8')) as SkillSource;
  } catch {
    return null;
  }
}
function readScope(scope: SkillScope, projectId?: string | null): Skill[] {
  const dir = skillsDir(scope, projectId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (!d.isDirectory() || !SKILL_NAME_RE.test(d.name)) return [];
    try {
      const { meta, body } = parseSkillMd(readFileSync(path.join(dir, d.name, SKILL_FILE), 'utf8'));
      return meta.name === d.name ? [{ ...meta, scope, body, source: readSource(path.join(dir, d.name)) }] : [];
    } catch {
      return []; // SKILL.md hỏng → bỏ qua, không chặn cả danh sách
    }
  });
}
/** mọi skill (global + project nếu có) — UI liệt kê cả 2 với badge scope */
export const listSkills = (projectId?: string | null): Skill[] => [...readScope('global'), ...(projectId ? readScope('project', projectId) : [])];
/** skill hiệu lực: project đè global cùng tên, sort theo tên */
export function availableSkills(projectId?: string | null): Skill[] {
  const m = new Map<string, Skill>();
  for (const s of listSkills(projectId)) m.set(s.name, s);
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function saveSkill(
  scope: SkillScope,
  projectId: string | null | undefined,
  s: { name: string; description: string; workers?: string[]; tags?: string[]; body: string },
): Skill {
  const dir = skillDir(scope, projectId, s?.name);
  if (readSource(dir)?.type === 'github') throw new Error(t('core.skills.notLocal', { name: s.name }));
  if (typeof s.body !== 'string' || s.body.length > MAX_BODY) throw new Error(t('core.skills.bodyTooLong', { max: MAX_BODY }));
  const fm = { name: s.name, description: s.description, workers: s.workers?.length ? s.workers : SKILL_WORKERS, ...(s.tags?.length ? { tags: s.tags } : {}) };
  const raw = `---\n${yaml.dump(fm, { lineWidth: -1 }).trimEnd()}\n---\n\n${s.body.trim()}\n`;
  const { meta, body } = parseSkillMd(raw); // validate đúng như lúc đọc lại
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, SKILL_FILE), raw, 'utf8');
  const source = readSource(dir) ?? { type: 'local' as const, installedAt: new Date().toISOString() };
  if (!existsSync(path.join(dir, SOURCE_FILE))) writeFileSync(path.join(dir, SOURCE_FILE), JSON.stringify(source, null, 2), 'utf8');
  return { ...meta, scope, body, source };
}

export function removeSkill(scope: SkillScope, projectId: string | null | undefined, name: string): void {
  rmSync(skillDir(scope, projectId, name), { recursive: true, force: true });
}

// ---------- GitHub ----------
export interface GithubRef {
  owner: string;
  repo: string;
  ref?: string;
  subpath?: string;
}
// ponytail: ref chứa '/' (vd feature/x) không hỗ trợ — /tree/<ref> lấy 1 segment; cần thì thêm ô ref riêng ở UI
const GH_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([\w.-]+)(?:\/([\w./-]+?))?)?\/?$/;
export function parseGithubUrl(url: unknown): GithubRef {
  const m = typeof url === 'string' && !url.includes('..') ? GH_RE.exec(url.trim()) : null;
  if (!m || [m[1], m[2], m[3]].some((x) => x?.startsWith('-'))) throw new Error(t('core.skills.badUrl'));
  return { owner: m[1]!, repo: m[2]!, ...(m[3] ? { ref: m[3] } : {}), ...(m[4] ? { subpath: m[4] } : {}) };
}
const repoUrl = (g: GithubRef): string => `https://github.com/${g.owner}/${g.repo}`;
/** test inject (bare repo local) — không mạng */
let cloneUrlFor = (g: GithubRef): string => `${repoUrl(g)}.git`;
export const setCloneUrlFor = (fn: (g: GithubRef) => string): void => {
  cloneUrlFor = fn;
};

function git(cwd: string, args: string[], timeout = 30_000): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

function clone(g: GithubRef): { dir: string; commit: string; symlinks: string[] } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orchestra-skill-'));
  const args = ['clone', '--depth', '1', ...(g.ref ? ['--branch', g.ref] : []), '--filter=blob:none', '--', cloneUrlFor(g), dir];
  const r = git(os.tmpdir(), args, 60_000);
  const head = r.ok ? git(dir, ['rev-parse', 'HEAD']) : r;
  if (!head.ok) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(t('core.skills.cloneFailed', { out: head.out.slice(0, 500) }));
  }
  // symlink theo git (mode 120000) — Windows không có core.symlinks sẽ checkout thành file thường, lstat không thấy
  const tree = git(dir, ['ls-tree', '-r', '--full-tree', 'HEAD']).out.split(/\r?\n/);
  const symlinks = tree.filter((l) => l.startsWith('120000 ')).map((l) => l.slice(l.indexOf('\t') + 1));
  return { dir, commit: head.out.split(/\r?\n/).pop()!.trim(), symlinks };
}

/** thư mục có SKILL.md dưới start (sâu ≤4, tối đa 50) — gặp skill thì không đi sâu tiếp */
function findSkillDirs(start: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (out.length >= 50 || !existsSync(dir) || !lstatSync(dir).isDirectory()) return;
    if (existsSync(path.join(dir, SKILL_FILE))) return void out.push(dir);
    if (depth >= 4) return;
    for (const d of readdirSync(dir, { withFileTypes: true }))
      if (d.isDirectory() && d.name !== '.git' && d.name !== 'node_modules') walk(path.join(dir, d.name), depth + 1);
  };
  walk(start, 0);
  return out;
}

function listFiles(dir: string): { path: string; size: number; symlink: boolean }[] {
  const out: { path: string; size: number; symlink: boolean }[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === SOURCE_FILE) continue;
      const p = path.join(d, e.name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else out.push({ path: path.relative(dir, p).split(path.sep).join('/'), size: st.size, symlink: st.isSymbolicLink() });
    }
  };
  walk(dir);
  return out;
}

const EXEC_EXT = /\.(sh|ps1|bat|cmd|exe|js|py)$/i;
const SUSPICIOUS = [
  /ignore (all )?(the )?(previous|prior|above) instructions/i,
  /(curl|wget)[^\n|]*\|\s*(sudo\s+)?(ba|z)?sh\b/i,
  /exfiltrat/i,
  /[A-Za-z0-9+/=]{2048,}/, // base64 blob > 2KB
];

function buildItem(dir: string, origin: string, gitSymlinks: string[] = [], relDir = ''): PreviewItem {
  const files = listFiles(dir);
  const bytes = files.reduce((n, f) => n + f.size, 0);
  const warnings: SkillWarning[] = [];
  for (const f of files) {
    if (f.path.startsWith('scripts/') || EXEC_EXT.test(f.path)) warnings.push({ level: 'yellow', code: 'script', file: f.path });
    if (f.size > LARGE_FILE) warnings.push({ level: 'yellow', code: 'large', file: f.path });
    else if (!f.symlink && SUSPICIOUS.some((re) => re.test(readFileSync(path.join(dir, f.path), 'utf8'))))
      warnings.push({ level: 'red', code: 'suspicious', file: f.path });
  }
  const item: PreviewItem = { name: path.basename(dir), description: '', origin, files: files.map((f) => ({ path: f.path, size: f.size })), bytes, warnings };
  const prefix = relDir ? `${relDir}/` : '';
  if (files.some((f) => f.symlink) || gitSymlinks.some((s) => s.startsWith(prefix))) item.error = 'symlink';
  else if (bytes > MAX_SKILL_BYTES) item.error = 'tooBig';
  try {
    const { meta } = parseSkillMd(readFileSync(path.join(dir, SKILL_FILE), 'utf8'));
    item.name = meta.name;
    item.description = meta.description;
  } catch (err) {
    item.error ??= 'invalid';
    item.errorDetail = err instanceof Error ? err.message : String(err);
  }
  return item;
}

interface PreviewEntry {
  tmp?: string;
  github?: GithubRef & { commit: string };
  dirs: Map<string, { dir: string; rel: string; origin: string }>;
  timer: NodeJS.Timeout;
}
const previews = new Map<string, PreviewEntry>();

function register(
  items: { dir: string; rel: string; origin: string; item: PreviewItem }[],
  extra: { tmp?: string; github?: PreviewEntry['github'] },
): string {
  const id = randomUUID();
  const dirs = new Map<string, { dir: string; rel: string; origin: string }>();
  for (const x of items) {
    if (!x.item.error && dirs.has(x.item.name)) x.item.error = 'duplicate';
    if (!x.item.error) dirs.set(x.item.name, { dir: x.dir, rel: x.rel, origin: x.origin });
  }
  const timer = setTimeout(() => cancelPreview(id), PREVIEW_TTL);
  timer.unref();
  previews.set(id, { ...extra, dirs, timer });
  return id;
}

export function cancelPreview(previewId: string): void {
  const p = previews.get(previewId);
  if (!p) return;
  clearTimeout(p.timer);
  if (p.tmp) rmSync(p.tmp, { recursive: true, force: true });
  previews.delete(previewId);
}

export function previewGithub(url: string): Preview {
  const g = parseGithubUrl(url);
  const c = clone(g);
  try {
    const items = findSkillDirs(path.join(c.dir, g.subpath ?? '')).map((dir) => {
      const rel = path.relative(c.dir, dir).split(path.sep).join('/');
      return { dir, rel, origin: `${g.owner}/${g.repo}`, item: buildItem(dir, `${g.owner}/${g.repo}`, c.symlinks, rel) };
    });
    const previewId = register(items, { tmp: c.dir, github: { ...g, commit: c.commit } });
    return { previewId, source: { type: 'github', ...g, commit: c.commit }, skills: items.map((x) => x.item) };
  } catch (err) {
    rmSync(c.dir, { recursive: true, force: true });
    throw err;
  }
}

/** ~/.claude/skills/*\/SKILL.md + ~/.codex/skills/*\/SKILL.md — roots inject được cho test */
export function previewLocal(roots: { origin: string; dir: string }[] = defaultLocalRoots()): Preview {
  const items = roots.flatMap((r) =>
    (existsSync(r.dir) ? readdirSync(r.dir, { withFileTypes: true }) : [])
      .filter((d) => d.isDirectory() && existsSync(path.join(r.dir, d.name, SKILL_FILE)))
      .map((d) => {
        const dir = path.join(r.dir, d.name);
        return { dir, rel: dir, origin: r.origin, item: buildItem(dir, r.origin) };
      }),
  );
  return { previewId: register(items, {}), source: { type: 'local' }, skills: items.map((x) => x.item) };
}
const defaultLocalRoots = (): { origin: string; dir: string }[] => [
  { origin: 'claude', dir: path.join(os.homedir(), '.claude', 'skills') },
  { origin: 'codex', dir: path.join(os.homedir(), '.codex', 'skills') },
];

export function installSkills(o: { previewId: string; names: string[]; scope: SkillScope; projectId?: string | null }): string[] {
  const p = previews.get(o.previewId);
  if (!p) throw new Error(t('core.skills.noPreview'));
  if (!Array.isArray(o.names) || !o.names.length) throw new Error(t('core.skills.notInPreview', { name: '' }));
  for (const n of o.names) if (typeof n !== 'string' || !p.dirs.has(n)) throw new Error(t('core.skills.notInPreview', { name: String(n) }));
  skillsDir(o.scope, o.projectId); // validate scope/project trước khi đụng đĩa
  for (const name of o.names) {
    const src = p.dirs.get(name)!;
    const dest = skillDir(o.scope, o.projectId, name);
    rmSync(dest, { recursive: true, force: true });
    cpSync(src.dir, dest, { recursive: true, filter: (f) => path.basename(f) !== '.git' && path.basename(f) !== SOURCE_FILE });
    const source: SkillSource = p.github
      ? { type: 'github', url: repoUrl(p.github), ...(p.github.ref ? { ref: p.github.ref } : {}), commit: p.github.commit, path: src.rel, installedAt: new Date().toISOString() }
      : { type: 'local', path: src.dir, installedAt: new Date().toISOString() };
    writeFileSync(path.join(dest, SOURCE_FILE), JSON.stringify(source, null, 2), 'utf8');
  }
  cancelPreview(o.previewId);
  return o.names;
}

export interface UpdateCheck {
  upToDate: boolean;
  commit: string;
  newCommit: string;
  changed: { path: string; status: 'added' | 'removed' | 'modified' }[];
  /** chỉ có khi có bản mới — truyền cho updateSkill (user bấm) */
  previewId?: string;
  item?: PreviewItem;
}

/** clone lại, so commit + file — KHÔNG ghi gì; áp dụng chỉ qua updateSkill */
export function checkUpdate(scope: SkillScope, projectId: string | null | undefined, name: string): UpdateCheck {
  const dir = skillDir(scope, projectId, name);
  const src = readSource(dir);
  if (src?.type !== 'github' || !src.url) throw new Error(t('core.skills.notGithub', { name }));
  const g = { ...parseGithubUrl(src.url), ...(src.ref ? { ref: src.ref } : {}) };
  const c = clone(g);
  if (c.commit === src.commit) {
    rmSync(c.dir, { recursive: true, force: true });
    return { upToDate: true, commit: src.commit, newCommit: c.commit, changed: [] };
  }
  const newDir = path.join(c.dir, src.path ?? '');
  const item = existsSync(path.join(newDir, SKILL_FILE))
    ? buildItem(newDir, `${g.owner}/${g.repo}`, c.symlinks, src.path ?? '')
    : { name, description: '', origin: `${g.owner}/${g.repo}`, files: [], bytes: 0, warnings: [], error: 'invalid' };
  if (!item.error && item.name !== name) item.error = 'invalid';
  const oldFiles = new Set(listFiles(dir).map((f) => f.path));
  const newFiles = new Set(item.files.map((f) => f.path));
  const changed: UpdateCheck['changed'] = [];
  for (const f of new Set([...oldFiles, ...newFiles])) {
    if (!oldFiles.has(f)) changed.push({ path: f, status: 'added' });
    else if (!newFiles.has(f)) changed.push({ path: f, status: 'removed' });
    else if (!readFileSync(path.join(dir, f)).equals(readFileSync(path.join(newDir, f)))) changed.push({ path: f, status: 'modified' });
  }
  const previewId = register([{ dir: newDir, rel: src.path ?? '', origin: item.origin, item }], { tmp: c.dir, github: { ...g, commit: c.commit } });
  return { upToDate: false, commit: src.commit ?? '', newCommit: c.commit, changed, previewId, item };
}

export const updateSkill = (o: { previewId: string; name: string; scope: SkillScope; projectId?: string | null }): string[] =>
  installSkills({ previewId: o.previewId, names: [o.name], scope: o.scope, projectId: o.projectId });

// ---------- delivery vào worktree của task ----------
export interface SkillDelivery {
  delivered: string[];
  skipped: { name: string; reason: 'unknown' | 'worker' | 'cap' | 'exists' }[];
  /** nối vào prompt của worker */
  prompt: string;
}

/** Copy skill vào worktree, kèm `.gitignore` = `*` trong thư mục copy → git status/add -A không thấy, không vào
 *  files_changed, không merge. (Không ghi info/exclude: worktree linked dùng chung exclude với repo chính.) */
function copyIntoWorktree(wtPath: string, rel: string, src: string, onlySupport: boolean): boolean {
  const dest = path.join(wtPath, rel);
  if (git(wtPath, ['ls-files', '--', rel]).out) return false; // repo tự có skill cùng tên (tracked) → giữ của repo
  rmSync(dest, { recursive: true, force: true }); // bản copy cũ (worktree tái dùng: verify/review/fix)
  cpSync(src, dest, {
    recursive: true,
    filter: (f) => ![SOURCE_FILE, '.git'].includes(path.basename(f)) && !(onlySupport && f === path.join(src, SKILL_FILE)),
  });
  writeFileSync(path.join(dest, '.gitignore'), '*\n', 'utf8');
  return true;
}

export function deliverSkills(wtPath: string, worker: string, names: string[], projectId?: string | null): SkillDelivery {
  const avail = new Map(availableSkills(projectId).map((s) => [s.name, s]));
  const out: SkillDelivery = { delivered: [], skipped: [], prompt: '' };
  const sections: string[] = [];
  let used = 0;
  for (const name of [...new Set(names)]) {
    const s = avail.get(name);
    if (!s) {
      out.skipped.push({ name, reason: 'unknown' });
      continue;
    }
    if (!s.workers.includes(worker)) {
      out.skipped.push({ name, reason: 'worker' });
      continue;
    }
    const src = path.join(skillsDir(s.scope, projectId), name);
    if (worker === 'claude') {
      if (!copyIntoWorktree(wtPath, `.claude/skills/${name}`, src, false)) out.skipped.push({ name, reason: 'exists' });
      else out.delivered.push(name);
      continue;
    }
    // codex: nội dung vào prompt (trần CODEX_CAP), file phụ trợ copy sang .orchestra/skills/<name>/
    let section = `## ${name}\n${s.description}\n${s.body}`;
    const hasSupport = listFiles(src).some((f) => f.path !== SKILL_FILE);
    if (hasSupport) section += `\n(Supporting files for this skill: .orchestra/skills/${name}/)`;
    if (used + section.length > CODEX_CAP) {
      out.skipped.push({ name, reason: 'cap' });
      continue;
    }
    if (hasSupport) copyIntoWorktree(wtPath, `.orchestra/skills/${name}`, src, true);
    used += section.length;
    sections.push(section);
    out.delivered.push(name);
  }
  if (worker === 'claude' && out.delivered.length)
    out.prompt = `\n\nSKILLS (installed in .claude/skills/ for this task — use them when relevant): ${out.delivered.join(', ')}`;
  else if (sections.length) out.prompt = `\n\nSKILLS (follow when relevant to the task):\n\n${sections.join('\n\n')}`;
  return out;
}
