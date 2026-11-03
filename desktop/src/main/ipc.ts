// IPC wiring — bọc logic.ts (API duy nhất) vào ipcMain. Không viết logic mới ở đây.
import type { IpcMain, BrowserWindow, Notification } from 'electron';
import { app, shell, dialog } from 'electron';
import { spawn as ptySpawn } from '@lydell/node-pty';
import { IPC, EVENTS, requireRepo, type AppSettings, type DispatchPayload } from './contract.js';
import { loadSettings, saveSettings } from './settingsStore.js';
import {
  fleetSnapshot, tasksSnapshot, policyMatrixData, promoteWorker, mergeableTasks, reviewMerge,
  dispatchTracked, conformanceBadge, modelsList, BRAIN_TOOLS, brainSystemPrompt, brainToolExecutor,
} from '../../../extension/src/logic.js';
import { runBrainTurn, listBrainModels, type BrainCreds, type Msg } from '../../../prototype/src/brain.js';
import { runPipeline } from '../../../prototype/src/orchestrator.js';
import { syncSkills } from '../../../prototype/src/skillsync.js';
import { runConformance } from '../../../prototype/src/conformance.js';
import { installWorker, uninstallWorker, checkStatus } from '../../../prototype/src/registry.js';
import { getManifest, MANIFESTS } from '../../../prototype/src/manifests.js';
import { protoAsset } from '../../../prototype/src/paths.js';
import { createProviderStore, authHeaders, isOAuth, type ProviderConfig } from '../../../prototype/src/router/providers.js';
import { anthropicAuthUrl, exchangeAnthropic, oauthStatus, openaiLogin, pkce } from '../../../prototype/src/router/oauth.js';
import { startRouter, type RouterHandle } from '../../../prototype/src/router/server.js';
import type { RouterInfo } from '../../../prototype/src/types.js';
import { parseChatSession, listChatSessions, sessionFile, addRepoDir } from './chatSessions.js';
import { t, setLocale, messages } from '../../../prototype/src/i18n/index.js';
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
const oauthOf = (p: ProviderConfig) => oauthStatus(store.getKey(p.id));
/** provider + needsLogin (oauth chưa đăng nhập / refresh chết) cho routerModelOk */
const providersWithLogin = () =>
  store.listProviders().map((p) => (isOAuth(p.kind) && ['none', 'needsLogin'].includes(oauthOf(p).oauthStatus) ? { ...p, needsLogin: true } : p));
/** chưa có provider bật nào → undefined: CLI dùng auth riêng như trước (không phá máy mới cài) */
const routerInfo = (): RouterInfo | undefined => {
  const c = routerCreds();
  const providers = providersWithLogin();
  return c && providers.some((p) => p.enabled) ? { baseUrl: c.baseUrl, token: c.apiKey, defaultModel: routerDefault(), providers } : undefined;
};
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface IpcContext {
  win: () => BrowserWindow | null;
  settingsFile: string;
  notify: (title: string, body: string) => void;
  protoDir: string;
  /** settings đổi language → main dựng lại phần tĩnh (tray menu) */
  onLocaleChange?: () => void;
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
    ctx.notify(t('desktop.approval.title'), q);
    const { dialog } = await import('electron');
    const r = await dialog.showMessageBox(ctx.win()!, { type: 'question', title: t('desktop.approval.title'), message: q, buttons, defaultId: 0, cancelId: 1 });
    return r.response === 0;
  };
  const askContinue = async (q: string) => ((await ask(q, [t('desktop.approval.continue'), t('desktop.approval.stop')])) ? 'y' : 'n');

  ipcMain.handle(IPC.APP_INFO, () => ({
    version: app.getVersion(),
    platform: process.platform,
    channels: Object.values(IPC),
  }));

  ipcMain.handle(IPC.SETTINGS_GET, () => settings());
  // renderer chỉ cần desktop.* — lỗi từ main đã dịch sẵn trước khi gửi
  ipcMain.handle(IPC.I18N_GET, () => ({ locale: settings().language, dict: messages('desktop.') }));
  ipcMain.handle(IPC.SETTINGS_SET, (_e, s: AppSettings) => {
    const prev = settings();
    const saved = saveSettings(ctx.settingsFile, s);
    if (prev.brainModel !== saved.brainModel) resetChat(); // đổi model brain → hội thoại mới
    if (prev.language !== saved.language) {
      setLocale(saved.language);
      ctx.onLocaleChange?.();
    }
    return saved;
  });
  ipcMain.handle(IPC.MODELS_LIST, async () => {
    const c = routerCreds();
    const { models } = c ? await listBrainModels(c) : { models: [] as string[] };
    return modelsList(models, providersWithLogin());
  });

  // ---- R2a Providers: key chỉ đi vào vault, KHÔNG bao giờ trả về renderer ----
  ipcMain.handle(IPC.PROVIDERS_LIST, () =>
    store.listProviders().map((p) => ({
      id: p.id, kind: p.kind, baseUrl: p.baseUrl, formats: p.formats, enabled: p.enabled, hasKey: !!store.getKey(p.id),
      models: p.models ?? [], riskAcknowledged: !!p.riskAcknowledged, ...(isOAuth(p.kind) ? oauthOf(p) : {}),
    })));
  // R3 OAuth: token chỉ vào vault; anthropic = user dán code#state, openai = callback 127.0.0.1:1455
  const oauthProvider = (id: unknown) => {
    const p = store.listProviders().find((x) => x.id === id);
    if (!p || !isOAuth(p.kind)) throw new Error(t('desktop.err.noOAuthProvider', { id: String(id) }));
    if (!p.riskAcknowledged) throw new Error(t('desktop.err.riskNotAck', { id: p.id }));
    return p;
  };
  ipcMain.handle(IPC.OAUTH_START, async (_e, a: { id: string }) => {
    try {
      const p = oauthProvider(a?.id);
      if (p.kind === 'oauth-anthropic') {
        const k = pkce();
        oauthPending.set(p.id, k);
        const authUrl = anthropicAuthUrl(k);
        await shell.openExternal(authUrl);
        return { ok: true, authUrl };
      }
      const c = await openaiLogin({ open: (url) => shell.openExternal(url) });
      store.setKey(p.id, JSON.stringify(c));
      return { ok: true, accountId: c.accountId };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });
  ipcMain.handle(IPC.OAUTH_FINISH, async (_e, a: { id: string; code: string }) => {
    try {
      const p = oauthProvider(a?.id);
      const k = oauthPending.get(p.id);
      if (!k) throw new Error(t('desktop.err.loginNotStarted'));
      const c = await exchangeAnthropic(String(a?.code ?? ''), k);
      oauthPending.delete(p.id);
      store.setKey(p.id, JSON.stringify(c));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });
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
    if (!p) return { ok: false, count: 0, error: t('desktop.err.noProvider', { id }) };
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
  ipcMain.handle(IPC.REPO_SET_ACTIVE, (_e, repo: string) => {
    const s = settings();
    if (!s.repos.includes(repo)) s.repos.push(repo);
    s.activeRepo = repo;
    return saveSettings(ctx.settingsFile, s);
  });
  // path do main chọn qua dialog — renderer không gửi path
  ipcMain.handle(IPC.REPO_ADD, async () => {
    const w = ctx.win();
    const opts = { properties: ['openDirectory' as const] };
    const pick = await (w ? dialog.showOpenDialog(w, opts) : dialog.showOpenDialog(opts));
    if (pick.canceled || !pick.filePaths[0]) return { ok: false };
    const s = settings();
    const r = addRepoDir(s.repos, pick.filePaths[0]);
    if (!r.ok) return r;
    saveSettings(ctx.settingsFile, { ...s, repos: r.repos, activeRepo: s.activeRepo || r.repo });
    return { ok: true, repo: r.repo };
  });

  ipcMain.handle(IPC.FLEET_LIST, () => fleetSnapshot());
  ipcMain.handle(IPC.TASKS_LIST, (_e, p?: { limit?: number }) => withRepo((repo) => tasksSnapshot(repo, p?.limit), () => []));
  ipcMain.handle(IPC.MATRIX_DATA, () => withRepo((repo) => policyMatrixData(repo), () => null));
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
        return askContinue(q);
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
    if (typeof p?.text !== 'string' || !p.text.trim()) return fail(t('desktop.chat.err.empty'));
    if (chatBusy) return fail(t('desktop.chat.err.busy'));
    const creds = routerCreds();
    if (!creds) return fail(t('desktop.err.routerDown'));
    if (!settings().brainModel) return fail(t('desktop.chat.err.noModel'));
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
      // repo cố định theo session: hội thoại mới chưa có repo → lấy activeRepo lúc gửi lượt đầu
      const repo = requireRepo(conv.repo ? { activeRepo: conv.repo, repos: [] } : s);
      conv.repo = repo;
      const r = await runBrainTurn({
        ...creds,
        history: conv.history,
        userText: p.text,
        model: s.brainModel,
        system: brainSystemPrompt(repo),
        tools: BRAIN_TOOLS,
        signal: ac.signal,
        execTool: brainToolExecutor(repo, {
          approve: (q) => ask(q, [t('desktop.approval.approve'), t('desktop.approval.reject')]),
          askUser: askContinue,
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
      notify({ kind: 'orch', text: r.text || t('desktop.chat.noReply') });
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
  // session = 1 file jsonl; mở lại → lượt sau append tiếp vào file đó
  ipcMain.handle(IPC.CHAT_SESSIONS, () =>
    listChatSessions(settings().repos).map((x) => ({ ...x, active: x.id === chat.startedAt && x.repo === chat.repo })));
  ipcMain.handle(IPC.CHAT_OPEN, (_e, p: { repo: string; id: string }) => {
    if (chatBusy) return { ok: false, error: t('desktop.chat.err.busyOpen') };
    const s = settings();
    const sf = sessionFile(s.repos, p?.repo, p?.id);
    if ('error' in sf) return { ok: false, error: sf.error };
    if (!existsSync(sf.file)) return { ok: false, error: t('desktop.chat.err.noSession', { id: p.id }) };
    const { history, messages } = parseChatSession(readFileSync(sf.file, 'utf8'));
    chat = { history, startedAt: p.id, repo: p.repo };
    saveSettings(ctx.settingsFile, { ...s, activeRepo: p.repo }); // Dashboard/Settings theo session
    return { ok: true, messages, repo: p.repo };
  });
  ipcMain.handle(IPC.CHAT_NEW, (_e, p?: { repo?: string }) => {
    if (chatBusy) return { ok: false, error: t('desktop.chat.err.busyOpen') };
    const s = settings();
    const repo = p?.repo ?? s.activeRepo;
    if (p?.repo !== undefined && !s.repos.includes(p.repo)) return { ok: false, error: t('desktop.repo.notAllowed', { repo: String(repo) }) };
    resetChat();
    chat.repo = repo;
    if (repo !== s.activeRepo) saveSettings(ctx.settingsFile, { ...s, activeRepo: repo });
    return { ok: true, repo };
  });
  ipcMain.handle(IPC.BRAIN_MODELS, async () => {
    const creds = routerCreds();
    return creds ? listBrainModels(creds) : { models: [], error: t('desktop.err.routerDown') };
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

// PKCE đang chờ user dán code (anthropic) — theo provider id, chỉ trong RAM
const oauthPending = new Map<string, { verifier: string; state: string }>();

// hội thoại brain — in-memory theo phiên app (1 user 1 hội thoại); reset khi đổi model / chat mới
// repo: cố định cho cả session ('' = chưa gửi lượt nào → lấy activeRepo lúc gửi)
let chat: { history: Msg[]; startedAt: string; repo: string } = { history: [], startedAt: '', repo: '' };
let chatBusy = false;
let chatAbort: AbortController | null = null; // lượt đang chạy — chat:cancel abort
const resetChat = () => {
  chat = { history: [], startedAt: '', repo: '' };
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
    console.log('[chat] persist failed:', err instanceof Error ? err.message : err);
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
      autoUpdater.on('update-available', (i) => notify(t('desktop.notify.updateAvailable'), t('desktop.notify.updateDownloading', { version: i.version })));
      autoUpdater.on('update-not-available', () => console.log('[updater] up to date'));
      autoUpdater.on('error', (err) => console.log('[updater] error (normal before GitHub Releases are published):', String(err).slice(0, 120)));
      autoUpdater.on('update-downloaded', (i) => {
        notify(t('desktop.notify.updateDownloaded'), t('desktop.notify.restartToUpdate', { version: i.version }));
        getWin()?.webContents.send(EVENTS.UPDATE_STATUS, { status: 'downloaded', version: i.version });
      });
      autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    })
    .catch(() => {});
}
void conformanceBadge;
