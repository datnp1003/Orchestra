// Long-term memory of the Orchestra brain — global (~/.orchestra/memory.md: user preferences, general facts)
// + per project (~/.orchestra/projects/<id>/memory.md). Markdown file, one "- ..." line per entry.
// Written automatically (memory_update tool + background reflection); every write goes through redactSecrets.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { memoryFile } from './home.js';
import { t } from './i18n/index.js';
import type { Msg } from './brain.js';
import { isSystemReminder } from './permissions.js';
import { isAttachmentText } from './attachments.js';

export type Scope = 'global' | 'project';
export const BUDGET: Record<Scope, number> = { global: 3000, project: 5000 };
export interface MemoryOp {
  action: 'add' | 'replace' | 'remove';
  text?: string;
  old_text?: string;
}
export interface ScopedOp extends MemoryOp {
  scope: Scope;
}
/** 1 Messages API turn (system + 1 user message) → returned text */
export type CallModel = (system: string, user: string) => Promise<string>;

// ponytail: heuristic — long tokens containing '/' (standard base64) get split so may leak; need a real entropy scanner if leaks show up
const SECRET_RES: [RegExp, string][] = [
  [/sk-ant-[\w-]+/g, '[REDACTED]'],
  [/\bsk-[\w-]{8,}/g, '[REDACTED]'],
  [/\bBearer\s+[\w.~+/=-]+/gi, 'Bearer [REDACTED]'],
  [/\b([\w-]*(?:key|token|secret|password))(\s*=\s*)[^\s,;\x27\x22]+/gi, '$1$2[REDACTED]'],
  [/\b[0-9a-f]{32,}\b/gi, '[REDACTED]'],
];
export function redactSecrets(s: string): string {
  let out = s;
  for (const [re, rep] of SECRET_RES) out = out.replace(re, rep);
  // base64/random ≥32 chars: only when mixing upper + lower + digits (long kebab/snake names untouched)
  return out.replace(/[A-Za-z0-9+_=-]{32,}/g, (m) => (/\d/.test(m) && /[a-z]/.test(m) && /[A-Z]/.test(m) ? '[REDACTED]' : m));
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
/** text → entry bodies (strip "- "); a line without "- " (hand-edited by user) is still 1 entry */
const toEntries = (text: string): string[] =>
  text.split(/\r?\n/).map((l) => l.trim().replace(/^[-*]\s*/, '').trim()).filter(Boolean);
const fromEntries = (list: string[]) => list.map((e) => `- ${e}`).join('\n');
export const normalizeMemory = (text: string): string => fromEntries(toEntries(redactSecrets(text)));

/** keep the newest entries (end of file) that fit the budget — deterministic fallback when over budget */
export function fitNewest(text: string, budget: number): string {
  const keep: string[] = [];
  let used = 0;
  for (const e of toEntries(text).reverse()) {
    const cost = e.length + 3; // "- " + "\n"
    if (used + cost - 1 > budget) break;
    used += cost;
    keep.unshift(e);
  }
  return fromEntries(keep);
}

export function applyMemoryOps(text: string, ops: MemoryOp[]): { ok: true; text: string; changed: boolean } | { ok: false; error: string } {
  const list = toEntries(text);
  let changed = false;
  for (const op of ops) {
    const body = typeof op.text === 'string' ? redactSecrets(oneLine(op.text)) : '';
    if (op.action === 'add') {
      if (!body) return { ok: false, error: 'add needs non-empty text' };
      if (!list.includes(body)) {
        list.push(body);
        changed = true;
      }
      continue;
    }
    if (op.action !== 'replace' && op.action !== 'remove') return { ok: false, error: `unknown action: ${String(op.action)}` };
    const old = typeof op.old_text === 'string' ? oneLine(op.old_text) : '';
    if (!old) return { ok: false, error: `${op.action} needs old_text (a unique substring of one entry)` };
    const hits = list.flatMap((e, i) => (e.includes(old) ? [i] : []));
    if (hits.length !== 1) return { ok: false, error: hits.length ? `old_text matches ${hits.length} entries — be more specific` : `no entry contains old_text: ${old}` };
    if (op.action === 'replace' && !body) return { ok: false, error: 'replace needs non-empty text' };
    if (op.action === 'remove') list.splice(hits[0]!, 1);
    else list[hits[0]!] = body;
    changed = true;
  }
  return { ok: true, text: fromEntries(list), changed };
}

export const loadMemory = (projectId: string | null): string => {
  const f = memoryFile(projectId);
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
};
function writeAtomic(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text ? text + '\n' : '', 'utf8');
  renameSync(tmp, file);
}

/** memory:set (hand-edited by user) — redact + normalize; over budget → error, no write */
export function setMemoryText(projectId: string | null, text: string): { ok: boolean; text: string; used: number; budget: number; error?: string } {
  const budget = BUDGET[projectId ? 'project' : 'global'];
  const out = normalizeMemory(text);
  if (out.length > budget) return { ok: false, text: out, used: out.length, budget, error: t('core.memory.overBudget', { used: out.length, budget }) };
  writeAtomic(memoryFile(projectId), out);
  return { ok: true, text: out, used: out.length, budget };
}

/** memory block for the system prompt — sessions outside a project NEVER get project memory */
export function renderMemoryBlock(global: string, project?: { name: string; text: string }): string {
  const sec = (title: string, text: string, budget: number) => `${title}\n${fitNewest(text, budget) || '(empty)'}`;
  return [
    sec('USER/GLOBAL MEMORY:', global, BUDGET.global),
    ...(project ? [sec(`PROJECT MEMORY (${project.name}):`, project.text, BUDGET.project)] : []),
  ].join('\n\n');
}

const REFLECT_SYSTEM = `You maintain the long-term memory of an AI coding orchestrator.
Given CURRENT MEMORY and the RECENT CONVERSATION, return ONLY JSON:
{"ops":[{"scope":"global"|"project","action":"add"|"replace"|"remove","text":"...","old_text":"..."}]}
- Save durable facts only: decisions, conventions, architecture, the role of each repo in the microservice set, recurring pitfalls, user preferences.
- User preferences / style → scope "global". Project facts → scope "project".
- One short line per entry. replace/remove: old_text = a unique substring of the existing entry.
- Never save secrets (keys, tokens, passwords), transient task progress, or duplicates of existing entries.
- Prefer "replace" over "add" when updating an existing fact.
- Nothing new worth keeping → {"ops":[]}.`;

const isScope = (v: unknown): v is Scope => v === 'global' || v === 'project';
const optS = (v: unknown) => v === undefined || typeof v === 'string';
/** first JSON in the model output; malformed → [] (no-op) */
export function parseOps(raw: string): ScopedOp[] {
  let j: { ops?: unknown };
  try {
    j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(j?.ops)) return [];
  return j.ops.flatMap((o: Record<string, unknown>) => {
    if (!o || !isScope(o.scope) || !['add', 'replace', 'remove'].includes(o.action as string) || !optS(o.text) || !optS(o.old_text)) return [];
    return [{ scope: o.scope, action: o.action as MemoryOp['action'], ...(o.text !== undefined ? { text: o.text as string } : {}), ...(o.old_text !== undefined ? { old_text: o.old_text as string } : {}) }];
  });
}

export async function reflectMemory(o: { callModel: CallModel; global: string; project?: { name: string; text: string }; transcript: string }): Promise<ScopedOp[]> {
  const system = REFLECT_SYSTEM + (o.project ? '' : '\nThis conversation is NOT in a project: use scope "global" only.');
  const raw = await o.callModel(system, `CURRENT MEMORY:\n${renderMemoryBlock(o.global, o.project)}\n\nRECENT CONVERSATION:\n${o.transcript}`);
  return parseOps(raw).filter((op) => o.project || op.scope === 'global');
}

export async function consolidateMemory(o: { callModel: CallModel; text: string; budget: number }): Promise<string> {
  let out = o.text;
  try {
    const raw = await o.callModel(
      `You compact the long-term memory of an AI coding orchestrator to at most ${o.budget} characters: merge duplicates, drop stale or superseded entries, keep durable facts. Output ONLY lines starting with "- ", one fact per line.`,
      o.text,
    );
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().startsWith('- ')).join('\n');
    if (lines) out = normalizeMemory(lines);
  } catch {
    /* model error → deterministic fallback below */
  }
  return out.length <= o.budget ? out : fitNewest(out, o.budget);
}

/** apply ops to the memory file (re-reads latest); bad ops skipped + reported; over budget → consolidate */
export async function writeMemoryOps(projectId: string | null, ops: ScopedOp[], callModel?: CallModel): Promise<{ applied: ScopedOp[]; errors: string[] }> {
  const applied: ScopedOp[] = [];
  const errors: string[] = [];
  for (const scope of ['global', 'project'] as const) {
    const mine = ops.filter((o) => o.scope === scope);
    if (!mine.length) continue;
    if (scope === 'project' && !projectId) {
      errors.push('scope "project" is only available inside a project — use "global"');
      continue;
    }
    const id = scope === 'project' ? projectId : null;
    let text = loadMemory(id);
    let changed = false;
    for (const op of mine) {
      const r = applyMemoryOps(text, [op]);
      if (!r.ok) errors.push(r.error);
      else if (r.changed) {
        text = r.text;
        changed = true;
        applied.push(op);
      }
    }
    if (!changed) continue;
    // ponytail: read → (await consolidate) → write without locking; 2 concurrent writers may lose an op → lock file if seen
    if (text.length > BUDGET[scope]) text = callModel ? await consolidateMemory({ callModel, text, budget: BUDGET[scope] }) : fitNewest(text, BUDGET[scope]);
    writeAtomic(memoryFile(id), text);
  }
  return { applied, errors };
}

/** transcript for reflection: user + assistant text only (no tool_result), keeps the tail */
export function transcriptOf(msgs: Msg[], max = 8000): string {
  const s = msgs
    .flatMap((m) => {
      const txt = typeof m.content === 'string' ? m.content : m.content.flatMap((b) => (b.type === 'text' && !isSystemReminder(b.text) && !isAttachmentText(b.text) ? [b.text] : [])).join('\n');
      return txt.trim() ? [`${m.role.toUpperCase()}: ${txt.trim()}`] : [];
    })
    .join('\n\n');
  return s.length > max ? `…${s.slice(-max)}` : s;
}

const SIGN = { add: '+', replace: '~', remove: '−' } as const;
/** summary for the chat step line (redacted) */
export const summarizeOps = (ops: ScopedOp[]): string =>
  ops.map((o) => `${SIGN[o.action]}${o.scope}: ${redactSecrets(oneLine(o.text ?? o.old_text ?? '')).slice(0, 60)}`).join(' · ');
