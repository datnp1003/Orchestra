// Role Policy — role-policy-spec v0.1, phần P4: policy.yml từ file + track record scoring
// Nguyên tắc giữ nguyên: router deterministic, log pick + reason (§1), agent đề xuất user chốt (§6)
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { MANIFESTS, getManifest } from './manifests.js';
import { checkStatus } from './registry.js';
import { buildFleetStats, statsKey, type FleetStat } from './memory.js';
import { resolveModelFor } from './models.js';

export interface BindingDef {
  worker: { cli: string; model?: string };
  boost_when?: { tags?: string[] };
  when?: { budget_tier?: string };
}

export interface PolicyFile {
  version: number;
  roles?: Record<string, { description?: string; permission_profile?: string; budget?: { usd?: number; minutes?: number } }>;
  bindings?: Record<string, BindingDef[]>;
  routing?: {
    weights?: Record<string, number>;
    min_sample?: number;
    decay_days?: number;
    budget_mode?: 'balanced' | 'performance' | 'low';
  };
  fleet_constraints?: { cross_review?: 'required' | 'optional'; max_parallel_tasks?: number };
}

/** binding mặc định khi không có policy.yml (fallback nguyên trạng P2/P3) */
export const DEFAULT_BINDINGS: Record<string, string[]> = {
  coder: ['codex', 'claude'],
  planner: ['claude', 'codex'],
  verifier: ['claude', 'codex'],
  reviewer: ['claude', 'codex'],
  researcher: ['codex', 'claude'],
  fixer: ['codex', 'claude'],
  resolver: ['claude', 'codex'],
};

export interface LoadedPolicy {
  policy: PolicyFile | null;
  source: string; // 'project' | 'proto-default' | 'none'
  errors: string[];
}

export function loadPolicy(repo?: string): LoadedPolicy {
  const candidates: { p: string; source: string }[] = [];
  if (repo) candidates.push({ p: path.join(repo, '.orchestra', 'policy.yml'), source: 'project' });
  const protoDir = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // dist/.. = prototype/
  candidates.push({ p: path.join(protoDir, 'policy.yml'), source: 'proto-default' });

  for (const c of candidates) {
    if (existsSync(c.p)) {
      const raw = yaml.load(readFileSync(c.p, 'utf8')) as PolicyFile;
      const errors = validatePolicyFile(raw);
      return { policy: raw, source: c.source, errors };
    }
  }
  return { policy: null, source: 'none', errors: [] };
}

/** Luật P1–P8 (role-policy-spec §7) — phần áp dụng được ở P4 */
export function validatePolicyFile(p: PolicyFile): string[] {
  const errors: string[] = [];
  if (typeof p.version !== 'number' || p.version < 1) errors.push('P8/V10: policy thiếu version');

  const w = p.routing?.weights;
  if (w) {
    const sum = Object.values(w).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 0.001) errors.push(`P7: routing.weights tổng = ${sum}, phải = 1.0`);
  }
  for (const [role, binds] of Object.entries(p.bindings ?? {})) {
    for (const b of binds) {
      if (!getManifest(b.worker.cli)) errors.push(`P2: binding '${role}' → manifest '${b.worker.cli}' không tồn tại`);
    }
  }
  return errors;
}

export interface RoutingDecision {
  pick?: string;
  /** model từ binding của worker được chọn — undefined = CLI dùng model mặc định của nó */
  model?: string;
  reason: string;
  candidates: string[];
  scores?: { worker: string; score: number; parts: string }[];
}

export function resolveWorker(
  role: string,
  opts: {
    exclude?: string[];
    pin?: string;
    tags?: string[];
    policy?: PolicyFile | null;
    stats?: Map<string, FleetStat>;
    tasksDir?: string;
    repo?: string;
    onSkip?: (skipped: string[]) => void;
  } = {},
): RoutingDecision {
  const exclude = opts.exclude ?? [];
  const tags = opts.tags ?? [];

  if (opts.pin) {
    const m = getManifest(opts.pin);
    const st = m ? checkStatus(m) : undefined;
    if (st?.installed) return { pick: opts.pin, reason: 'pinned (debug)', candidates: [opts.pin] };
    return { reason: `pinned worker ${opts.pin} không khả dụng`, candidates: [] };
  }

  // min_sample & decay từ policy hoặc mặc định
  const minSample = opts.policy?.routing?.min_sample ?? 10;
  const decayDays = opts.policy?.routing?.decay_days ?? 30;
  const stats = opts.stats ?? (opts.tasksDir ? buildFleetStats(opts.tasksDir, decayDays) : undefined);

  // danh sách ứng viên theo thứ tự binding (kèm model nếu binding khai)
  // P6.6: ứng viên mà model không phân phối được cho CLI → SKIP (luật capability-based distribution)
  const binding = opts.policy?.bindings?.[role];
  const candidates: { cli: string; model?: string; base: number; boost: number }[] = [];
  const skipped: string[] = [];
  if (binding) {
    binding.forEach((b, i) => {
      const boost = (b.boost_when?.tags ?? []).some((t) => tags.includes(t)) ? 2 : 0;
      const model = b.worker.model;
      const cliManifest = getManifest(b.worker.cli);
      if (model && cliManifest) {
        const res = resolveModelFor(cliManifest, model, opts.repo);
        if (!res.ok) {
          skipped.push(`${b.worker.cli}/${model} (${res.reason})`);
          return;
        }
      }
      candidates.push({ cli: b.worker.cli, model, base: binding.length - i, boost });
    });
  } else {
    const ids = DEFAULT_BINDINGS[role] ?? MANIFESTS.map((m) => m.id);
    ids.forEach((cli, i) => candidates.push({ cli, base: ids.length - i, boost: 0 }));
  }
  if (skipped.length) {
    // log lý do skip — dispatch thấy được vì sao ứng viên bị loại
    opts.onSkip?.(skipped);
  }

  // chấm điểm: thứ tự binding + tag boost + track record (khi đủ sample — P5 luật §5)
  const scored = candidates
    .filter((c) => !exclude.includes(c.cli))
    .filter((c) => getManifest(c.cli) && checkStatus(getManifest(c.cli)!).installed)
    .map((c) => {
      const s = stats?.get(statsKey(c.cli, role));
      let track = 0;
      let trackPart = 'n<min_sample (chưa đủ số liệu)';
      if (s && s.dispatched >= minSample) {
        track = s.ema * 5;
        trackPart = `ema=${s.ema.toFixed(2)} (n=${s.dispatched}) ×5`;
      }
      return {
        worker: c.cli,
        model: c.model,
        score: c.base + c.boost + track,
        parts: `base=${c.base}${c.boost ? ` boost=${c.boost}` : ''}${track ? ` + ${trackPart}` : ` + ${trackPart}`}`,
      };
    })
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return {
      reason: `không còn ứng viên cho role '${role}' — escalate ask_user (Role Policy §4.4)`,
      candidates: candidates.map((c) => c.cli),
    };
  }
  const top = scored[0]!;
  return {
    pick: top.worker,
    model: top.model,
    reason: `score=${top.score.toFixed(2)} (${top.parts}) cho role '${role}'${top.model ? ` · model=${top.model}` : ''}`,
    candidates: candidates.map((c) => c.cli),
    scores: scored,
  };
}
