// Router R1 — provider config: metadata (non-secret) in ~/.orchestra/router.json,
// each provider's key in the DPAPI vault named `router.<id>` (no ':' — Windows filename/NTFS ADS).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vaultDelete, vaultGet, vaultSet } from '../vault.js';
import { OAUTH_BASE_URL } from './oauth.js';
import { t } from '../i18n/index.js';

// R3: oauth-* = subscription token (vault holds JSON creds instead of a key; router gets the access token via oauth.ts)
export type ProviderKind = 'anthropic' | 'openai' | 'anthropic-compatible' | 'openai-compatible' | 'oauth-anthropic' | 'oauth-openai';
export type Format = 'messages' | 'chat' | 'responses';

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  baseUrl: string; // no trailing '/', no '/v1'
  formats: Format[]; // what upstream speaks natively
  enabled: boolean;
  models?: string[]; // static; absent → GET {baseUrl}/v1/models
  riskAcknowledged?: boolean; // oauth-*: user has read the warning — missing → can't save/enable
  needsLogin?: boolean; // runtime (desktop sets it from the vault), not saved to file
}

export const DEFAULT_FORMATS: Record<ProviderKind, Format[]> = {
  anthropic: ['messages'],
  openai: ['chat', 'responses'],
  'anthropic-compatible': ['messages'],
  'openai-compatible': ['chat'],
  'oauth-anthropic': ['messages'],
  'oauth-openai': ['responses'],
};
export const isOAuth = (kind: string) => kind === 'oauth-anthropic' || kind === 'oauth-openai';
const OAUTH_MODELS: Record<string, string[]> = {
  'oauth-anthropic': ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'],
  'oauth-openai': ['gpt-6-luna', 'gpt-6-sol', 'gpt-5.6-terra'],
};
const FORMATS: Format[] = ['messages', 'chat', 'responses'];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

export const vaultName = (id: string) => `router.${id}`;
export const defaultRouterFile = () => path.join(os.homedir(), '.orchestra', 'router.json');

/** validate + normalize — throws Error if invalid (input from UI/file is a trust boundary) */
export function normalizeProvider(cfg: Partial<ProviderConfig>): ProviderConfig {
  const { id, kind } = cfg;
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error(t('router.providers.badId', { id: String(id) }));
  if (!kind || !(kind in DEFAULT_FORMATS)) throw new Error(t('router.providers.badKind', { kind: String(kind) }));
  const oauth = isOAuth(kind);
  let url: URL;
  try {
    url = new URL(String(oauth && !cfg.baseUrl ? OAUTH_BASE_URL[kind] : cfg.baseUrl));
  } catch {
    throw new Error(t('router.providers.badUrl', { url: String(cfg.baseUrl) }));
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(t('router.providers.urlScheme', { url: String(cfg.baseUrl) }));
  const baseUrl = `${url.origin}${url.pathname}`.replace(/\/+$/, '').replace(/\/v1$/, '');
  const formats = (cfg.formats ?? []).filter((f) => FORMATS.includes(f));
  const listed = cfg.models?.filter((m) => typeof m === 'string' && m);
  const models = listed?.length ? listed : oauth ? OAUTH_MODELS[kind] : undefined; // oauth has no /v1/models
  const risk = oauth && cfg.riskAcknowledged === true;
  return {
    id,
    kind,
    baseUrl,
    // oauth: fixed endpoint speaks exactly 1 format
    formats: formats.length && !oauth ? [...new Set(formats)] : [...DEFAULT_FORMATS[kind]],
    enabled: cfg.enabled !== false && (!oauth || risk),
    ...(models?.length ? { models } : {}),
    ...(risk ? { riskAcknowledged: true } : {}),
  };
}

export function authHeaders(kind: ProviderKind, key: string | null): Record<string, string> {
  const h: Record<string, string> = {};
  if (kind === 'anthropic' || kind === 'anthropic-compatible' || kind === 'oauth-anthropic') h['anthropic-version'] = '2023-06-01';
  if (key && !isOAuth(kind)) {
    if (kind === 'anthropic') h['x-api-key'] = key;
    else h.authorization = `Bearer ${key}`;
  }
  return h;
}

/** R2a: can the CLI run model `<provider>/<model>` via the router (per formats the provider speaks + router can translate) */
export function routerModelOk(cli: string, modelId: string, providers: ProviderConfig[]): { ok: boolean; reason: string } {
  if (cli !== 'claude' && cli !== 'codex') return { ok: false, reason: t('router.providers.cliUnsupported', { cli }) };
  const i = modelId.indexOf('/');
  const p = i > 0 ? providers.find((x) => x.id === modelId.slice(0, i)) : undefined;
  if (!p) return { ok: false, reason: t('router.providers.noProvider', { model: modelId }) };
  const id = p.id;
  if (isOAuth(p.kind) && !p.riskAcknowledged) return { ok: false, reason: t('router.providers.riskNotAck', { id }) };
  if (!p.enabled) return { ok: false, reason: t('router.providers.disabled', { id }) };
  if (p.needsLogin) return { ok: false, reason: t('router.providers.needsLogin', { id }) };
  if (cli === 'claude' && p.kind === 'oauth-openai') return { ok: false, reason: t('router.providers.noM2R', { id }) };
  const formats = p.formats.join(',');
  if (cli === 'codex') {
    if (p.formats.includes('responses')) return { ok: true, reason: t('router.providers.speaksResponses', { id }) };
    return p.formats.includes('chat') || p.formats.includes('messages')
      ? { ok: true, reason: t('router.providers.codexTranslated', { id, fmt: p.formats.includes('chat') ? 'chat' : 'messages' }) }
      : { ok: false, reason: t('router.providers.codexNeeds', { id, formats }) };
  }
  return p.formats.includes('messages') || p.formats.includes('chat')
    ? { ok: true, reason: t(p.formats.includes('messages') ? 'router.providers.speaksMessages' : 'router.providers.chatTranslated', { id }) }
    : { ok: false, reason: t('router.providers.claudeNeeds', { id, formats }) };
}

export interface ProviderStore {
  listProviders(): ProviderConfig[];
  saveProvider(cfg: Partial<ProviderConfig>, key?: string): ProviderConfig;
  deleteProvider(id: string): boolean;
  getKey(id: string): string | null;
  setKey(id: string, value: string): void;
}

export function createProviderStore(
  opts: { file?: string; keyFor?: (id: string) => string | null; saveKey?: (id: string, value: string) => boolean } = {},
): ProviderStore {
  const file = opts.file ?? defaultRouterFile();
  const keyFor = opts.keyFor ?? ((id: string) => vaultGet(vaultName(id)));
  const saveKey = opts.saveKey ?? ((id: string, v: string) => vaultSet(vaultName(id), v));
  const keys = new Map<string, string | null>();
  const setKey = (id: string, value: string) => {
    if (!saveKey(id, value)) throw new Error(t('router.providers.vaultFailed', { id }));
    keys.set(id, value);
  };
  let list: ProviderConfig[] | null = null;

  const load = (): ProviderConfig[] => {
    if (list) return list;
    // corrupt file → throw, do NOT return [] (a later save would overwrite the user's config)
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
      if (isOAuth(p.kind) && !p.riskAcknowledged) throw new Error(t('router.providers.mustAckRisk', { id: p.id }));
      if (isOAuth(p.kind) && key !== undefined) throw new Error(t('router.providers.oauthNoKey', { id: p.id }));
      if (key !== undefined) setKey(p.id, key);
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
    setKey,
  };
}
