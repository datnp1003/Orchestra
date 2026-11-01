// Logic thuần — KHÔNG import vscode (test được bằng node thường, P5 gate)
import { MANIFESTS } from '../../prototype/src/manifests.js';
import { checkStatus } from '../../prototype/src/registry.js';
import { loadPolicy, resolveWorker, DEFAULT_BINDINGS, type PolicyFile } from '../../prototype/src/policy.js';
import { buildFleetStats, loadKB, addFeedback, recallKB } from '../../prototype/src/memory.js';
import { resolveModelFor } from '../../prototype/src/models.js';
import { mergeBranch } from '../../prototype/src/worktree.js';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as yaml from 'js-yaml';
import path from 'node:path';

export const FALLBACK_REPO = 'C:/Users/Nitro V 15/Desktop/Source/Orchestra/prototype/demo-repo';

export function fleetSnapshot(): { id: string; installed: boolean; version?: string; auth: string }[] {
  return MANIFESTS.map((m) => {
    const s = checkStatus(m);
    return { id: m.id, installed: s.installed, version: s.version, auth: s.auth };
  });
}

export function tasksSnapshot(repo = FALLBACK_REPO): { id: string; node: string; worker: string; exit: number | null; scopeOk: boolean; files: number }[] {
  const dir = path.join(repo, '.orchestra', 'tasks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, 30)
    .map((f) => {
      try {
        const r = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
        return {
          id: String(r.id ?? f),
          node: String(r.node ?? '?'),
          worker: String(r.routing?.pick ?? r.brief?.worker ?? '?'),
          exit: r.run?.exit ?? null,
          scopeOk: r.scope_check?.ok !== false,
          files: r.artifacts?.files_changed?.length ?? 0,
        };
      } catch {
        return null;
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

// ---------- Review & Merge (P5.2) ----------
export interface MergeableTask {
  id: string;
  node: string;
  worker: string;
  branch: string;
  worktreePath?: string;
  patchRef?: string | null;
  files: string[];
}

function git(repo: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

/** Task có worktree-branch chưa merge vào main — ứng viên cho Review & Merge */
export function mergeableTasks(repo = FALLBACK_REPO): MergeableTask[] {
  const dir = path.join(repo, '.orchestra', 'tasks');
  if (!existsSync(dir)) return [];
  const out: MergeableTask[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort().reverse()) {
    try {
      const r = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
      const branch = r.worktree?.branch as string | undefined;
      if (!branch) continue;
      const exists = git(repo, ['rev-parse', '--verify', `refs/heads/${branch}`]);
      if (!exists.ok) continue;
      const ancestor = git(repo, ['merge-base', '--is-ancestor', branch, 'HEAD']);
      if (ancestor.ok) continue; // đã merge rồi
      out.push({
        id: String(r.id ?? f),
        node: String(r.node ?? '?'),
        worker: String(r.routing?.pick ?? '?'),
        branch,
        worktreePath: r.worktree?.path,
        patchRef: r.artifacts?.patch_ref ?? null,
        files: r.artifacts?.files_changed ?? [],
      });
    } catch {
      /* bỏ qua */
    }
  }
  return out;
}

export function reviewMerge(repo: string, taskId: string, action: 'merge' | 'reject'): { ok: boolean; detail: string } {
  const task = mergeableTasks(repo).find((t) => t.id === taskId);
  if (!task) return { ok: false, detail: `task ${taskId} không còn mergeable` };
  if (action === 'merge') {
    const m = mergeBranch(repo, task.branch);
    return { ok: m.ok, detail: m.ok ? `merged ${task.branch}` : `merge conflict: ${m.out.slice(-200)}` };
  }
  addFeedback(repo, { type: 'verdict_rejected', taskId, worker: task.worker, detail: 'user reject ở Review & Merge UI' });
  return { ok: true, detail: `rejected — feedback verdict_rejected ghi cho ${task.worker}` };
}

// ---------- Policy editable (P5.3): click cell = promote worker lên #1 ----------
export function promoteWorker(repo: string, role: string, cli: string): { ok: boolean; detail: string } {
  const lp = loadPolicy(repo);
  const basePolicy: PolicyFile = lp.policy ?? { version: 1 };
  const bindings: PolicyFile['bindings'] = {};
  for (const [r, binds] of Object.entries(basePolicy.bindings ?? {})) {
    bindings[r] = binds.map((b) => ({ worker: { ...b.worker }, ...(b.boost_when ? { boost_when: b.boost_when } : {}) }));
  }
  for (const [r, ids] of Object.entries(DEFAULT_BINDINGS)) {
    if (!bindings[r]) bindings[r] = ids.map((cli2) => ({ worker: { cli: cli2 } }));
  }
  if (!bindings[role]) return { ok: false, detail: `role '${role}' không có bindings` };
  const idx = bindings[role]!.findIndex((b) => b.worker.cli === cli);
  if (idx < 0) return { ok: false, detail: `${cli} không có trong bindings của ${role}` };
  if (idx === 0) return { ok: true, detail: `${cli} đã là #1 cho ${role} — không đổi` };

  const moved = bindings[role]!.splice(idx, 1)[0]!;
  bindings[role]!.unshift(moved);

  const out: PolicyFile = { ...basePolicy, version: basePolicy.version ?? 1, bindings };
  mkdirSync(path.join(repo, '.orchestra'), { recursive: true });
  const file = path.join(repo, '.orchestra', 'policy.yml');
  writeFileSync(file, yaml.dump(out, { lineWidth: 120 }), 'utf8');

  const check = loadPolicy(repo);
  return {
    ok: check.source === 'project' && check.errors.length === 0,
    detail: `promoted ${cli} → #1 cho ${role}; ${file} (source=${check.source}${check.errors.length ? `, errors: ${check.errors.join('; ')}` : ''})`,
  };
}

export function restoreDefaultPolicy(repo: string): boolean {
  const f = path.join(repo, '.orchestra', 'policy.yml');
  if (!existsSync(f)) return false;
  rmSync(f);
  return true;
}

// ---------- Override tracking (P5.3): user chọn worker khác auto-pick ----------
export function trackOverride(
  repo: string,
  o: { autoPick?: string; pin?: string; taskId?: string; ok: boolean },
): { tracked: boolean; detail: string } {
  if (!o.ok) return { tracked: false, detail: 'dispatch fail — không ghi override' };
  if (!o.pin || !o.autoPick || o.pin === o.autoPick) return { tracked: false, detail: 'không phải override' };
  addFeedback(repo, {
    type: 'task_reassigned',
    taskId: o.taskId,
    worker: o.pin,
    detail: `user override từ auto-pick '${o.autoPick}'`,
  });
  return { tracked: true, detail: `override ${o.autoPick} → ${o.pin} ghi feedback task_reassigned` };
}

export async function dispatchTracked(
  repo: string,
  o: { node: 'implement'; role: string; goal: string; scope: string[]; acceptance: string[]; pin?: string; model?: string; onEvent?: (e: { t: string; [k: string]: unknown }) => void; hooksEnabled?: boolean; skillSync?: boolean },
): Promise<{ autoPick?: string; result: Awaited<ReturnType<typeof import('../../prototype/src/dispatch.js').dispatch>>; override: string }> {
  const pol = loadPolicy(repo);
  const stats = buildFleetStats(path.join(repo, '.orchestra', 'tasks'), pol.policy?.routing?.decay_days ?? 30);
  const auto = resolveWorker(o.role, { policy: pol.policy, stats });
  const { dispatch } = await import('../../prototype/src/dispatch.js');
  const result = await dispatch({
    repo, node: o.node, role: o.role, goal: o.goal, scope: o.scope,
    constraints: [], acceptance: o.acceptance, workerPin: o.pin, model: o.model,
    hooksEnabled: o.hooksEnabled, skillSync: o.skillSync,
    onEvent: o.onEvent as ((e: { t: string; [k: string]: unknown }) => void) | undefined,
  });
  const tr = trackOverride(repo, { autoPick: auto.pick, pin: o.pin, taskId: result.taskId, ok: result.ok });
  return { autoPick: auto.pick, result, override: tr.detail };
}

// ---------- Conformance badge cho Fleet panel (P6: + stale khi CLI update) ----------
export function conformanceBadge(repo: string, id: string, version?: string): string | null {
  const dir = path.join(repo, '.orchestra', 'conformance');
  if (!version || !existsSync(dir)) return null;
  const exact = path.join(dir, `${id}-${version}.json`);
  if (existsSync(exact)) {
    try {
      return JSON.parse(readFileSync(exact, 'utf8')).badge ?? null;
    } catch {
      return null;
    }
  }
  // CLI update mà chưa chạy conformance lại → badge vàng 'stale'
  const anyForId = readdirSync(dir).some((f) => f.startsWith(`${id}-`) && f.endsWith('.json'));
  return anyForId ? 'stale' : null;
}

// ---------- Chat với Orchestrator (P5.6) ----------
// Brain = 1 CLI trong fleet (mặc định claude) chạy read-only + session resume để nhớ hội thoại.
// Orchestrator KHÔNG tự làm việc — nó phát hành action ```orchestra {json}``` và extension thực thi
// qua đường dispatch/pipeline có đầy đủ guard. Kết quả được feedback lại vào session.

export const ORCHESTRATOR_SYSTEM_PROMPT = `Bạn là Orchestra Orchestrator — IDE agent điều phối các agent CLI (claude, codex, ...) như worker trong pipeline có gate.
Bạn đang chat với user trong VS Code. Quy tắc bắt buộc:
1. Trả lời NGẮN GỌN bằng tiếng Việt.
2. Bạn ở chế độ read-only (plan) — KHÔNG tự sửa file, KHÔNG tự code. Bạn CÓ ĐƯỢC dùng Glob/Grep/Read để khảo sát repo trước khi trả lời.
3. Khi user yêu cầu làm việc trong repo (thêm feature, sửa bug, chạy pipeline, sync skill, xem trạng thái...), hãy phát hành action trong fenced block đúng cú pháp:
\`\`\`orchestra
{"action":"dispatch","goal":"<mục tiêu>","scope":["src/**"],"worker":"codex|claude|auto","model":"tùy chọn"}
\`\`\`
hoặc:
- {"action":"pipeline","template":"feature-dev|hotfix","goal":"...","scope":["..."]}
- {"action":"status"}  — xem fleet + task gần nhất
- {"action":"sync_skills"} — sync KB ra AGENTS.md/CLAUDE.md
4. MỌI action dispatch/pipeline BẮT BUỘC có scope (danh sách glob). Xác định scope theo thứ tự:
   a. KIẾN THỨC DỰ ÁN được cấp ở dưới (project memory) — nếu khớp module thì dùng scope của nó;
   b. không có → khảo sát repo bằng Glob/Grep/Read để tìm module liên quan (vd grep tên tính năng);
   c. vẫn không chắc → HỎI LẠI user scope, đừng đoán. Dispatch thiếu scope sẽ bị hệ thống từ chối (hàng rào bắt buộc).
5. Một tin nhắn chỉ nên chứa tối đa 1-2 action. Chờ kết quả [orchestra-runner] rồi mới action tiếp.
6. Câu hỏi tư vấn/khái niệm thì trả lời trực tiếp, không cần action.`;

export interface OrchestraAction {
  action: 'dispatch' | 'pipeline' | 'status' | 'sync_skills';
  goal?: string;
  scope?: string[];
  worker?: string;
  model?: string;
  template?: string;
}

export function parseOrchestraActions(text: string): OrchestraAction[] {
  const out: OrchestraAction[] = [];
  const re = /```orchestra\s*\r?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[1]!.trim()) as OrchestraAction;
      if (obj && typeof obj.action === 'string') out.push(obj);
    } catch {
      /* block JSON lỗi — bỏ qua, không crash chat */
    }
  }
  return out;
}

export async function orchestratorTurn(
  repo: string,
  message: string,
  sessionId?: string,
  workerId = 'claude',
  model?: string,
): Promise<{ text: string; session?: string; rawLines: number }> {
  const m = MANIFESTS.find((x) => x.id === workerId) ?? MANIFESTS[0]!;
  // P5.7: bơm project memory vào chat brain — worker-agnostic (codex brain không đọc CLAUDE.md)
  const kb = recallKB(repo, ['**'], 1500);
  const kbBlock = kb.injected ? `\n\nKIẾN THỨC DỰ ÁN (project memory — dùng để xác định scope):\n${kb.injected}` : '';
  const { runHeadless } = await import('../../prototype/src/runner.js');
  const r = await runHeadless(m, message, {
    cwd: repo,
    rawDir: path.join(repo, '.orchestra', 'raw'),
    silenceMs: 90_000,
    wallMs: 240_000,
    netOff: true,
    headless: { sandbox: 'read-only', resume: sessionId, systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT + kbBlock, model },
  });
  const texts = r.events
    .filter((e) => e.t === 'message' && typeof e['text'] === 'string')
    .map((e) => String(e['text']));
  return { text: texts.join('\n\n') || r.stderrTail || '(không có phản hồi)', session: r.session, rawLines: r.rawLines };
}

export async function executeAction(repo: string, a: OrchestraAction): Promise<string> {
  switch (a.action) {
    case 'status': {
      const fleet = fleetSnapshot().map((f) => `${f.id}@${f.version ?? '?'}${f.installed ? '' : ' (chưa cài)'}`).join(', ');
      const tasks = tasksSnapshot(repo).slice(0, 5).map((t) => `${t.id} ${t.node}/${t.worker} exit=${t.exit}`);
      return `Fleet: ${fleet}\nTask gần nhất:\n${tasks.map((t) => `- ${t}`).join('\n') || '(chưa có)'}`;
    }
    case 'sync_skills': {
      const { syncSkills } = await import('../../prototype/src/skillsync.js');
      const r = syncSkills(repo);
      return `synced ${r.entries} KB (${r.pinned} pinned) → ${r.files.join(' + ')}`;
    }
    case 'dispatch': {
      if (!a.goal) return 'dispatch thiếu goal';
      const r = await dispatchTracked(repo, {
        node: 'implement',
        role: 'coder',
        goal: a.goal,
        scope: a.scope ?? [],
        acceptance: [],
        pin: a.worker && a.worker !== 'auto' ? a.worker : undefined,
        model: a.model,
        hooksEnabled: true,
        skillSync: true,
      });
      const files = r.result.record ? (r.result.record as Record<string, any>).artifacts?.files_changed ?? [] : [];
      return `dispatch ${r.result.ok ? 'OK' : 'FAILED'} ${r.result.taskId} worker=${r.result.record ? pickOf(r.result.record) : '?'} files=[${files.join(', ')}] record=${r.result.recordPath ?? ''}`;
    }
    case 'pipeline': {
      if (!a.goal) return 'pipeline thiếu goal';
      const protoDir = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
      const { runPipeline } = await import('../../prototype/src/orchestrator.js');
      const r = await runPipeline({
        repo,
        templatePath: path.join(protoDir, 'prototype', 'templates', `${a.template ?? 'feature-dev'}.yml`),
        goal: a.goal,
        scope: a.scope ?? [],
        acceptance: [],
        autoYes: true, // chat là context async — không có stdin để hỏi
        onLog: () => {},
      });
      return `pipeline ${r.runId}: ${r.ok ? 'OK' : 'FAILED'} merged=${r.merged}`;
    }
    default:
      return `action không hỗ trợ: ${JSON.stringify(a)}`;
  }
}

function pickOf(rec: Record<string, unknown>): string {
  const r = rec['routing'] as { pick?: string } | undefined;
  return r?.pick ?? '?';
}

/**
 * D1 — chatExchange: vòng lặp chat hoàn chỉnh (turn → parse action → execute → feedback).
 * Dùng chung cho extension ChatView + Desktop chat page — không còn 2 bản.
 */
export interface ChatMessage {
  kind: 'orch' | 'result';
  text: string;
}

export async function chatExchange(
  repo: string,
  userText: string,
  sessionId: string | undefined,
  opts: { workerId?: string; model?: string; notify?: (m: ChatMessage) => void; hooksEnabled?: boolean; skillSync?: boolean },
): Promise<{ session?: string }> {
  const emit = (m: ChatMessage) => opts.notify?.(m);
  const turn = await orchestratorTurn(repo, userText, sessionId, opts.workerId ?? 'claude', opts.model);
  emit({ kind: 'orch', text: turn.text });

  const actions = parseOrchestraActions(turn.text);
  if (!actions.length) return { session: turn.session };

  const results: string[] = [];
  for (const a of actions) {
    try {
      results.push(await executeAction(repo, a));
    } catch (err) {
      results.push(`${a.action} lỗi: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const summary = `[orchestra-runner] Kết quả các action:\n${results.map((r, i) => `${i + 1}. ${r}`).join('\n')}`;
  emit({ kind: 'result', text: summary });
  const follow = await orchestratorTurn(repo, summary, turn.session, opts.workerId ?? 'claude', opts.model);
  if (follow.text.trim()) emit({ kind: 'orch', text: follow.text });
  return { session: follow.session };
}

export function policyMatrixHtml(repo = FALLBACK_REPO, interactive = false): string {
  const lp = loadPolicy(repo);
  const stats = buildFleetStats(path.join(repo, '.orchestra', 'tasks'), lp.policy?.routing?.decay_days ?? 30);
  const kb = loadKB(repo);
  const minSample = lp.policy?.routing?.min_sample ?? 10;
  const roles = [...new Set([...Object.keys(lp.policy?.bindings ?? {}), 'coder', 'planner', 'verifier', 'reviewer'])];
  const rows = roles
    .map((role) => {
      const binds = lp.policy?.bindings?.[role] ?? [];
      const cells = MANIFESTS.map((m) => {
        const idx = binds.findIndex((b) => b.worker.cli === m.id);
        if (idx < 0) return `<td style="color:#555">—</td>`;
        const s = stats.get(`${m.id}|${role}`);
        const stat =
          s && s.dispatched >= minSample
            ? `ema ${s.ema.toFixed(2)} (n=${s.dispatched})`
            : s
              ? `n=${s.dispatched} (&lt; ${minSample})`
              : 'chưa có số liệu';
        // P6.6: channel tag theo luật phân phối model
        const bModel = binds[idx]?.worker?.model;
        const ch = bModel ? resolveModelFor(m, bModel, repo) : null;
        const tag = ch ? `<small style="color:${ch.ok ? '#6a9955' : '#f48771'}">${ch.channel}</small><br>` : '';
        return `<td data-role="${role}" data-cli="${m.id}" style="${interactive ? 'cursor:pointer' : ''}" title="${interactive ? 'Click = promote lên #1 (ghi policy.yml)' : ''}${ch && !ch.ok ? ` — ⚠ ${ch.reason}` : ''}">${idx === 0 ? '●' : '○'} #${idx + 1}<br><small>${bModel ?? ''}</small>${tag}<small>${stat}</small></td>`;
      }).join('');
      return `<tr><th>${role}</th>${cells}</tr>`;
    })
    .join('');
  const kbRows = kb
    .map((e) => `<tr><td>${e.id}</td><td>${e.title}</td><td>${e.scope.join(', ')}</td><td>${e.source}</td><td>${e.pinned ? '📌' : ''}</td></tr>`)
    .join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:Segoe UI,sans-serif;background:#1e1e1e;color:#d4d4d4;padding:12px}
    table{border-collapse:collapse;margin:8px 0}th,td{border:1px solid #444;padding:6px 10px;text-align:left}
    h3{color:#4fc1ff}</style></head><body>
    <h3>Role × Worker matrix</h3>
    <p>policy source: <b>${lp.source}</b>${lp.errors.length ? ` — ⚠ ${lp.errors.join('; ')}` : ' — hợp lệ'}</p>
    <table><tr><th>role</th>${MANIFESTS.map((m) => `<th>${m.id}</th>`).join('')}</tr>${rows}</table>
    <h3>Project KB (${kb.length})</h3>
    <table><tr><th>id</th><th>title</th><th>scope</th><th>source</th><th>pinned</th></tr>${kbRows}</table>
    ${interactive ? `<p><small>Click ô worker = promote lên #1 cho role đó (ghi <code>.orchestra/policy.yml</code> — đổi policy là một diff review được).</small></p>
    <script>
      // host-agnostic: VS Code webview dùng acquireVsCodeApi; Desktop iframe dùng parent.postMessage
      const vscode = window.acquireVsCodeApi ? window.acquireVsCodeApi() : { postMessage: (m) => window.parent.postMessage(m, '*') };
      document.querySelectorAll('td[data-role]').forEach((td) => {
        td.addEventListener('click', () => {
          vscode.postMessage({ kind: 'promote', role: td.dataset.role, cli: td.dataset.cli });
        });
      });
    </script>` : ''}
  </body></html>`;
}
