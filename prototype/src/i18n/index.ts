// i18n — en + vi, no deps. Shared by prototype (CLI/core/router), extension, desktop (main + renderer).
//
// Usage:
//   import { t, setLocale, getLocale, detectLocale } from '<rel>/prototype/src/i18n/index.js';
//   t('desktop.chat.empty')                  → string in current locale
//   t('desktop.err.repoMissing', { repo })   → '{repo}' placeholders interpolated (unknown placeholders kept as-is)
//   setLocale(detectLocale(process.env.LANG)) → 'vi*' → vi, anything else → en
//
// Adding a string:
//   1. add the key to en.ts (namespace: desktop.* | cli.* | core.* | router.* | ext.* | brain.*)
//   2. add the same key to vi.ts — vi is typed Record<keyof typeof en, string>, so a missing/extra key fails tsc
//   3. use the same {placeholders} in both — test/i18n.test.mjs checks key sets + placeholders
// Keys are typed (Key); a dynamic key needs `as Key`. Fallback: current locale → en → key itself;
// keys that fell through to the key itself are recorded in `missing` (tests assert it stays empty).
// Renderer (no TS import): main sends messages('desktop.') over IPC i18n:get; app.js has its own t() with the same semantics.
// Scope: only text a HUMAN reads goes through t(). Text sent to LLMs/workers (briefs, prompts, retro proposals, brain
// system prompt, tool descriptions) is NOT localized via t(): fixed scaffolding is English, the user's own text is
// passed verbatim, and models answer in the language of the user's message/goal — never the UI locale.
// Tool RESULT strings the brain reads stay English. Machine ids/enums/JSON keys/
// log prefixes ([router]) never translate. test/i18n.test.mjs scans src for Vietnamese literals outside vi.ts.
import { en } from './en.js';
import { vi } from './vi.js';

export type Locale = 'en' | 'vi';
export type Key = keyof typeof en;
type Params = Record<string, string | number>;

const DICTS: Record<Locale, Record<string, string>> = { en, vi };
export const missing = new Set<string>();

export const detectLocale = (raw?: string): Locale => (/^vi/i.test(raw ?? '') ? 'vi' : 'en');

let locale: Locale = detectLocale(process.env.ORCHESTRA_LANG);
export const getLocale = (): Locale => locale;
export function setLocale(l: Locale): void {
  locale = l === 'vi' ? 'vi' : 'en';
}

export const interpolate = (s: string, params?: Params): string =>
  params ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : s;

export function t(key: Key, params?: Params): string {
  const s = DICTS[locale][key] ?? en[key];
  if (s === undefined) missing.add(key);
  return interpolate(s ?? key, params);
}

/** every key starting with prefix, current locale over en — for the renderer (IPC i18n:get) */
export function messages(prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(en) as Key[]) if (k.startsWith(prefix)) out[k] = DICTS[locale][k] ?? en[k];
  return out;
}
