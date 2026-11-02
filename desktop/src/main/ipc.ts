// IPC wiring — bọc logic.ts (API duy nhất) vào ipcMain. Không viết logic mới ở đây.
import type { IpcMain, BrowserWindow, Notification } from 'electron';
import { app } from 'electron';
import { spawn as ptySpawn } from '@lydell/node-pty';
import { IPC, EVENTS, requireRepo, type AppSettings, type DispatchPayload } from './contract.js';
import { loadSettings, saveSettings } from './settingsStore.js';
import {
  fleetSnapshot, tasksSnapshot, policyMatrixHtml, promoteWorker, mergeableTasks, reviewMerge,
  dispatchTracked, conformanceBadge, modelsList, BRAIN_TOOLS, brainSystemPrompt, brainToolExecutor,
} from '../../../extension/src/logic.js';
import { runBrainTurn, listBrainModels, type BrainCreds, type Msg } from '../../../prototype/src/brain.js';
import { runPipeline } from '../../../prototype/src/orchestrator.js';
import { syncSkills } from '../../../prototype/src/skillsync.js';
import { runConformance } from '../../../prototype/src/conformance.js';
import { installWorker, uninstallWorker, checkStatus } from '../../../prototype/src/registry.js';
import { getManifest, MANIFESTS } from '../../../prototype/src/manifests.js';
import { protoAsset } from '../../../prototype/src/paths.js';
import { createProviderStore, authHeaders, type ProviderConfig } from '../../../prototype/src/router/providers.js';
import { startRouter, type RouterHandle } from '../../../prototype/src/router/server.js';
import type { RouterInfo } from '../../../prototype/src/types.js';
import { fromClaudeSettings, fromCodexConfig } from './importCli.js';
import path from 'node:path';
import os from 'node:os';
import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';

// R2a: 1 provider store + 1 router cho cả app — brain, dispatch, pipeline đều đi qua đây
const store = createProviderStore();
let router: RouterHandle | null = null;
let routerSettingsFile = '';
const routerDefault = () => {
  const s = loadSettings(routerSettingsFile);
  return s.routerDefaultModel || s.brainModel || undefined;
};
export async function startOrchestraRouter(settingsFile: string): Promise<void> {
  routerSettingsFile = settingsFile;
  router = await startRouter({ store, defaultModel: routerDefault, onLog: (l) => console.log('[router]', l) });
  console.log(`[router] 127.0.0.1:${router.port}`);
}
export const stopOrchestraRouter = (): Promise<void> => router?.close() ?? Promise.resolve();
const routerCreds = (): BrainCreds | null => (router ? { baseUrl: `http://127.0.0.1:${router.port}`, apiKey: router.token } : null);
/** chưa có provider bật nào → undefined: CLI dùng auth riêng như trước (không phá máy mới cài) */
const routerInfo = (): RouterInfo | undefined => {
  const c = routerCreds();
  const providers = store.listProviders();
  return c && providers.some((p) => p.enabled) ? { baseUrl: c.baseUrl, token: c.apiKey, defaultModel: routerDefault(), providers } : undefined;
};
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
  // hỏi user qua modal Electron — pipeline plan approval + tool T2 của brain
  const ask = async (q: string, buttons: [string, string]): Promise<boolean> => {
    ctx.notify('Orchestra — chờ duyệt', q);
    const { dialog } = await import('electron');
    const r = await dialog.showMessageBox(ctx.win()!, { type: 'question', title: 'Orchestra — chờ duyệt', message: q, buttons, defaultId: 0, cancelId: 1 });
    return r.response === 0;
  };

  ipcMain.handle(IPC.APP_INFO, () => ({
    version: app.getVersion(),
    platform: process.platform,
    channels: Object.values(IPC),
  }));

  ipcMain.handle(IPC.SETTINGS_GET, () => settings());
  ipcMain.handle(IPC.SETTINGS_SET, (_e, s: AppSettings) => {
    const prev = settings();
    const saved = saveSettings(ctx.settingsFile, s);
    if (prev.brainModel !== saved.brainModel) resetChat(); // đổi model brain → hội thoại mới
    return saved;
  });
  ipcMain.handle(IPC.MODELS_LIST, async () => {
    const c = routerCreds();
    const { models } = c ? await listBrainModels(c) : { models: [] as string[] };
    return modelsList(models, store.listProviders());
  });

  // ---- R2a Providers: key chỉ đi vào vault, KHÔNG bao giờ trả về renderer ----
  ipcMain.handle(IPC.PROVIDERS_LIST, () =>
    store.listProviders().map((p) => ({ id: p.id, kind: p.kind, baseUrl: p.baseUrl, formats: p.formats, enabled: p.enabled, hasKey: !!store.getKey(p.id) })));
  ipcMain.handle(IPC.PROVIDERS_SAVE, (_e, p: { cfg: Partial<ProviderConfig>; key?: string }) => {
    try {
      const key = typeof p?.key === 'string' && p.key.trim() ? p.key.trim() : undefined; // trống = giữ key cũ
      return { ok: true, id: store.saveProvider(p?.cfg ?? {}, key).id };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });
  ipcMain.handle(IPC.PROVIDERS_DELETE, (_e, id: string) => ({ ok: store.deleteProvider(String(id)) }));
  // gọi thẳng upstream đúng như router làm (header auth giống hệt) — bỏ qua cache 5' của router để thấy lỗi thật
  ipcMain.handle(IPC.PROVIDERS_TEST, async (_e, id: string) => {
    const p = store.listProviders().find((x) => x.id === id);
    if (!p) return { ok: false, count: 0, error: `không có provider ${id}` };
    if (p.models) return { ok: true, count: p.models.length };
    try {
      const r = await fetch(`${p.baseUrl}/v1/models`, { headers: authHeaders(p.kind, store.getKey(p.id)), signal: AbortSignal.timeout(15_000) });
      if (!r.ok) return { ok: false, count: 0, error: `HTTP ${r.status}` };
      const data = ((await r.json()) as { data?: unknown[] }).data;
      return { ok: true, count: Array.isArray(data) ? data.length : 0 };
    } catch (err) {
      return { ok: false, count: 0, error: errMsg(err) };
    }
  });
  ipcMain.handle(IPC.ROUTER_STATUS, () => ({ running: !!router, port: router?.port ?? null, providers: store.listProviders().length }));
  // đọc config CLI của user trong main; trả id + lý do bỏ qua, không trả key
  ipcMain.handle(IPC.PROVIDERS_IMPORT, () => {
    const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : null);
    const imported: string[] = [];
    const skipped: string[] = [];
    const cl = read(path.join(os.homedir(), '.claude', 'settings.json'));
    const cx = read(path.join(os.homedir(), '.codex', 'config.toml'));
    const found = [
      cl === null ? { skip: 'claude: không có ~/.claude/settings.json' } : fromClaudeSettings(cl),
      cx === null ? { skip: 'codex: không có ~/.codex/config.toml' } : fromCodexConfig(cx, process.env),
    ];
    for (const f of found) {
      if ('skip' in f) skipped.push(f.skip);
      else {
        try {
          imported.push(store.saveProvider(f.cfg, f.key).id);
        } catch (err) {
          skipped.push(`${f.cfg.id}: ${errMsg(err)}`);
        }
      }
    }
    return { imported, skipped };
  });
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
      router: routerInfo(),
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
      router: routerInfo(),
      onLog: (line) => send(EVENTS.PIPELINE_LOG, line),
      // D1: approval qua modal của Desktop — không có stdin
      askUser: async (q) => {
        send(EVENTS.PIPELINE_LOG, `⏸ ${q}`);
        return (await ask(q, ['Tiếp tục', 'Dừng'])) ? 'y' : 'n';
      },
    });
    ctx.notify('Orchestra Pipeline', `${r.ok ? '✓ OK' : '✗ FAILED'} ${r.runId} (merged=${r.merged})`);
    return { ok: r.ok, runId: r.runId, merged: r.merged, nodes: r.nodes };
  }, (error) => ({ ok: false, error })));

  // M1: user chỉ nói chuyện với Orchestra (brain = LLM API + tool); CLI chỉ là worker qua fleet_* tool
  ipcMain.handle(IPC.CHAT_EXCHANGE, async (_e, p: { text: string }) => {
    const notify = (m: unknown) => send(EVENTS.CHAT_MESSAGE, m);
    const fail = (error: string) => {
      // báo lỗi thành message — không để bubble '…đang xử lý' treo
      notify({ kind: 'result', text: `✗ ${error}` });
      return { error };
    };
    if (typeof p?.text !== 'string' || !p.text.trim()) return fail('tin nhắn rỗng');
    if (chatBusy) return fail('Orchestra đang xử lý lượt trước — chờ xong rồi nhắn tiếp');
    const creds = routerCreds();
    if (!creds) return fail('Orchestra router chưa chạy');
    if (!settings().brainModel) return fail('chọn Model Orchestra ở composer');
    chatBusy = true;
    const ac = new AbortController();
    chatAbort = ac;
    const conv = chat; // reset giữa lượt → kết quả lượt này không ghi đè hội thoại mới
    // tiến độ worker → chat: tool_use/message luôn gửi, dòng khác tối đa 1 lần / 2s
    let lastProgress = 0;
    const progress = (line: string) => {
      send(EVENTS.PIPELINE_LOG, line);
      const now = Date.now();
      if (!/^\[(tool_use|message)\]/.test(line) && now - lastProgress < 2000) return;
      lastProgress = now;
      send(EVENTS.CHAT_STEP, { kind: 'progress', text: line.replace(/\s+/g, ' ').slice(0, 160) });
    };
    try {
      const s = settings();
      const repo = requireRepo(s);
      const r = await runBrainTurn({
        ...creds,
        history: conv.history,
        userText: p.text,
        model: s.brainModel,
        system: brainSystemPrompt(repo),
        tools: BRAIN_TOOLS,
        signal: ac.signal,
        execTool: brainToolExecutor(repo, {
          approve: (q) => ask(q, ['Đồng ý', 'Từ chối']),
          askUser: async (q) => ((await ask(q, ['Tiếp tục', 'Dừng'])) ? 'y' : 'n'),
          hooksEnabled: s.hooksEnabled,
          skillSync: s.skillSync,
          templatesDir: s.templatesDir || protoAsset('templates') || path.join(ctx.protoDir, 'prototype', 'templates'),
          autoApprovePlan: s.autoApprovePlan,
          onLog: progress,
          signal: ac.signal,
          router: routerInfo(),
        }),
        onStep: (step) => send(EVENTS.CHAT_STEP, step),
      });
      persistChat(repo, conv, r.history.slice(conv.history.length));
      conv.history = r.history;
      notify({ kind: 'orch', text: r.text || '(không có phản hồi)' });
      return { ok: true };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    } finally {
      chatBusy = false;
      chatAbort = null;
    }
  });
  ipcMain.handle(IPC.CHAT_CANCEL, () => {
    chatAbort?.abort();
    return { ok: !!chatAbort };
  });
  ipcMain.handle(IPC.CHAT_RESET, () => {
    resetChat();
    return { ok: true };
  });
  ipcMain.handle(IPC.BRAIN_MODELS, async () => {
    const creds = routerCreds();
    return creds ? listBrainModels(creds) : { models: [], error: 'Orchestra router chưa chạy' };
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

// hội thoại brain — in-memory theo phiên app (1 user 1 hội thoại); reset khi đổi model / chat mới
let chat: { history: Msg[]; startedAt: string } = { history: [], startedAt: '' };
let chatBusy = false;
let chatAbort: AbortController | null = null; // lượt đang chạy — chat:cancel abort
const resetChat = () => {
  chat = { history: [], startedAt: '' };
};

/** append message mới vào <repo>/.orchestra/chat/<startedAt>.jsonl — chỉ nội dung hội thoại, không có key */
function persistChat(repo: string, conv: typeof chat, msgs: Msg[]): void {
  try {
    conv.startedAt ||= new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(repo, '.orchestra', 'chat');
    mkdirSync(dir, { recursive: true });
    const at = new Date().toISOString();
    appendFileSync(path.join(dir, `${conv.startedAt}.jsonl`), msgs.map((m) => JSON.stringify({ at, ...m })).join('\n') + '\n', 'utf8');
  } catch (err) {
    console.log('[chat] persist lỗi:', err instanceof Error ? err.message : err);
  }
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
