// Router R1 — provider config: metadata (không bí mật) ở ~/.orchestra/router.json,
// key mỗi provider trong vault DPAPI tên `router.<id>` (không dùng ':' — tên file Windows/NTFS ADS).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vaultDelete, vaultGet, vaultSet } from '../vault.js';

// ponytail: 'oauth-openai' | 'oauth-anthropic' thêm vào union ở phase OAuth (authHeaders lấy token thay key)
export type ProviderKind = 'anthropic' | 'openai' | 'anthropic-compatible' | 'openai-compatible';
export type Format = 'messages' | 'chat' | 'responses';

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  baseUrl: string; // không có '/' cuối, không có '/v1'
  formats: Format[]; // upstream nói native được gì
  enabled: boolean;
  models?: string[]; // tĩnh; không có → GET {baseUrl}/v1/models
}

export const DEFAULT_FORMATS: Record<ProviderKind, Format[]> = {
  anthropic: ['messages'],
  openai: ['chat', 'responses'],
  'anthropic-compatible': ['messages'],
  'openai-compatible': ['chat'],
};
const FORMATS: Format[] = ['messages', 'chat', 'responses'];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

export const vaultName = (id: string) => `router.${id}`;
export const defaultRouterFile = () => path.join(os.homedir(), '.orchestra', 'router.json');

/** validate + chuẩn hoá — throw Error nếu sai (input từ UI/file là trust boundary) */
export function normalizeProvider(cfg: Partial<ProviderConfig>): ProviderConfig {
  const { id, kind } = cfg;
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error(`provider id không hợp lệ: ${id}`);
  if (!kind || !(kind in DEFAULT_FORMATS)) throw new Error(`provider kind không hợp lệ: ${kind}`);
  let url: URL;
  try {
    url = new URL(String(cfg.baseUrl));
  } catch {
    throw new Error(`baseUrl không hợp lệ: ${cfg.baseUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`baseUrl phải http/https: ${cfg.baseUrl}`);
  const baseUrl = `${url.origin}${url.pathname}`.replace(/\/+$/, '').replace(/\/v1$/, '');
  const formats = (cfg.formats ?? []).filter((f) => FORMATS.includes(f));
  const models = cfg.models?.filter((m) => typeof m === 'string' && m);
  return {
    id,
    kind,
    baseUrl,
    formats: formats.length ? [...new Set(formats)] : [...DEFAULT_FORMATS[kind]],
    enabled: cfg.enabled !== false,
    ...(models?.length ? { models } : {}),
  };
}

export function authHeaders(kind: ProviderKind, key: string | null): Record<string, string> {
  const h: Record<string, string> = {};
  if (kind === 'anthropic' || kind === 'anthropic-compatible') h['anthropic-version'] = '2023-06-01';
  if (key) {
    if (kind === 'anthropic') h['x-api-key'] = key;
    else h.authorization = `Bearer ${key}`;
  }
  return h;
}

export interface ProviderStore {
  listProviders(): ProviderConfig[];
  saveProvider(cfg: Partial<ProviderConfig>, key?: string): ProviderConfig;
  deleteProvider(id: string): boolean;
  getKey(id: string): string | null;
}

export function createProviderStore(opts: { file?: string; keyFor?: (id: string) => string | null } = {}): ProviderStore {
  const file = opts.file ?? defaultRouterFile();
  const keyFor = opts.keyFor ?? ((id: string) => vaultGet(vaultName(id)));
  const keys = new Map<string, string | null>();
  let list: ProviderConfig[] | null = null;

  const load = (): ProviderConfig[] => {
    if (list) return list;
    // file hỏng → throw, KHÔNG trả [] (save sau đó sẽ ghi đè mất config của user)
    const raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { providers: [] };
    list = ((raw.providers ?? []) as Partial<ProviderConfig>[]).map(normalizeProvider);
    return list;
  };
  const write = (next: ProviderConfig[]) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ providers: next }, null, 2), 'utf8');
    list = next;
  };

  return {
    listProviders: () => [...load()],
    saveProvider(cfg, key) {
      const p = normalizeProvider(cfg);
      if (key !== undefined) {
        if (!vaultSet(vaultName(p.id), key)) throw new Error(`lưu key vào vault thất bại: ${p.id}`);
        keys.set(p.id, key);
      }
      write([...load().filter((x) => x.id !== p.id), p]);
      return p;
    },
    deleteProvider(id) {
      const cur = load();
      if (!cur.some((x) => x.id === id)) return false;
      write(cur.filter((x) => x.id !== id));
      vaultDelete(vaultName(id));
      keys.delete(id);
      return true;
    },
    getKey(id) {
      if (!keys.has(id)) keys.set(id, keyFor(id));
      return keys.get(id) ?? null;
    },
  };
}
