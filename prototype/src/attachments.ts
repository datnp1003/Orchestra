// Chat attachments → something the brain can read. Stdlib only (no document parsers added):
// text/code → UTF-8; docx/xlsx/pptx are zip + XML → their text; pdf → native document block (Claude models);
// zip → unpacked with path/size/count caps, the brain gets its file list. Anything else is stored for workers only.
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { Block } from './brain.js';

export const MAX_INLINE_CHARS = 50_000;
export const READ_PAGE = 18_000; // attachment_read page — under the brain's 20k tool-result cap so the "offset=" pointer survives
export const PDF_INLINE_BYTES = 10 * 1024 * 1024; // base64 ≈ 13.3 MB — leaves room for history under the router body cap
export const ZIP_LIMITS = { entries: 5000, bytes: 200 * 1024 * 1024 };
export const LEGACY_OFFICE_RE = /\.(doc|xls|ppt)$/i;
export type AttachKind = 'text' | 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'zip' | 'binary';

const extOf = (name: string) => /\.([^./\\]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
export function kindOf(name: string, buf: Buffer): AttachKind {
  const ext = extOf(name);
  if (ext === 'pdf' || ext === 'docx' || ext === 'xlsx' || ext === 'pptx' || ext === 'zip') return ext;
  return decodeText(buf) === null ? 'binary' : 'text';
}
/** UTF-8 text (BOM dropped) or null: NUL bytes / invalid UTF-8 = binary */
// ponytail: UTF-16 text (some Excel CSV exports) counts as binary — add a BOM sniff if users hit it
export function decodeText(buf: Buffer): string | null {
  if (buf.subarray(0, 8192).includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

// ---------- zip (central directory; no zip64 / encryption) ----------
export interface ZipEntry { name: string; size: number; read: () => Buffer }
export function readZip(buf: Buffer, limits = ZIP_LIMITS): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error('zip64 archives are not supported');
  if (count > limits.entries) throw new Error(`too many files in zip: ${count} (max ${limits.entries})`);
  const entries: ZipEntry[] = [];
  let total = 0;
  for (let k = 0; k < count; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip (central directory)');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), off = buf.readUInt32LE(p + 42);
    // ponytail: names read as UTF-8 even without the UTF-8 flag — CP437 names from very old tools come out garbled
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error(`encrypted zip entry: ${name}`);
    if (method !== 0 && method !== 8) throw new Error(`unsupported zip compression (method ${method}): ${name}`);
    total += size;
    if (total > limits.bytes) throw new Error(`zip unpacks to more than ${limits.bytes / 1024 / 1024} MB`);
    entries.push({
      name,
      size,
      read: () => {
        if (off + 30 > buf.length || buf.readUInt32LE(off) !== 0x04034b50) throw new Error(`corrupt zip entry: ${name}`);
        const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
        const raw = buf.subarray(start, start + csize);
        // the declared size caps the output → a header that lies can't inflate a bomb
        const data = method === 0 ? raw : size ? inflateRawSync(raw, { maxOutputLength: size }) : Buffer.alloc(0);
        if (data.length !== size) throw new Error(`corrupt zip entry (size): ${name}`);
        return data;
      },
    });
  }
  return entries;
}
/** zip entry / file name → safe relative path (forward slashes) or null: absolute, drive, `..`, reserved chars/names */
export function safeEntryPath(name: string): string | null {
  const n = name.replace(/\\/g, '/');
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n)) return null;
  const parts = n.split('/').filter((s) => s && s !== '.');
  const bad = (s: string) => s === '..' || /[<>:"|?*\x00-\x1f]/.test(s) || /[. ]$/.test(s) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s);
  return parts.length && !parts.some(bad) ? parts.join('/') : null;
}

// ---------- Office XML → text ----------
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    if (e[0] !== '#') return ENT[e.toLowerCase()] ?? m;
    const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
const tidy = (s: string) => s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const attr = (tag: string, a: string) => new RegExp(`\\s${a}="([^"]*)"`).exec(tag)?.[1];
type Zip = Map<string, ZipEntry>;
const readXml = (z: Zip, p: string) => z.get(p)?.read().toString('utf8');

/** paragraphs → lines, table rows → `a | b` lines; only <w:t> text (no field codes / deleted text) */
function docxText(z: Zip): string {
  const xml = readXml(z, 'word/document.xml');
  if (xml === undefined) throw new Error('not a Word document (word/document.xml missing)');
  let out = '';
  let inCell = 0;
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\b[^>]*\/>|<w:cr\/>|<w:tc(?:\s[^>]*)?>|<\/w:tc>|<\/w:tr>|<\/w:p>/g)) {
    const tok = m[0];
    if (m[1] !== undefined) out += unxml(m[1]);
    else if (tok === '<w:tab/>') out += '\t';
    else if (tok.startsWith('<w:tc')) inCell++;
    else if (tok === '</w:tc>') { inCell--; out = `${out.trimEnd()} | `; }
    else if (tok === '</w:tr>') out = `${out.replace(/ \| $/, '')}\n`;
    else out += inCell ? ' ' : '\n';
  }
  return tidy(out);
}

const colIndex = (ref?: string) => {
  const l = /^([A-Z]+)/.exec(ref ?? '')?.[1];
  return l ? [...l].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 : undefined;
};
const csv = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
/** every sheet as CSV (cached values: formulas show their last result) */
// ponytail: dates come out as Excel serial numbers (the date format lives in styles.xml) — map numFmt ids if users need real dates
function xlsxText(z: Zip): string {
  const wb = readXml(z, 'xl/workbook.xml');
  if (wb === undefined) throw new Error('not an Excel workbook (xl/workbook.xml missing)');
  const texts = (s: string) => [...s.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => unxml(m[1]!)).join('');
  const shared = [...(readXml(z, 'xl/sharedStrings.xml') ?? '').matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si\/>/g)].map((m) => texts(m[1] ?? ''));
  const rels = new Map([...(readXml(z, 'xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], 'Id'), attr(m[0], 'Target')]));
  const out: string[] = [];
  for (const s of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const target = rels.get(attr(s[0], 'r:id'));
    const xml = target && readXml(z, target.startsWith('/') ? target.slice(1) : path.posix.normalize(`xl/${target}`));
    if (!xml) continue;
    const rows: string[] = [];
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const c of r[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const a = c[1]!, body = c[2] ?? '';
        const ty = attr(a, 't'), v = /<v>([^<]*)<\/v>/.exec(body)?.[1];
        const val = ty === 's' ? shared[Number(v)] ?? '' : ty === 'inlineStr' ? texts(body) : ty === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : unxml(v ?? '');
        cells[colIndex(attr(a, 'r')) ?? cells.length] = csv(val);
      }
      const line = Array.from(cells, (x) => x ?? '').join(',').replace(/,+$/, '');
      if (line) rows.push(line);
    }
    out.push(`## Sheet: ${unxml(attr(s[0], 'name') ?? '?')}\n${rows.join('\n')}`);
  }
  return out.join('\n\n');
}

// ponytail: slides in file-number order, not the deck order in presentation.xml — read sldIdLst if decks get reordered a lot
function pptxText(z: Zip): string {
  if (!z.has('ppt/presentation.xml')) throw new Error('not a PowerPoint file (ppt/presentation.xml missing)');
  const slides = [...z.keys()].flatMap((k) => { const m = /^ppt\/slides\/slide(\d+)\.xml$/.exec(k); return m ? [Number(m[1])] : []; }).sort((a, b) => a - b);
  return slides
    .map((n) => {
      let s = '';
      for (const m of readXml(z, `ppt/slides/slide${n}.xml`)!.matchAll(/<a:t>([^<]*)<\/a:t>|<\/a:p>/g)) s += m[1] !== undefined ? unxml(m[1]) : '\n';
      return `## Slide ${n}\n${tidy(s)}`;
    })
    .join('\n\n');
}

/** text the brain can read; null for pdf / zip / binary (pdf goes as a document block, zip as a file list) */
export function extractText(name: string, buf: Buffer): { kind: AttachKind; text: string | null } {
  const kind = kindOf(name, buf);
  if (kind === 'text') return { kind, text: decodeText(buf) };
  if (kind === 'docx' || kind === 'xlsx' || kind === 'pptx') {
    const z: Zip = new Map(readZip(buf).map((e) => [e.name, e]));
    return { kind, text: (kind === 'docx' ? docxText : kind === 'xlsx' ? xlsxText : pptxText)(z) };
  }
  return { kind, text: null };
}

// ---------- blocks sent to (and saved with) the user's message ----------
export interface AttachmentInfo {
  id: string;
  name: string;
  kind: AttachKind;
  size: number;
  text?: string | null;
  tree?: { path: string; size: number }[];
  /** PDF small enough to send inline */
  pdfBase64?: string;
  /** zip entries skipped (unsafe path / unwritable) */
  skipped?: number;
  /** extraction failed — the original is still stored for workers */
  error?: string;
}
export const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const OPEN_RE = /^<attachment id="(file-\d+)" name="([^"]*)"/;
/** a text block that is one attachment (display / title / memory skip it, the chip shows its name) */
export const isAttachmentText = (s: string) => OPEN_RE.test(s) && s.trimEnd().endsWith('</attachment>');
export const attachmentName = (s: string) => OPEN_RE.exec(s)?.[2];

export function attachmentBlocks(a: AttachmentInfo): Block[] {
  const head = `<attachment id="${a.id}" name="${a.name.replace(/["<>\r\n]/g, '_')}" type="${a.kind}" size="${fmtSize(a.size)}">`;
  let body: string;
  if (a.error) {
    body = `(could not read this ${a.kind} file: ${a.error} — the original is stored; hand it to a worker via fleet_dispatch.files)`;
  } else if (typeof a.text === 'string') {
    body = a.text.length > MAX_INLINE_CHARS
      ? `${a.text.slice(0, MAX_INLINE_CHARS)}\n…(truncated: ${MAX_INLINE_CHARS} of ${a.text.length} chars shown — attachment_read id="${a.id}" offset=${MAX_INLINE_CHARS} reads on)`
      : a.text || '(no text found)';
  } else if (a.kind === 'pdf') {
    body = a.pdfBase64
      ? '(PDF sent as the document block right before this tag. If you cannot see it, hand it to a claude worker via fleet_dispatch.files.)'
      : `(PDF too large to read inline (max ${PDF_INLINE_BYTES / 1024 / 1024} MB) — hand it to a claude worker via fleet_dispatch.files.)`;
  } else if (a.kind === 'zip') {
    const tree = a.tree ?? [];
    body = `Unpacked ${tree.length} files${a.skipped ? ` (${a.skipped} unsafe/unwritable entries skipped)` : ''}:\n${tree.slice(0, 200).map((e) => `${e.path} (${fmtSize(e.size)})`).join('\n')}${tree.length > 200 ? `\n… and ${tree.length - 200} more` : ''}\nRead one with attachment_read id="${a.id}" path="<path>".`;
  } else {
    body = '(binary file — not readable as text; hand it to a worker via fleet_dispatch.files if needed)';
  }
  const doc: Block[] = a.kind === 'pdf' && a.pdfBase64 ? [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.pdfBase64 }, title: a.name }] : [];
  return [...doc, { type: 'text', text: `${head}\n${body}\n</attachment>` }];
}

/** attachment_read paging: one page from offset, with a pointer to the rest */
export function sliceText(text: string, offset: number, page = READ_PAGE): string {
  const part = text.slice(offset, offset + page);
  const end = offset + part.length;
  return end < text.length ? `${part}\n…(${end} of ${text.length} chars — offset=${end} for more)` : part || '(end of text)';
}
