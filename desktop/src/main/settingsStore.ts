// Settings store — pure fs, unit-test được (D1)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { validateSettings, type AppSettings } from './contract.js';

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
