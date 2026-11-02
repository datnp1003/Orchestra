// Settings store — pure fs, unit-test được (D1)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { validateSettings, type AppSettings } from './contract.js';
import type { Locale } from '../../../prototype/src/i18n/index.js';

export function loadSettings(file: string): AppSettings {
  if (!existsSync(file)) return validateSettings({});
  try {
    return validateSettings(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return validateSettings({});
  }
}

export function saveSettings(file: string, s: AppSettings): AppSettings {
  const validated = validateSettings(s);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(validated, null, 2), 'utf8');
  return validated;
}

/** lần đầu (chưa có file / settings cũ chưa có language) → ghi language = fallback (locale OS); file hỏng → không đụng */
export function initLanguage(file: string, fallback: Locale): AppSettings {
  let raw: { language?: unknown } = {};
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return loadSettings(file);
    }
  }
  return raw.language ? loadSettings(file) : saveSettings(file, validateSettings(raw, fallback));
}
