// Retrospective v0 — memory-interface-spec §6: cluster → lessons → proposals
// Nguyên tắc: chỉ SINH proposal file (PR-equivalent), không tự ghi KB/policy (M1, nguyên tắc §1.3)
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
      /* bỏ qua record lỗi */
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

  // ---- KB proposals: cluster files_changed theo module cấp 1 (src/<dir>) ----
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
    // đã có KB entry phủ module này? (scope giao nhau)
    const covered = kb.some((e) => e.scope.some((s) => s.startsWith(moduleDir) || moduleDir.startsWith(s.replace('/**', ''))));
    if (covered || g.tasks.length < 2) continue;
    const file = path.join(dir, `prop-${stamp}-kb-${moduleDir.replace('/', '-')}.md`);
    const body = [
      `# [orchestra-proposal] KB entry mới cho module \`${moduleDir}/\``,
      '',
      `Bằng chứng: ${g.tasks.length} task đã chạm module này (${g.tasks.join(', ')}).`,
      `Files thường chạm: ${[...g.files].slice(0, 8).join(', ')}`,
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
      `Module hoạt động gần đây (${g.tasks.length} task). Mục tiêu gần nhất: "${g.goals[g.goals.length - 1] ?? ''}".`,
      'Cần user bổ sung quy ước/bẫy cụ thể trước khi pinned.',
      '```',
      '',
      '→ User review rồi copy phần trong ``` vào `.orchestra/kb/` (merge = chốt, retro không tự ghi — M1).',
    ].join('\n');
    writeFileSync(file, body, 'utf8');
    kbProposals.push(file);
  }

  // ---- Policy proposals: chênh first_try_pass ≥ threshold khi đủ sample ----
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
      `# [orchestra-proposal] Đề xuất đổi thứ tự binding cho role \`${role}\``,
      '',
      `| Worker | Dispatched | Passed | Tỉ lệ |`,
      `|---|---|---|---|`,
      ...arr.map(([w, v]) => `| ${w} | ${v.n} | ${v.passed} | ${((v.passed / v.n) * 100).toFixed(0)}% |`),
      '',
      `Chênh lệch ${(gap * 100).toFixed(0)} điểm % giữa \`${bestW}\` và \`${worstW}\` (n ≥ ${minSample}).`,
      '',
      'Đề xuất: đưa `' + bestW + '` lên trước `' + worstW + '` trong `bindings.' + role + '` của policy.yml.',
      '→ User merge = chốt; đóng proposal = hệ ghi nhận để không đề xuất lại trừ khi bằng chứng tăng (§6).',
    ].join('\n');
    writeFileSync(file, body, 'utf8');
    policyProposals.push(file);
  }

  return { kbProposals, policyProposals, dir };
}
