// Settings store — pure fs, unit-test được (D1)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { validateSettings, type AppSettings } from './contract.js';
import { migrateRepos } from './chatSessions.js';
import type { Locale } from '../../../prototype/src/i18n/index.js';

/** raw JSON; undefined = chưa có file, null = file hỏng. Settings cũ chưa có projects → migrate 1 lần (ghi lại file). */
function readRaw(file: string): Record<string, unknown> | null | undefined {
  if (!existsSync(file)) return undefined;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw.projects)) return raw;
  const repos = validateSettings(raw).repos;
  const migrated = { ...raw, projects: migrateRepos(repos), activeRepo: typeof raw.activeRepo === 'string' && repos.includes(raw.activeRepo) ? raw.activeRepo : repos[0] ?? '' };
  writeFileSync(file, JSON.stringify(migrated, null, 2), 'utf8');
  return migrated;
}

export function loadSettings(file: string): AppSettings {
  return validateSettings(readRaw(file) ?? {});
}

export function saveSettings(file: string, s: AppSettings): AppSettings {
  const validated = validateSettings(s);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(validated, null, 2), 'utf8');
  return validated;
}

/** lần đầu (chưa có file / settings cũ chưa có language) → ghi language = fallback (locale OS); file hỏng → không đụng */
export function initLanguage(file: string, fallback: Locale): AppSettings {
  const raw = readRaw(file);
  if (raw === null) return loadSettings(file);
  return raw?.language ? loadSettings(file) : saveSettings(file, validateSettings(raw ?? {}, fallback));
}
