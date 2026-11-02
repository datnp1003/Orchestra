// Orchestra VS Code extension — P5 slice 1
// Fleet panel · Tasks panel · Dispatch với live transcript · Policy matrix webview
import * as vscode from 'vscode';
import { MANIFESTS, getManifest } from '../../prototype/src/manifests.js';
import { checkStatus, installWorker } from '../../prototype/src/registry.js';
import { dispatch } from '../../prototype/src/dispatch.js';
import { runPipeline } from '../../prototype/src/orchestrator.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { FALLBACK_REPO, fleetSnapshot, tasksSnapshot, policyMatrixHtml, mergeableTasks, reviewMerge, promoteWorker, dispatchTracked, conformanceBadge, orchestratorTurn, executeAction, parseOrchestraActions } from './logic.js';
import { syncSkills } from '../../prototype/src/skillsync.js';
import type { Manifest } from '../../prototype/src/types.js';

function cfg<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('orchestra').get<T>(key, fallback);
}

function repoRoot(): string {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (ws && existsSync(path.join(ws, '.orchestra'))) return ws;
  const configured = cfg<string>('defaultRepo', '');
  if (configured && existsSync(configured)) return configured;
  return FALLBACK_REPO;
}

// ---------- Fleet panel ----------
class FleetItem extends vscode.TreeItem {
  constructor(public s: ReturnType<typeof checkStatus> & { id: string; display: string }) {
    super(`${s.installed ? '✓' : '✗'} ${s.display}`, vscode.TreeItemCollapsibleState.None);
    this.description = `${s.version ?? '-'} · auth=${s.auth}${s.experimental ? ' · [experimental]' : ''}`;
    this.tooltip = s.notes.join('\n');
    this.contextValue = 'worker';
    // P6.3: chưa cài → click item = cài qua npm
    if (!s.installed) {
      this.command = { command: 'orchestra.installWorker', title: 'Install worker', arguments: [s.id] };
      this.tooltip += '\n\nChưa cài — click để cài qua npm.';
    }
  }
}

class FleetProvider implements vscode.TreeDataProvider<FleetItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  refresh(): void {
    this._onDidChange.fire();
  }
  getTreeItem(e: FleetItem): vscode.TreeItem {
    return e;
  }
  getChildren(): FleetItem[] {
    const repo = repoRoot();
    return MANIFESTS.map((m) => {
      const s = checkStatus(m);
      const badge = conformanceBadge(repo, m.id, s.version);
      const item = new FleetItem({ ...s, id: m.id, display: m.display });
      if (badge) item.description = `${item.description} · conformance=${badge}`;
      return item;
    });
  }
}

// ---------- Tasks panel ----------
class TaskItem extends vscode.TreeItem {
  constructor(rec: { id: string; node: string; worker: string; exit: number | null; scopeOk: boolean; files: number; file: string }) {
    super(rec.id, vscode.TreeItemCollapsibleState.None);
    this.description = `${rec.node} · ${rec.worker} · exit=${rec.exit} · ${rec.scopeOk ? 'scope OK' : 'SCOPE VIOLATION'} · ${rec.files} file`;
    this.tooltip = rec.file;
    this.command = { command: 'orchestra.openRecord', title: 'Open record', arguments: [rec.file] };
  }
}

class TasksProvider implements vscode.TreeDataProvider<TaskItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  constructor(private repoFn: () => string) {}
  refresh(): void {
    this._onDidChange.fire();
  }
  getTreeItem(e: TaskItem): vscode.TreeItem {
    return e;
  }
  getChildren(): TaskItem[] {
    const dir = path.join(this.repoFn(), '.orchestra', 'tasks');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, 30)
      .map((f) => {
        try {
          const r = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
          return new TaskItem({
            id: String(r.id ?? f),
            node: String(r.node ?? '?'),
            worker: String(r.routing?.pick ?? r.brief?.worker ?? '?'),
            exit: r.run?.exit ?? null,
            scopeOk: r.scope_check?.ok !== false,
            files: r.artifacts?.files_changed?.length ?? 0,
            file: path.join(dir, f),
          });
        } catch {
          return null;
        }
      })
      .filter((x): x is TaskItem => x !== null);
  }
}

// ---------- Webviews ----------
function transcriptPanel(runLabel: string): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel('orchestraTranscript', `Orchestra — ${runLabel}`, vscode.ViewColumn.Beside, {
    enableScripts: true,
  });
  panel.webview.html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { font-family: Consolas, monospace; font-size: 12px; background: #1e1e1e; color: #d4d4d4; padding: 8px; }
  .ev { margin: 1px 0; white-space: pre-wrap; }
  .session { color: #569cd6; } .tool_use { color: #dcdcaa; } .message { color: #ce9178; }
  .usage { color: #6a9955; } .error, .blocked { color: #f48771; } .done { color: #4fc1ff; font-weight: bold; }
</style></head>
<body><div id="log"><div class="ev done">— Orchestra transcript: ${runLabel} —</div></div>
<script>
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (d.kind === 'event') {
      const div = document.createElement('div');
      div.className = 'ev ' + d.t;
      div.textContent = JSON.stringify(d.payload);
      document.getElementById('log').appendChild(div);
    } else if (d.kind === 'log') {
      const div = document.createElement('div');
      div.className = 'ev';
      div.textContent = d.line;
      document.getElementById('log').appendChild(div);
    }
  });
</script></body></html>`;
  return panel;
}

// ---------- Chat panel (P5.6) ----------
class ChatViewProvider implements vscode.WebviewViewProvider {
  private sessionId?: string;
  private busy = false;

  constructor(private readonly getRepo: () => string) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    view.webview.html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { font-family: Segoe UI, sans-serif; background: #1e1e1e; color: #d4d4d4; margin: 0; display: flex; flex-direction: column; height: 100vh; }
  #msgs { flex: 1; overflow-y: auto; padding: 8px; }
  .m { margin: 4px 0; padding: 6px 10px; border-radius: 8px; max-width: 92%; white-space: pre-wrap; font-size: 12px; }
  .user { background: #264f78; margin-left: auto; }
  .orch { background: #2d2d2d; }
  .result { background: #1a2b1a; font-family: Consolas, monospace; font-size: 11px; }
  .typing { color: #888; font-style: italic; }
  #bar { display: flex; gap: 4px; padding: 6px; border-top: 1px solid #333; }
  #input { flex: 1; background: #2d2d2d; color: #d4d4d4; border: 1px solid #444; border-radius: 4px; padding: 6px; font-size: 12px; resize: none; height: 44px; }
  button { background: #0e639c; color: white; border: none; border-radius: 4px; padding: 4px 10px; cursor: pointer; }
</style></head>
<body><div id="msgs"><div class="m orch">Orchestra Orchestrator sẵn sàng. Nói tự nhiên: "thêm cổng ZaloPay vào src/payment", "trạng thái fleet?", "chạy pipeline hotfix cho..." — tôi sẽ phát hành action và worker sẽ làm.</div></div>
<div id="bar"><textarea id="input" placeholder="Nhắn cho orchestrator… (Enter để gửi)"></textarea><button id="send">Gửi</button></div>
<script>
  const vs = acquireVsCodeApi();
  const msgs = document.getElementById('msgs');
  function add(cls, text) { const d = document.createElement('div'); d.className = 'm ' + cls; d.textContent = text; msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight; }
  function send() { const i = document.getElementById('input'); const t = i.value.trim(); if (!t) return; i.value = ''; add('user', t); vs.postMessage({ kind: 'user', text: t }); }
  document.getElementById('send').onclick = send;
  document.getElementById('input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (d.kind === 'orch') add('orch', d.text);
    else if (d.kind === 'result') add('result', d.text);
    else if (d.kind === 'typing') add('typing', d.text);
  });
</script></body></html>`;

    view.webview.onDidReceiveMessage(async (msg: { kind: string; text?: string }) => {
      if (msg.kind !== 'user' || !msg.text || this.busy) return;
      this.busy = true;
      const repo = this.getRepo();
      try {
        const turn = await orchestratorTurn(repo, msg.text, this.sessionId, cfg<string>('orchestratorWorker', 'claude'));
        this.sessionId = turn.session;
        void view.webview.postMessage({ kind: 'orch', text: turn.text });

        const actions = parseOrchestraActions(turn.text);
        if (actions.length) {
          const results: string[] = [];
          for (const a of actions) {
            void view.webview.postMessage({ kind: 'typing', text: `thực thi ${a.action}…` });
            try {
              results.push(await executeAction(repo, a));
            } catch (err) {
              results.push(`${a.action} lỗi: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          const summary = `[orchestra-runner] Kết quả các action:\n${results.map((r, i) => `${i + 1}. ${r}`).join('\n')}`;
          void view.webview.postMessage({ kind: 'result', text: summary });
          // feedback kết quả vào session — orchestrator biết chuyện gì vừa xảy ra
          const follow = await orchestratorTurn(repo, summary, this.sessionId, cfg<string>('orchestratorWorker', 'claude'));
          this.sessionId = follow.session;
          if (follow.text.trim()) void view.webview.postMessage({ kind: 'orch', text: follow.text });
        }
      } catch (err) {
        void view.webview.postMessage({ kind: 'result', text: `lỗi orchestrator: ${err instanceof Error ? err.message : String(err)}` });
      } finally {
        this.busy = false;
        vscode.commands.executeCommand('orchestra.refreshViews');
      }
    });
  }
}

// ---------- activation ----------
export function activate(context: vscode.ExtensionContext): void {
  const fleetProvider = new FleetProvider();
  const tasksProvider = new TasksProvider(repoRoot);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('orchestra.fleetView', fleetProvider),
    vscode.window.registerTreeDataProvider('orchestra.tasksView', tasksProvider),
    vscode.window.registerWebviewViewProvider('orchestra.chatView', new ChatViewProvider(repoRoot)),
    vscode.commands.registerCommand('orchestra.refreshViews', () => {
      fleetProvider.refresh();
      tasksProvider.refresh();
    }),
    vscode.commands.registerCommand('orchestra.openRecord', (file: string) => {
      vscode.window.showTextDocument(vscode.Uri.file(file));
    }),
  );

  // Dispatch Task — input → dispatch → live transcript webview
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestra.dispatch', async () => {
      const repo = repoRoot();
      const goal = await vscode.window.showInputBox({ prompt: 'Mục tiêu task?', placeHolder: 'Thêm cổng thanh toán X theo pattern Y' });
      if (!goal) return;
      const scope = await vscode.window.showInputBox({ prompt: 'Phạm vi file (glob, cách nhau bởi dấu phẩy)?', value: 'src/payment/**' });
      if (scope === undefined) return;
      const workerPick = await vscode.window.showQuickPick(['auto (Role Policy)', ...MANIFESTS.map((m) => m.id)], { title: 'Worker' });
      if (!workerPick) return;
      const model = await vscode.window.showInputBox({
        prompt: 'Model riêng? (để trống = theo binding trong policy.yml)',
        placeHolder: 'vd: worker-codex, gpt-5.3-codex, opus-4.6…',
      });
      const panel = transcriptPanel(goal.slice(0, 40));
      const onEvent = (e: { t: string; [k: string]: unknown }) => void panel.webview.postMessage({ kind: 'event', t: e.t, payload: e });
      try {
        const pin = workerPick.startsWith('auto') ? undefined : workerPick;
        const r = await dispatchTracked(repo, {
          node: 'implement',
          role: 'coder',
          goal,
          scope: scope.split(',').map((s) => s.trim()).filter(Boolean),
          acceptance: [],
          pin,
          model: model || undefined,
          onEvent,
          hooksEnabled: cfg<boolean>('hooksEnabled', true),
          skillSync: cfg<boolean>('skillSync', true),
        });
        onEvent({ t: 'done', summary: r.result.ok ? 'OK' : `FAILED: ${r.result.reason ?? ''}`, taskId: r.result.taskId, recordPath: r.result.recordPath ?? '' });
        const overrideMsg = r.override.startsWith('override') ? ` (${r.override})` : '';
        vscode.window.showInformationMessage(`Orchestra dispatch ${r.result.ok ? 'OK' : 'FAILED'} — ${r.result.taskId}${overrideMsg}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Orchestra dispatch lỗi: ${err instanceof Error ? err.message : String(err)}`);
      }
      vscode.commands.executeCommand('orchestra.refreshViews');
    }),
  );

  // Run Pipeline
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestra.runPipeline', async () => {
      const repo = repoRoot();
      const goal = await vscode.window.showInputBox({ prompt: 'Mục tiêu pipeline?' });
      if (!goal) return;
      const tpl = await vscode.window.showQuickPick(['feature-dev', 'hotfix'], { title: 'Template' });
      if (!tpl) return;
      const scope = await vscode.window.showInputBox({ prompt: 'Scope glob?', value: 'src/payment/**' });
      if (scope === undefined) return;
      const panel = transcriptPanel(`pipeline ${tpl}`);
      try {
        const tplDir = cfg<string>('templatesDir', '') || path.join(context.extensionPath, '..', 'prototype', 'templates');
        const r = await runPipeline({
          repo,
          templatePath: path.join(tplDir, `${tpl}.yml`),
          goal,
          scope: scope.split(',').map((s) => s.trim()).filter(Boolean),
          acceptance: [],
          autoYes: cfg<boolean>('autoApprovePlan', false),
          onLog: (line) => void panel.webview.postMessage({ kind: 'log', line }),
        });
        await panel.webview.postMessage({ kind: 'log', line: `KẾT QUẢ: ${r.ok ? 'OK' : 'FAILED'} merged=${r.merged}` });
        vscode.window.showInformationMessage(`Orchestra pipeline ${r.runId}: ${r.ok ? 'OK' : 'FAILED'}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Orchestra pipeline lỗi: ${err instanceof Error ? err.message : String(err)}`);
      }
      vscode.commands.executeCommand('orchestra.refreshViews');
    }),
  );

  // Policy matrix webview — interactive (P5.3): click cell → promote → reload
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestra.showMatrix', () => {
      const panel = vscode.window.createWebviewPanel('orchestraMatrix', 'Orchestra — Policy Matrix', vscode.ViewColumn.One, { enableScripts: true });
      const repo = repoRoot();
      panel.webview.html = policyMatrixHtml(repo, true);
      panel.webview.onDidReceiveMessage((msg: { kind: string; role?: string; cli?: string }) => {
        if (msg.kind === 'promote' && msg.role && msg.cli) {
          const r = promoteWorker(repo, msg.role, msg.cli);
          if (r.ok) {
            panel.webview.html = policyMatrixHtml(repo, true);
            void panel.webview.postMessage({ kind: 'log', line: r.detail });
            fleetProvider.refresh();
          } else {
            void vscode.window.showErrorMessage(`Orchestra: ${r.detail}`);
          }
        }
      });
    }),
  );

  // Review & Merge (P5.2): pick task mergeable → xem patch → merge/reject (+ feedback)

  // Review & Merge (P5.2): pick task mergeable → xem patch → merge/reject (+ feedback)
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestra.reviewMerge', async () => {
      const repo = repoRoot();
      const candidates = mergeableTasks(repo);
      if (!candidates.length) {
        vscode.window.showInformationMessage('Orchestra: không có task nào chờ merge.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        candidates.map((t) => ({
          label: `${t.id}`,
          description: `${t.node} · ${t.worker} · ${t.files.length} file`,
          detail: t.branch,
          task: t,
        })),
        { title: 'Task chờ merge (branch chưa vào main)' },
      );
      if (!pick) return;

      if (pick.task.patchRef && existsSync(pick.task.patchRef)) {
        await vscode.window.showTextDocument(vscode.Uri.file(pick.task.patchRef), { viewColumn: vscode.ViewColumn.Beside });
      }
      const action = await vscode.window.showQuickPick(
        [
          { label: 'Merge vào main', value: 'merge' as const },
          { label: 'Reject (ghi feedback verdict_rejected)', value: 'reject' as const },
        ],
        { title: `Xem diff của ${pick.task.id} rồi quyết định` },
      );
      if (!action) return;
      const r = reviewMerge(repo, pick.task.id, action.value);
      if (r.ok) {
        vscode.window.showInformationMessage(`Orchestra: ${r.detail}`);
        vscode.commands.executeCommand('orchestra.refreshViews');
      } else {
        vscode.window.showErrorMessage(`Orchestra: ${r.detail}`);
      }
    }),
  );

  // Install worker (P6.3): npm -g với progress + log ra Output channel
  const installChannel = vscode.window.createOutputChannel('Orchestra — install');
  context.subscriptions.push(installChannel);
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestra.installWorker', async (id?: string) => {
      const m = (id ? MANIFESTS.find((x) => x.id === id) : undefined) ?? (await (async () => {
        const notInstalled = MANIFESTS.filter((x) => !checkStatus(x).installed);
        if (!notInstalled.length) {
          vscode.window.showInformationMessage('Orchestra: mọi worker đều đã cài.');
          return undefined;
        }
        const pick = await vscode.window.showQuickPick(
          notInstalled.map((x) => ({ label: x.display, detail: `npm i -g ${x.install?.npm ?? '?'}`, id: x.id })),
          { title: 'Cài worker qua npm' },
        );
        return pick ? MANIFESTS.find((x) => x.id === pick.id) : undefined;
      })());
      if (!m) return;
      installChannel.show(true);
      installChannel.appendLine(`[install] ${m.id}: npm i -g ${m.install?.npm}`);
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Orchestra: đang cài ${m.display}…`, cancellable: false },
        async () => {
          const r = await installWorker(m, (line) => installChannel.appendLine(line));
          if (r.ok) {
            installChannel.appendLine(`[done] ${r.detail}`);
            vscode.window.showInformationMessage(`Orchestra: ${r.detail}`, 'Mở terminal để login').then((choice) => {
              if (choice) vscode.commands.executeCommand('workbench.action.terminal.new');
            });
          } else {
            installChannel.appendLine(`[fail] ${r.detail}`);
            vscode.window.showErrorMessage(`Orchestra: ${r.detail}`);
          }
        },
      );
      vscode.commands.executeCommand('orchestra.refreshViews');
    }),
  );

  // Sync Skills (P5.4): KB → AGENTS.md + CLAUDE.md — "skill pack" của Orchestra
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestra.syncSkills', () => {
      const repo = repoRoot();
      const r = syncSkills(repo);
      vscode.window.showInformationMessage(`Orchestra: synced ${r.entries} KB entries (${r.pinned} pinned) → ${r.files.join(' + ')}`);
    }),
  );

  // Auth (P6.4): Login OAuth qua terminal
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestra.authWorker', async (id?: string) => {
      const m = (id ? MANIFESTS.find((x) => x.id === id) : undefined) ?? (await (async () => {
        const pick = await vscode.window.showQuickPick(MANIFESTS.map((x) => ({ label: x.display, id: x.id })), { title: 'Chọn worker để cấu hình auth' });
        return pick ? MANIFESTS.find((x) => x.id === pick.id) : undefined;
      })());
      if (!m) return;
      // R2a: key/provider khác → Orchestra router (Providers trong desktop); ở đây chỉ còn OAuth của chính CLI
      const term = vscode.window.createTerminal({ name: `Orchestra — login ${m.id}` });
      term.show();
      term.sendText(m.id === 'codex' ? 'codex login' : m.bin!, true); // claude: interactive TUI → /login trong đó
      vscode.window.showInformationMessage(`OAuth ${m.oauthProvider ?? '(không)'}: hoàn tất login rồi bấm Refresh Fleet.`);
    }),
  );

  // Internal snapshot commands — integration test dùng, không hiện palette
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestra._fleetSnapshot', () => fleetSnapshot()),
    vscode.commands.registerCommand('orchestra._tasksSnapshot', () => tasksSnapshot(repoRoot()).length),
    vscode.commands.registerCommand('orchestra._policyMatrixHtml', () => policyMatrixHtml(repoRoot())),
  );
}

export function deactivate(): void {
  /* nothing */
}

// re-export để integration test import trực tiếp nếu cần
export { getManifest };
