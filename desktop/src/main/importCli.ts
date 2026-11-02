// R2a: import provider từ config CLI của chính user (~/.claude/settings.json, ~/.codex/config.toml).
// Thuần (nội dung file + env vào) — main process đọc file, lưu key vào vault; key KHÔNG bao giờ về renderer.
import type { ProviderConfig } from '../../../prototype/src/router/providers.js';

export interface Found {
  cfg: Partial<ProviderConfig>;
  key?: string;
}

/** ponytail: chỉ đọc dòng `key = "value"` trong 1 section ('' = top-level); cần array/table lồng → parser TOML thật */
export function tomlSection(text: string, section: string): Record<string, string> {
  const out: Record<string, string> = {};
  let cur = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const h = /^\[([^\[\]]+)\]\s*(#.*)?$/.exec(line);
    if (h) {
      cur = h[1]!.trim().replace(/"/g, '');
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*(#.*)?$/.exec(line);
    if (kv && cur === section) {
      try {
        out[kv[1]!] = JSON.parse(`"${kv[2]}"`);
      } catch {
        /* escape lạ — bỏ dòng */
      }
    }
  }
  return out;
}

export function fromClaudeSettings(json: string): Found | { skip: string } {
  let env: Record<string, unknown>;
  try {
    env = JSON.parse(json)?.env ?? {};
  } catch {
    return { skip: 'claude: settings.json không phải JSON' };
  }
  const str = (k: string) => (typeof env[k] === 'string' && (env[k] as string).trim() ? (env[k] as string).trim() : undefined);
  const base = str('ANTHROPIC_BASE_URL');
  const key = str('ANTHROPIC_AUTH_TOKEN') ?? str('ANTHROPIC_API_KEY');
  if (!base && !key) return { skip: 'claude: settings.json không có env.ANTHROPIC_BASE_URL / AUTH_TOKEN' };
  let official = !base;
  try {
    official ||= new URL(base!).hostname === 'api.anthropic.com';
  } catch {
    return { skip: 'claude: ANTHROPIC_BASE_URL không hợp lệ' };
  }
  return official
    ? { cfg: { id: 'claude-gw', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', formats: ['messages'] }, key }
    : { cfg: { id: 'claude-gw', kind: 'anthropic-compatible', baseUrl: base, formats: ['messages', 'chat', 'responses'] }, key };
}

export function fromCodexConfig(toml: string, env: Record<string, string | undefined>): Found | { skip: string } {
  const active = tomlSection(toml, '').model_provider;
  if (!active) return { skip: 'codex: config.toml không có model_provider (đang dùng openai mặc định/OAuth)' };
  const sec = tomlSection(toml, `model_providers.${active}`);
  if (!sec.base_url) return { skip: `codex: [model_providers.${active}] không có base_url` };
  const key = sec.env_key ? env[sec.env_key] : undefined;
  return { cfg: { id: 'codex-gw', kind: 'openai-compatible', baseUrl: sec.base_url, formats: ['responses', 'chat'] }, key: key || undefined };
}
