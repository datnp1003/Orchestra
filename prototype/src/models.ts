// Model Registry + luật phân phối channel-based (P6.6)
// Orchestra liệt kê MỌI model — nhưng phân phối cho CLI dựa trên khả năng hỗ trợ:
//   native family (OAuth/API của CLI)  |  custom endpoint (gateway qua vault)  |  không phân phối
// Antigravity: custom_provider=false → CHỈ native google (OAuth gemini).

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { vaultStatus } from './vault.js';
import { protoAsset } from './paths.js';

export interface ModelDef {
  id: string;
  /** provider gốc của model: anthropic | openai | google | custom | ... */
  family: string;
  /** model custom chạy qua gateway nào — vault provider chứa key + base_url (mặc định = family) */
  gateway?: string;
  ctx?: number;
  cost_tier?: 'low' | 'medium' | 'high';
}

export interface ModelRegistry {
  version: number;
  models: ModelDef[];
}

export function loadModels(repo?: string): { registry: ModelRegistry; source: string } {
  const candidates: { p: string; source: string }[] = [];
  if (repo) candidates.push({ p: path.join(repo, '.orchestra', 'models.yml'), source: 'project' });
  const def = protoAsset('models.yml');
  if (def) candidates.push({ p: def, source: 'proto-default' });
  for (const c of candidates) {
    if (existsSync(c.p)) {
      try {
        const raw = yaml.load(readFileSync(c.p, 'utf8')) as ModelRegistry;
        if (raw && Array.isArray(raw.models)) return { registry: raw, source: c.source };
      } catch {
        /* file lỗi → thử candidate kế */
      }
    }
  }
  return { registry: { version: 1, models: [] }, source: 'none' };
}

export type ModelChannel = 'default' | 'native' | 'custom-gateway' | 'unregistered' | 'unavailable';

export interface ModelResolution {
  ok: boolean;
  channel: ModelChannel;
  reason: string;
}

/**
 * Luật phân phối: CLI m có chạy được model này không, qua kênh nào?
 * - model bỏ trống → 'default' (CLI dùng model của nó)
 * - family === oauthProvider của CLI → 'native' (kênh OAuth/API riêng)
 * - CLI custom_provider=true + gateway vault đã cấu hình → 'custom-gateway'
 * - còn lại (vd antigravity: custom_provider=false) → 'unavailable'
 * - model chưa đăng ký trong registry → 'unregistered' (cho phép, nhưng cảnh báo — linh hoạt)
 */
export function resolveModelFor(
  m: { id: string; oauthProvider?: string; custom_provider?: boolean },
  model: string | undefined,
  repo?: string,
): ModelResolution {
  if (!model) return { ok: true, channel: 'default', reason: 'CLI dùng model mặc định' };
  const { registry } = loadModels(repo);
  const entry = registry.models.find((x) => x.id === model);
  const family = entry?.family ?? (model.includes('/') ? model.split('/')[0]! : 'unknown');

  if (m.oauthProvider && family === m.oauthProvider) {
    return { ok: true, channel: 'native', reason: `native family '${family}' — kênh OAuth/API của CLI` };
  }
  if (m.custom_provider === false) {
    return {
      ok: false,
      channel: 'unavailable',
      reason: `${m.id} chỉ chạy native ${m.oauthProvider ?? '?'} (custom_provider=false) — model family '${family}' không phân phối được`,
    };
  }
  const gateway = entry?.gateway ?? family;
  const st = vaultStatus(gateway);
  if (!st.configured) {
    return {
      ok: false,
      channel: 'unavailable',
      reason: `model '${model}' family '${family}' cần gateway '${gateway}' trong vault (base_url + key) — chưa cấu hình`,
    };
  }
  return { ok: true, channel: 'custom-gateway', reason: `qua gateway '${gateway}' (vault đã cấu hình)` };
}
