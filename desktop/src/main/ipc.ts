// IPC wiring — bọc logic.ts (API duy nhất) vào ipcMain. Không viết logic mới ở đây.
import type { IpcMain, BrowserWindow, Notification } from 'electron';
import { app } from 'electron';
import { spawn as ptySpawn } from '@lydell/node-pty';
import { IPC, EVENTS, requireRepo, type AppSettings, type DispatchPayload } from './contract.js';
import { loadSettings, saveSettings } from './settingsStore.js';
import {
  fleetSnapshot, tasksSnapshot, policyMatrixHtml, promoteWorker, mergeableTasks, reviewMerge,
  dispatchTracked, conformanceBadge, modelsList,
} from '../../../extension/src/logic.js';
import { runPipeline } from '../../../prototype/src/orchestrator.js';
import { syncSkills } from '../../../prototype/src/skillsync.js';
import { runConformance } from '../../../prototype/src/conformance.js';
import { installWorker, uninstallWorker, checkStatus } from '../../../prototype/src/registry.js';
import { vaultSet, vaultDelete } from '../../../prototype/src/vault.js';
import { getManifest, MANIFESTS } from '../../../prototype/src/manifests.js';
import { protoAsset } from '../../../prototype/src/paths.js';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';

export interface IpcContext {
  win: () => BrowserWindow | null;
  settingsFile: string;
  notify: (title: string, body: string) => void;
  protoDir: string;
}

export function wireIpc(ipcMain: IpcMain, ctx: IpcContext): void {
  const settings = () => loadSettings(ctx.settingsFile);
  // chạy fn với repo hợp lệ; không có repo → fallback(lỗi) thay vì chạy trong process cwd
  const withRepo = <T, F>(fn: (repo: string) => T, fallback: (err: string) => F): T | F => {
    let repo: string;
    try {
      repo = requireRepo(settings());
    } catch (e) {
      return fallback((e as Error).message);
    }
    return fn(repo);
  };
  const send = (channel: string, data: unknown) => ctx.win()?.webContents.send(channel, data);

  ipcMain.handle(IPC.APP_INFO, () => ({
    version: app.getVersion(),
    platform: process.platform,
    channels: Object.values(IPC),
  }));

  ipcMain.handle(IPC.SETTINGS_GET, () => settings());
  ipcMain.handle(IPC.SETTINGS_SET, (_e, s: AppSettings) => {
    const prev = settings();
    const saved = saveSettings(ctx.settingsFile, s);
    // session gắn với CLI/model — đổi brain thì bắt đầu session mới
    if (prev.orchestratorWorker !== saved.orchestratorWorker || prev.orchestratorModel !== saved.orchestratorModel) chatSession = undefined;
    return saved;
  });
  ipcMain.handle(IPC.MODELS_LIST, () => withRepo((repo) => modelsList(repo), () => modelsList()));
  ipcMain.handle(IPC.REPO_SET_ACTIVE, (_e, repo: string) => {
    const s = settings();
    if (!s.repos.includes(repo)) s.repos.push(repo);
    s.activeRepo = repo;
    return saveSettings(ctx.settingsFile, s);
  });
  ipcMain.handle(IPC.REPO_ADD, (_e, repo: string) => {
    const s = settings();
    if (typeof repo === 'string' && repo && !s.repos.includes(repo)) s.repos.push(repo);
    if (!s.activeRepo && s.repos[0]) s.activeRepo = s.repos[0];
    return saveSettings(ctx.settingsFile, s);
  });

  ipcMain.handle(IPC.FLEET_LIST, () => fleetSnapshot());
  ipcMain.handle(IPC.TASKS_LIST, () => withRepo(tasksSnapshot, () => []));
  ipcMain.handle(IPC.MATRIX_HTML, () => withRepo((repo) => policyMatrixHtml(repo, true), () => ''));
  ipcMain.handle(IPC.PROMOTE, (_e, p: { role: string; cli: string }) =>
    withRepo((repo) => promoteWorker(repo, p.role, p.cli), (detail) => ({ ok: false, detail })));
  ipcMain.handle(IPC.REVIEW_LIST, () => withRepo(mergeableTasks, () => []));
  ipcMain.handle(IPC.REVIEW_ACT, (_e, p: { taskId: string; action: 'merge' | 'reject' }) => {
    const r = withRepo((repo) => reviewMerge(repo, p.taskId, p.action), (detail) => ({ ok: false, detail }));
    ctx.notify('Orchestra Review & Merge', r.detail);
    return r;
  });

  ipcMain.handle(IPC.DISPATCH, (_e, p: DispatchPayload) => withRepo(async (repo) => {
    const s = settings();
    const r = await dispatchTracked(repo, {
      node: 'implement',
      role: 'coder',
      goal: p.goal,
      scope: p.scope ?? [],
      acceptance: p.acceptance ?? [],
      pin: p.worker && p.worker !== 'auto' ? p.worker : undefined,
      model: p.model || undefined,
      hooksEnabled: s.hooksEnabled,
      skillSync: s.skillSync,
      onEvent: (e) => send(EVENTS.DISPATCH_EVENT, { t: e.t, payload: e }),
    });
    ctx.notify('Orchestra Dispatch', `${r.result.ok ? '✓ OK' : '✗ FAILED'} — ${r.result.taskId}`);
    return r;
  }, (error) => ({ error })));

  ipcMain.handle(IPC.PIPELINE_RUN, (_e, p: { template: string; goal: string; scope: string[]; acceptance?: string[]; model?: string }) => withRepo(async (repo) => {
    const s = settings();
    const tplDir = s.templatesDir || protoAsset('templates') || path.join(ctx.protoDir, 'prototype', 'templates');
    const r = await runPipeline({
      repo,
      templatePath: path.join(tplDir, `${p.template ?? 'feature-dev'}.yml`),
      goal: p.goal,
      scope: p.scope ?? [],
      acceptance: p.acceptance ?? [],
      autoYes: s.autoApprovePlan,
      model: p.model || undefined,
      onLog: (line) => send(EVENTS.PIPELINE_LOG, line),
      // D1: approval qua modal của Desktop — không có stdin
      askUser: async (q) => {
        send(EVENTS.PIPELINE_LOG, `⏸ ${q}`);
        ctx.notify('Orchestra — chờ duyệt', q);
        const { dialog } = await import('electron');
        const r2 = await dialog.showMessageBox(ctx.win()!, {
          type: 'question',
          title: 'Orchestra — chờ duyệt',
          message: q,
          buttons: ['Tiếp tục', 'Dừng'],
          defaultId: 0,
        });
        return r2.response === 0 ? 'y' : 'n';
      },
    });
    ctx.notify('Orchestra Pipeline', `${r.ok ? '✓ OK' : '✗ FAILED'} ${r.runId} (merged=${r.merged})`);
    return { ok: r.ok, runId: r.runId, merged: r.merged, nodes: r.nodes };
  }, (error) => ({ ok: false, error })));

  ipcMain.handle(IPC.CHAT_EXCHANGE, async (_e, p: { text: string }) => {
    const notify = (m: unknown) => send(EVENTS.CHAT_MESSAGE, m);
    try {
      const r = await chatExchangeFlow(requireRepo(settings()), p.text, settings(), notify);
      return { session: r.session };
    } catch (err) {
      // báo lỗi thành message — không để bubble '…đang xử lý' treo
      const error = err instanceof Error ? err.message : String(err);
      notify({ kind: 'result', text: `✗ ${error}` });
      return { error };
    }
  });

  ipcMain.handle(IPC.INSTALL_WORKER, async (_e, id: string) => {
    const m = getManifest(id);
    if (!m) return { ok: false, detail: `unknown worker ${id}` };
    const r = await installWorker(m, (line) => send(EVENTS.INSTALL_LOG, line));
    ctx.notify('Orchestra Install', r.detail);
    return r;
  });
  ipcMain.handle(IPC.UNINSTALL_WORKER, (_e, id: string) => {
    const m = getManifest(id);
    return m ? uninstallWorker(m) : { ok: false, detail: 'unknown' };
  });

  ipcMain.handle(IPC.VAULT_SET, (_e, p: { provider: string; secret: string; baseUrl?: string }) => ({
    ok: vaultSet(p.provider, p.secret, p.baseUrl),
  }));
  ipcMain.handle(IPC.VAULT_DELETE, (_e, provider: string) => ({ ok: vaultDelete(provider) }));

  ipcMain.handle(IPC.CONFORMANCE_RUN, async (_e, id: string) => {
    const m = getManifest(id);
    if (!m) return { badge: 'fail', cases: [], detail: `unknown worker ${id}` };
    return withRepo((repo) => runConformance(m, { repo, withSmoke: true }), (detail) => ({ badge: 'fail', cases: [], detail }));
  });
  ipcMain.handle(IPC.SKILLS_SYNC, () => withRepo(syncSkills, (error) => ({ error })));
  // P-D3: update check — autoUpdater đã wired ở setupAutoUpdater; channel này trigger lại
  ipcMain.handle(IPC.UPDATE_CHECK, async () => {
    if (!app.isPackaged) return { status: 'skipped-dev' };
    try {
      const { autoUpdater } = await import('electron-updater');
      const r = await autoUpdater.checkForUpdates();
      return { status: r?.updateInfo?.version ? 'ok' : 'unknown', version: r?.updateInfo?.version };
    } catch (err) {
      return { status: 'error', detail: String(err).slice(0, 160) };
    }
  });
}

// chat loop dùng chatExchange (logic.ts) — giữ session trong module scope (1 user 1 session)
let chatSession: string | undefined;
async function chatExchangeFlow(
  repo: string,
  text: string,
  s: AppSettings,
  notify: (m: unknown) => void,
): Promise<{ session?: string }> {
  const { chatExchange } = await import('../../../extension/src/logic.js');
  const r = await chatExchange(repo, text, chatSession, {
    workerId: s.orchestratorWorker,
    model: s.orchestratorModel || undefined,
    notify: notify as never,
    hooksEnabled: s.hooksEnabled,
    skillSync: s.skillSync,
  });
  chatSession = r.session ?? chatSession;
  return r;
}

// giữ import MANIFESTS cho wizard (đếm worker chưa cài)
void MANIFESTS;
void checkStatus;

// ---------- P-D3: Terminal nhúng (@lydell/node-pty prebuilt N-API — không cần electron-rebuild) ----------
type PtyProc = {
  write: (d: string) => void;
  resize: (c: number, r: number) => void;
  kill: () => void;
  onData: (cb: (d: string) => void) => void;
  onExit: (cb: (e: { exitCode: number }) => void) => void;
  pid: number;
};
const terminals = new Map<string, PtyProc>();

export function killAllTerminals(): void {
  for (const [id, t] of terminals) {
    try {
      t.kill();
    } catch {
      /* đã chết */
    }
    terminals.delete(id);
  }
}

export function wireTerminals(ipcMain: IpcMain, ctx: IpcContext): void {
  const send = (channel: string, data: unknown) => ctx.win()?.webContents.send(channel, data);
  const activeRepo = (): string => {
    try {
      return requireRepo(loadSettings(ctx.settingsFile));
    } catch {
      return os.homedir(); // không có repo → home, không phải process cwd
    }
  };
  ipcMain.handle(IPC.TERMINAL_CREATE, (_e, p: { id: string; cwd?: string; cols?: number; rows?: number }) => {
    const term = terminals.get(p.id);
    if (term) return { ok: true, reused: true };
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
    const proc = ptySpawn(shell, [], {
      name: 'xterm',
      cols: p.cols ?? 100,
      rows: p.rows ?? 28,
      cwd: p.cwd && existsSync(p.cwd) ? p.cwd : activeRepo(),
      env: process.env as Record<string, string>,
    }) as unknown as PtyProc;
    terminals.set(p.id, proc);
    proc.onData((d) => send(EVENTS.TERMINAL_DATA, { id: p.id, data: d }));
    proc.onExit((e) => {
      send(EVENTS.TERMINAL_EXIT, { id: p.id, exitCode: e.exitCode });
      terminals.delete(p.id);
    });
    return { ok: true, pid: proc.pid };
  });
  ipcMain.handle(IPC.TERMINAL_INPUT, (_e, p: { id: string; data: string }) => {
    terminals.get(p.id)?.write(p.data);
    return { ok: true };
  });
  ipcMain.handle(IPC.TERMINAL_RESIZE, (_e, p: { id: string; cols: number; rows: number }) => {
    terminals.get(p.id)?.resize(p.cols, p.rows);
    return { ok: true };
  });
  ipcMain.handle(IPC.TERMINAL_KILL, (_e, id: string) => {
    terminals.get(id)?.kill();
    terminals.delete(id);
    return { ok: true };
  });
}

// ---------- P-D3: Auto-update (electron-updater) — wired,guarded: chỉ hoạt động khi có GitHub Releases ----------
export function setupAutoUpdater(getWin: () => BrowserWindow | null, notify: (t: string, b: string) => void): void {
  if (!app.isPackaged) {
    console.log('[updater] dev mode — skip auto-update');
    return;
  }
  import('electron-updater')
    .then(({ autoUpdater }) => {
      autoUpdater.autoDownload = true;
      autoUpdater.on('checking-for-update', () => console.log('[updater] checking…'));
      autoUpdater.on('update-available', (i) => notify('Orchestra — có bản mới', `v${i.version} đang tải…`));
      autoUpdater.on('update-not-available', () => console.log('[updater] đã là bản mới'));
      autoUpdater.on('error', (err) => console.log('[updater] lỗi (bình thường khi chưa publish GitHub Releases):', String(err).slice(0, 120)));
      autoUpdater.on('update-downloaded', (i) => {
        notify('Orchestra — bản mới đã tải', `v${i.version} — restart để cập nhật`);
        getWin()?.webContents.send(EVENTS.UPDATE_STATUS, { status: 'downloaded', version: i.version });
      });
      autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    })
    .catch(() => {});
}
void conformanceBadge;
