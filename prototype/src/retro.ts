// Retrospective v0 — memory-interface-spec §6: cluster → lessons → proposals
// Principle: only GENERATE proposal files (PR-equivalent), never write KB/policy directly (M1, principle §1.3)
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildFleetStats, loadKB, type TaskRecordLite } from './memory.js';

export interface RetroResult {
  kbProposals: string[];
  policyProposals: string[];
  dir: string;
}

function readFullRecords(tasksDir: string): (TaskRecordLite & { artifacts?: { files_changed?: string[] }; brief?: { goal?: string } })[] {
  if (!existsSync(tasksDir)) return [];
  const out: (TaskRecordLite & { artifacts?: { files_changed?: string[] }; brief?: { goal?: string } })[] = [];
  for (const f of readdirSync(tasksDir).filter((x) => x.endsWith('.json'))) {
    try {
      const r = JSON.parse(readFileSync(path.join(tasksDir, f), 'utf8'));
      out.push(r);
    } catch {
      /* skip broken records */
    }
  }
  return out;
}

export function retrospective(repo: string, tasksDirName = 'tasks', minSample = 5, gapThreshold = 0.2): RetroResult {
  const tasksDir = path.join(repo, '.orchestra', tasksDirName);
  const records = readFullRecords(tasksDir);
  const stats = buildFleetStats(tasksDir);
  const kb = loadKB(repo);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(repo, '.orchestra', 'proposals');
  mkdirSync(dir, { recursive: true });

  const kbProposals: string[] = [];
  const policyProposals: string[] = [];

  // ---- KB proposals: cluster files_changed by top-level module (src/<dir>) ----
  const moduleHits = new Map<string, { files: Set<string>; tasks: string[]; goals: string[] }>();
  for (const r of records) {
    if (r.node !== 'implement' && r.node !== 'fix') continue;
    for (const f of r.artifacts?.files_changed ?? []) {
      const parts = f.replace(/\\/g, '/').split('/');
      const moduleDir = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0]!;
      const g = moduleHits.get(moduleDir) ?? { files: new Set(), tasks: [], goals: [] };
      g.files.add(f.replace(/\\/g, '/'));
      if (!g.tasks.includes(r.id)) g.tasks.push(r.id);
      if (r.brief?.goal && !g.goals.includes(r.brief.goal)) g.goals.push(r.brief.goal);
      moduleHits.set(moduleDir, g);
    }
  }
  for (const [moduleDir, g] of moduleHits) {
    // is there already a KB entry covering this module? (overlapping scope)
    const covered = kb.some((e) => e.scope.some((s) => s.startsWith(moduleDir) || moduleDir.startsWith(s.replace('/**', ''))));
    if (covered || g.tasks.length < 2) continue;
    const file = path.join(dir, `prop-${stamp}-kb-${moduleDir.replace('/', '-')}.md`);
    const body = [
      `# [orchestra-proposal] New KB entry for module \`${moduleDir}/\``,
      '',
      `Evidence: ${g.tasks.length} tasks touched this module (${g.tasks.join(', ')}).`,
      `Frequently touched files: ${[...g.files].slice(0, 8).join(', ')}`,
      '',
      '```markdown',
      '---',
      `id: kb-module-${moduleDir.replace('/', '-')}`,
      `title: "Module ${moduleDir}"`,
      `scope: ["${moduleDir}/**"]`,
      'tags: [module]',
      'source: consolidated',
      'confidence: medium',
      'pinned: false',
      '---',
      '',
      `Recently active module (${g.tasks.length} tasks). Latest goal: "${g.goals[g.goals.length - 1] ?? ''}".`,
      'User should add concrete conventions/pitfalls before pinning.',
      '```',
      '',
      '→ User reviews, then copies the ``` block into `.orchestra/kb/` (merge = accept; retro never writes on its own — M1).',
    ].join('\n');
    writeFileSync(file, body, 'utf8');
    kbProposals.push(file);
  }

  // ---- Policy proposals: first_try_pass gap ≥ threshold once enough samples ----
  const byRole = new Map<string, Map<string, { passed: number; n: number }>>();
  for (const [key, s] of stats) {
    const [worker, role] = key.split('|');
    const m = byRole.get(role!) ?? new Map();
    m.set(worker!, { passed: s.passed, n: s.dispatched });
    byRole.set(role!, m);
  }
  for (const [role, workers] of byRole) {
    if (workers.size < 2) continue;
    const arr = [...workers.entries()].filter(([, v]) => v.n >= minSample);
    if (arr.length < 2) continue;
    arr.sort((a, b) => b[1].passed / b[1].n - a[1].passed / a[1].n);
    const [bestW, best] = arr[0]!;
    const [worstW, worst] = arr[arr.length - 1]!;
    const gap = best.passed / best.n - worst.passed / worst.n;
    if (gap < gapThreshold) continue;
    const file = path.join(dir, `prop-${stamp}-policy-${role}.md`);
    const body = [
      `# [orchestra-proposal] Proposed binding order change for role \`${role}\``,
      '',
      `| Worker | Dispatched | Passed | Rate |`,
      `|---|---|---|---|`,
      ...arr.map(([w, v]) => `| ${w} | ${v.n} | ${v.passed} | ${((v.passed / v.n) * 100).toFixed(0)}% |`),
      '',
      `Gap of ${(gap * 100).toFixed(0)} percentage points between \`${bestW}\` and \`${worstW}\` (n ≥ ${minSample}).`,
      '',
      'Proposal: move `' + bestW + '` ahead of `' + worstW + '` in `bindings.' + role + '` of policy.yml.',
      '→ User merge = accept; closing the proposal = recorded so it is not re-proposed unless evidence grows (§6).',
    ].join('\n');
    writeFileSync(file, body, 'utf8');
    policyProposals.push(file);
  }

  return { kbProposals, policyProposals, dir };
}
