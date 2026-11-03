// Memory layer — memory-interface-spec v0.1, part P4:
// layer 2 (episodic sqlite) · layer 3 (KB markdown) · layer 7 (fleet stats EMA)
// Principle: retrospective is the system of record; brains only store + query (§1)
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as yaml from 'js-yaml';

// FIX (bug from Desktop runtime): Electron 33 bundles Node 20 — NO node:sqlite (landed in 22.5+).
// Lazy require at point of use + graceful degrade: Desktop still runs, only episodic sqlite is dropped
// (JSONL mirror still written). CLI on Node 24 keeps everything.
type DatabaseSync = { prepare: (sql: string) => { run: (...v: unknown[]) => unknown; get: (...v: unknown[]) => any }; exec: (sql: string) => void; close: () => void };
function openSqliteOrNull(file: string): DatabaseSync | null {
  try {
    const req = createRequire(import.meta.url);
    const { DatabaseSync } = req('node:sqlite') as { DatabaseSync: new (f: string) => DatabaseSync };
    return new DatabaseSync(file);
  } catch {
    return null; // Electron Node 20 / environment without node:sqlite
  }
}

// ---------- Fleet stats (layer 7) — Role Policy §5 ----------
export interface TaskRecordLite {
  id: string;
  ts: string;
  node: string;
  role: string;
  worker: string; // routing.pick
  run: { exit: number | null; killed: boolean };
  scope_check?: { ok: boolean };
  usage?: { usd?: number | null } | null;
  outcome?: string;
  files_changed?: string[];
}

export interface FleetStat {
  worker: string;
  role: string;
  dispatched: number;
  passed: number;
  first_try: number;
  ema: number; // half-life decay 30d
  avg_cost_usd: number | null;
}

function readRecords(dir: string): TaskRecordLite[] {
  if (!existsSync(dir)) return [];
  const out: TaskRecordLite[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try {
      const r = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
      out.push({
        id: String(r.id ?? f),
        ts: String(r.ts ?? new Date().toISOString()),
        node: String(r.node ?? '?'),
        role: String(r.role ?? '?'),
        worker: String(r.routing?.pick ?? r.brief?.worker ?? '?'),
        run: r.run ?? { exit: null, killed: false },
        scope_check: r.scope_check,
        usage: r.usage ?? null,
        outcome: r.outcome,
        files_changed: r.artifacts?.files_changed,
      });
    } catch {
      /* bad record — skip, don't crash the aggregator */
    }
  }
  return out;
}

function passedRec(r: TaskRecordLite): boolean {
  if (r.outcome === 'no_change') return false;
  // old record (no outcome yet): an implement that changed no files is also a failure
  if (r.node === 'implement' && Array.isArray(r.files_changed) && r.files_changed.length === 0) return false;
  return !r.run.killed && r.run.exit === 0 && r.scope_check?.ok !== false;
}

export function buildFleetStats(tasksDir: string, decayDays = 30): Map<string, FleetStat> {
  const records = readRecords(tasksDir);
  const groups = new Map<string, TaskRecordLite[]>();
  for (const r of records) {
    // only aggregate executing nodes (implement/verify/review) — plan is read-only
    if (!['implement', 'verify', 'review', 'fix'].includes(r.node)) continue;
    const key = `${r.worker}|${r.role}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const stats = new Map<string, FleetStat>();
  const now = Date.now();
  for (const [key, list] of groups) {
    const [worker, role] = [key.split('|')[0]!, key.split('|')[1]!];
    let wSum = 0;
    let sSum = 0;
    let costSum = 0;
    let costN = 0;
    let passed = 0;
    let firstTry = 0;
    for (const r of list) {
      const ageDays = Math.max(0, (now - Date.parse(r.ts)) / 86_400_000);
      const w = Math.pow(0.5, ageDays / decayDays);
      wSum += w;
      sSum += w * (passedRec(r) ? 1 : 0);
      if (passedRec(r)) passed++;
      if (r.node === 'implement' && passedRec(r)) firstTry++;
      const usd = r.usage?.usd;
      if (typeof usd === 'number') {
        costSum += usd;
        costN++;
      }
    }
    stats.set(key, {
      worker,
      role,
      dispatched: list.length,
      passed,
      first_try: firstTry,
      ema: wSum > 0 ? sSum / wSum : 0,
      avg_cost_usd: costN > 0 ? costSum / costN : null,
    });
  }
  return stats;
}

export function statsKey(worker: string, role: string): string {
  return `${worker}|${role}`;
}

// ---------- Episodic sqlite (layer 2) ----------
export function openEpisodic(repo: string): DatabaseSync | null {
  const dir = path.join(repo, '.orchestra');
  mkdirSync(dir, { recursive: true });
  const db = openSqliteOrNull(path.join(dir, 'episodic.sqlite'));
  if (!db) return null;
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, ts TEXT, node TEXT, role TEXT, worker TEXT,
    exit INTEGER, scope_ok INTEGER, usd REAL, tokens_in INTEGER, tokens_out INTEGER
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, type TEXT, task_id TEXT, worker TEXT, detail TEXT
  )`);
  return db;
}

export function syncTasksToSqlite(repo: string): number {
  const db = openEpisodic(repo);
  if (!db) return 0; // node:sqlite unavailable (Electron Node 20) — episodic sqlite temporarily off
  const records = readRecords(path.join(repo, '.orchestra', 'tasks'));
  const insert = db.prepare(
    `INSERT OR REPLACE INTO tasks (id, ts, node, role, worker, exit, scope_ok, usd, tokens_in, tokens_out)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let n = 0;
  for (const r of records) {
    const rec = JSON.parse(readFileSync(path.join(repo, '.orchestra', 'tasks', `${r.id}.json`), 'utf8'));
    insert.run(
      r.id, r.ts, r.node, r.role, r.worker,
      r.run.exit ?? null,
      r.scope_check?.ok === false ? 0 : 1,
      r.usage?.usd ?? null,
      rec.usage?.tokens_in ?? null,
      rec.usage?.tokens_out ?? null,
    );
    n++;
  }
  db.close();
  return n;
}

// ---------- Feedback events (memory-interface §4.2) ----------
export type FeedbackType =
  | 'user_edit_after_merge'
  | 'verdict_rejected'
  | 'task_reassigned'
  | 'kill_misjudged'
  | 'kb_correction'
  | 'pipeline_modified';

export function addFeedback(repo: string, fb: { type: FeedbackType; taskId?: string; worker?: string; detail?: string }): void {
  const db = openEpisodic(repo);
  if (db) {
    db.prepare('INSERT INTO feedback (ts, type, task_id, worker, detail) VALUES (?, ?, ?, ?, ?)').run(
      new Date().toISOString(),
      fb.type,
      fb.taskId ?? null,
      fb.worker ?? null,
      fb.detail ?? null,
    );
    db.close();
  }
  // mirror JSONL — human-readable, synced via git
  appendFileSync(
    path.join(repo, '.orchestra', 'feedback.jsonl'),
    JSON.stringify({ ts: new Date().toISOString(), ...fb }) + '\n',
    'utf8',
  );
}

// ---------- Project KB (layer 3) — markdown + frontmatter, capped injection ----------
export interface KBEntry {
  id: string;
  title: string;
  scope: string[];
  tags: string[];
  pinned: boolean;
  source: string;
  path: string;
  text: string;
}

function parseFrontmatter(raw: string, file: string): KBEntry | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return null;
  try {
    const fm = yaml.load(m[1]!) as Record<string, unknown>;
    return {
      id: String(fm['id'] ?? path.basename(file, '.md')),
      title: String(fm['title'] ?? ''),
      scope: Array.isArray(fm['scope']) ? (fm['scope'] as string[]) : [],
      tags: Array.isArray(fm['tags']) ? (fm['tags'] as string[]) : [],
      pinned: fm['pinned'] === true,
      source: String(fm['source'] ?? 'manual'),
      path: file,
      text: (m[2] ?? '').trim(),
    };
  } catch {
    return null;
  }
}

export function loadKB(repo: string): KBEntry[] {
  const dir = path.join(repo, '.orchestra', 'kb');
  if (!existsSync(dir)) return [];
  const out: KBEntry[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
    const e = parseFrontmatter(readFileSync(path.join(dir, f), 'utf8'), f);
    if (e) out.push(e);
  }
  return out;
}

function globMatch(file: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = escaped.replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*');
  return new RegExp(`^${body}$`).test(file);
}

/** recallKB — always inject per §5: pinned first, then scope-match, token cap, log dropped (M3) */
export function recallKB(
  repo: string,
  filesInScope: string[],
  budgetTokens = 2000,
): { entries: KBEntry[]; injected: string; dropped: string[] } {
  const entries = loadKB(repo);
  const pinned = entries.filter((e) => e.pinned);
  const matched = entries
    .filter((e) => !e.pinned)
    .filter((e) =>
      e.scope.length === 0 ||
      e.scope.some((p) => filesInScope.some((f) => globMatch(f, p) || globMatch(p, f))),
    );
  const ordered = [...pinned, ...matched];
  const chosen: KBEntry[] = [];
  const dropped: string[] = [];
  let used = 0;
  for (const e of ordered) {
    const cost = Math.ceil((e.text.length + e.title.length) / 4);
    if (used + cost > budgetTokens) {
      dropped.push(e.id);
      continue;
    }
    used += cost;
    chosen.push(e);
  }
  const injected = chosen
    .map((e) => `[KB:${e.id}] ${e.title}\n${e.text}`)
    .join('\n\n');
  return { entries: chosen, injected, dropped };
}

export function writeKBEntry(repo: string, entry: KBEntry & { frontmatter: string }): string {
  const dir = path.join(repo, '.orchestra', 'kb');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${entry.id}.md`);
  writeFileSync(file, `---\n${entry.frontmatter}\n---\n\n${entry.text}\n`, 'utf8');
  return file;
}
