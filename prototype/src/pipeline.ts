// Pipeline DSL loader + validation — theo pipeline-dsl-spec v0.1 (luật V1–V10, phần áp dụng P3)
import { readFileSync } from 'node:fs';
import * as yaml from 'js-yaml';
import type { NodeType } from './brief.js';
import { t } from './i18n/index.js';

export type GateExpr = string | { if: string; then: string };

export interface OnFailDef {
  action: 'retry' | 'spawn_fix' | 'ask_user' | 'abort';
  max_retries?: number;
  then?: 'ask_user' | 'abort' | 'continue';
}

export interface NodeDef {
  id: string;
  type: NodeType;
  needs?: string[];
  role?: string;
  approval?: 'required' | 'optional' | 'none';
  self_test?: boolean;
  distinct_worker_from?: string[];
  budget?: { usd?: number; minutes?: number };
  outputs?: string[];
  gate?: GateExpr[];
  policy?: 'auto_if' | 'ask_always';
  on_fail?: OnFailDef;
  when?: { paths?: string[] };
  command?: string;
}

export interface ParamDef {
  name: string;
  default?: unknown;
}

export interface PipelineDef {
  id: string;
  version: number;
  name?: string;
  test_command?: string;
  params?: ParamDef[];
  nodes: NodeDef[];
}

export function loadPipeline(path: string): PipelineDef {
  const raw = yaml.load(readFileSync(path, 'utf8')) as PipelineDef;
  if (!raw || typeof raw !== 'object') throw new Error(t('core.pipeline.fileInvalid'));
  return raw;
}

const NODE_TYPES: NodeType[] = ['plan', 'implement', 'verify', 'review', 'check', 'run', 'merge_gate'];

export function validatePipeline(d: PipelineDef): string[] {
  const errors: string[] = [];
  const ids = new Set(d.nodes.map((n) => n.id));

  // V10
  if (typeof d.version !== 'number' || d.version < 1) errors.push(t('core.pipeline.v10'));

  // V1: đúng một node verify
  const verifyNodes = d.nodes.filter((n) => n.type === 'verify');
  if (verifyNodes.length !== 1) errors.push(t('core.pipeline.v1', { n: verifyNodes.length }));

  for (const n of d.nodes) {
    if (!NODE_TYPES.includes(n.type)) errors.push(t('core.pipeline.badType', { id: n.id, type: n.type }));
    // V2: verify không được có when
    if (n.type === 'verify' && n.when) errors.push(t('core.pipeline.v2', { id: n.id }));
    // needs phải trỏ tới node tồn tại
    for (const dep of n.needs ?? []) {
      if (!ids.has(dep)) errors.push(t('core.pipeline.needsMissing', { id: n.id, dep }));
    }
    // V5: distinct_worker_from phải trỏ tới node trong pipeline
    for (const ref of n.distinct_worker_from ?? []) {
      if (!ids.has(ref)) errors.push(t('core.pipeline.v5', { id: n.id, ref }));
    }
    // V6: spawn_fix bắt buộc max_retries + then
    if (n.on_fail?.action === 'spawn_fix' && (n.on_fail.max_retries === undefined || !n.on_fail.then)) {
      errors.push(t('core.pipeline.v6', { id: n.id }));
    }
    // V7: merge_gate cần policy; auto_if cần conditions
    if (n.type === 'merge_gate' && !n.gate) errors.push(t('core.pipeline.v7', { id: n.id }));
    // V9: budget (warning-format nhưng đưa vào errors list riêng sẽ chặt hơn — P3: warning)
    if (n.type === 'implement' && !n.budget) errors.push(t('core.pipeline.v9', { id: n.id }));
  }

  // V3: DAG phi chu trình — topoSort sẽ throw; thử trước để báo lỗi rõ
  try {
    topoSort(d.nodes);
  } catch (err) {
    errors.push(`V3: ${err instanceof Error ? err.message : String(err)}`);
  }

  return errors;
}

/** Kahn topo sort — throw nếu có chu trình (V3) */
export function topoSort(nodes: NodeDef[]): string[] {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    indeg.set(n.id, n.needs?.length ?? 0);
    for (const dep of n.needs ?? []) {
      const list = adj.get(dep) ?? [];
      list.push(n.id);
      adj.set(dep, list);
    }
  }
  const queue = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of adj.get(id) ?? []) {
      const v = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, v);
      if (v === 0) queue.push(next);
    }
  }
  if (order.length !== nodes.length) {
    const cyclic = nodes.filter((n) => !order.includes(n.id)).map((n) => n.id);
    throw new Error(t('core.pipeline.cycle', { nodes: cyclic.join(', ') }));
  }
  return order;
}
