// IPC wiring — bọc logic.ts (API duy nhất) vào ipcMain. Không viết logic mới ở đây.
import type { IpcMain, BrowserWindow, Notification } from 'electron';
import { app, shell, dialog } from 'electron';
import { spawn as ptySpawn } from '@lydell/node-pty';
import { IPC, EVENTS, requireRepo, type AppSettings, type DispatchPayload } from './contract.js';
import { loadSettings, saveSettings } from './settingsStore.js';
import {
  fleetSnapshotAsync, tasksSnapshot, policyMatrixData, promoteWorker, mergeableTasks, reviewMerge,
  dispatchTracked, conformanceBadge, modelsList, brainTools, brainSystemPrompt, projectToolExecutor, repoRefs, findRepos,
} from '../../../extension/src/logic.js';
import { runBrainTurn, listBrainModels, callBrainText, type BrainCreds, type Msg } from '../../../prototype/src/brain.js';
import { loadMemory, setMemoryText, reflectMemory, writeMemoryOps, transcriptOf, summarizeOps, BUDGET, type CallModel } from '../../../prototype/src/agentMemory.js';
import { chatDir, ensureWorkspace } from '../../../prototype/src/home.js';
import { loadKB } from '../../../prototype/src/memory.js';
import { runPipeline } from '../../../prototype/src/orchestrator.js';
import {
  listSkills, availableSkills, saveSkill, removeSkill, previewGithub, previewLocal, installSkills, checkUpdate, updateSkill, cancelPreview, type SkillScope,
} from '../../../prototype/src/skills.js';
import { runConformance } from '../../../prototype/src/conformance.js';
import { installWorker, uninstallWorker } from '../../../prototype/src/registry.js';
import { createFleetCache } from './fleetCache.js';
import { getManifest, MANIFESTS } from '../../../prototype/src/manifests.js';
import { protoAsset } from '../../../prototype/src/paths.js';
import { createProviderStore, authHeaders, isOAuth, type ProviderConfig } from '../../../prototype/src/router/providers.js';
import { anthropicAuthUrl, exchangeAnthropic, oauthStatus, openaiLogin, pkce } from '../../../prototype/src/router/oauth.js';
import { startRouter, type RouterHandle } from '../../../prototype/src/router/server.js';
import type { RouterInfo } from '../../../prototype/src/types.js';
import { parseChatSession, chatSessionsView, sessionFile, findProject, addRepoDir, newProjectId, deleteProjectData } from './chatSessions.js';
import { t, setLocale, messages } from '../../../prototype/src/i18n/index.js';
import { needsApproval, type ApprovalKind } from '../../../prototype/src/permissions.js';
import { createApprovalBroker, type ApprovalBroker, type ApprovalRequest } from './approvals.js';
import path from 'node:path';
import os from 'node:os';
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';

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
  // làm ấm cache /v1/models của router (upstream ~3s) — models:list/brain:models đầu tiên không phải chờ
  void listBrainModels(routerCreds()!);
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
  /** có approval mới — main hiện notification khi cửa sổ không focus */
  notifyApproval?: (r: ApprovalRequest) => void;
}

let broker: ApprovalBroker | null = null;
/** toast action orchestra://approval/<id>/… (main.ts) — id phải đang chờ */
export const respondApproval = (id: string, approve: boolean): boolean => broker?.respond(id, approve) ?? false;
/** cửa sổ đóng → không ai trả lời được: từ chối mọi approval đang chờ */
export const cancelApprovals = (): void => broker?.cancelAll();

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
  reflectSettingsFile = ctx.settingsFile;
  reflectStep = (text) => send(EVENTS.CHAT_STEP, { kind: 'memory', text });
  // hỏi user bằng approval card trong chat (không modal) — pipeline plan approval + tool T2 của brain + repo_attach
  broker = createApprovalBroker({
    onRequest: (r) => {
      send(EVENTS.APPROVAL_REQUEST, r);
      ctx.notifyApproval?.(r);
    },
    onResolved: (id, approve) => send(EVENTS.APPROVAL_RESOLVED, { id, approve }),
  });
  const approvals = broker;
  const ask = (question: string, kind: ApprovalKind = 'risk', signal?: AbortSignal) =>
    approvals.request({ question, kind, approveLabel: t('desktop.approval.approve'), rejectLabel: t('desktop.approval.reject'), signal });
  const askContinue = async (q: string, signal?: AbortSignal) =>
    ((await approvals.request({ question: q, kind: 'plan', approveLabel: t('desktop.approval.continue'), rejectLabel: t('desktop.approval.stop'), signal })) ? 'y' : 'n');
  ipcMain.handle(IPC.APPROVAL_RESPOND, (_e, p: { id: string; approve: boolean }) => ({ ok: approvals.respond(p?.id, p?.approve) }));
  ipcMain.handle(IPC.APPROVAL_PENDING, () => approvals.pending());

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

  // ---- Projects: nhóm repo (microservices) + session + memory riêng; xoá project KHÔNG đụng repo ----
  const projectOf = (id: unknown) => {
    const f = findProject(settings().projects, id);
    if ('error' in f) throw new Error(f.error);
    if (!f.project) throw new Error(t('desktop.project.notFound', { id: String(id) }));
    return f.project;
  };
  const projectName = (v: unknown) => {
    const n = typeof v === 'string' ? v.trim() : '';
    if (!n || n.length > 80) throw new Error(t('desktop.project.badName'));
    return n;
  };
  // sửa project id rồi lưu; activeRepo được validateSettings kéo về repo còn tồn tại
  const updateProject = (id: unknown, fn: (p: { id: string; name: string; repos: string[] }) => void) => {
    const s = settings();
    const p = projectOf(id);
    fn(p);
    return saveSettings(ctx.settingsFile, { ...s, projects: s.projects.map((x) => (x.id === p.id ? p : x)) }).projects.find((x) => x.id === p.id)!;
  };
  const guard = async <T>(fn: () => T | Promise<T>) => {
    try {
      return { ok: true, ...(await fn()) };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  };
  ipcMain.handle(IPC.PROJECTS_LIST, () => settings().projects);
  ipcMain.handle(IPC.PROJECT_GET, (_e, p: { id: string }) => guard(() => {
    const project = projectOf(p?.id);
    const refs = repoRefs(project.repos);
    return { project, repos: refs.map((r, i) => ({ ...r, repo: project.repos[i]!, exists: existsSync(r.path), kb: existsSync(r.path) ? loadKB(r.path).map((e) => ({ id: e.id, title: e.title, scope: e.scope, source: e.source, pinned: !!e.pinned })) : [] })) };
  }));
  ipcMain.handle(IPC.PROJECT_CREATE, (_e, p: { name: string }) => guard(() => {
    const s = settings();
    const project = { id: newProjectId(projectName(p?.name), s.projects.map((x) => x.id)), name: projectName(p?.name), repos: [] };
    saveSettings(ctx.settingsFile, { ...s, projects: [...s.projects, project] });
    return { project };
  }));
  // path do main chọn qua dialog — renderer không gửi path
  ipcMain.handle(IPC.PROJECT_ADD_REPO, (_e, p: { id: string }) => guard(async () => {
    projectOf(p?.id);
    const w = ctx.win();
    const opts = { properties: ['openDirectory' as const] };
    const pick = await (w ? dialog.showOpenDialog(w, opts) : dialog.showOpenDialog(opts));
    if (pick.canceled || !pick.filePaths[0]) return { canceled: true };
    const r = addRepoDir(projectOf(p.id).repos, pick.filePaths[0]);
    if (!r.ok) throw new Error(r.error);
    return { repo: r.repo, project: updateProject(p.id, (x) => { x.repos = r.repos; }) };
  }));
  ipcMain.handle(IPC.PROJECT_REMOVE_REPO, (_e, p: { id: string; repo: string }) => guard(() =>
    ({ project: updateProject(p?.id, (x) => { x.repos = x.repos.filter((r) => r !== p.repo); }) })));
  ipcMain.handle(IPC.PROJECT_RENAME, (_e, p: { id: string; name: string }) => guard(() =>
    ({ project: updateProject(p?.id, (x) => { x.name = projectName(p.name); }) })));
  ipcMain.handle(IPC.PROJECT_DELETE, (_e, p: { id: string }) => guard(() => {
    const project = projectOf(p?.id);
    if (chat.projectId === project.id) {
      if (chatBusy) throw new Error(t('desktop.chat.err.busyOpen'));
      resetChat();
    }
    const s = settings();
    saveSettings(ctx.settingsFile, { ...s, projects: s.projects.filter((x) => x.id !== project.id) });
    deleteProjectData(project.id); // chỉ ~/.orchestra/projects/<id>
    return {};
  }));
  ipcMain.handle(IPC.MEMORY_GET, (_e, p: { projectId: string | null }) => guard(() => {
    const id = p?.projectId ? projectOf(p.projectId).id : null;
    const text = loadMemory(id).trimEnd();
    return { text, used: text.length, budget: BUDGET[id ? 'project' : 'global'] };
  }));
  ipcMain.handle(IPC.MEMORY_SET, (_e, p: { projectId: string | null; text: string }) => guard(() => {
    const id = p?.projectId ? projectOf(p.projectId).id : null;
    if (typeof p?.text !== 'string') throw new Error(t('desktop.memory.badText'));
    const r = setMemoryText(id, p.text);
    if (!r.ok) throw new Error(r.error);
    return { text: r.text, used: r.used, budget: r.budget };
  }));

  // fleet: probe CLI (where/--version/login status) async + cache — fleet:list không spawn gì khi đã có cache
  const fleet = createFleetCache(fleetSnapshotAsync, {
    onChange: (v) => send(EVENTS.FLEET_CHANGED, v),
    onError: (err) => console.log('[fleet] probe failed:', errMsg(err)),
  });
  fleet.refresh().catch((err) => console.log('[fleet] startup probe failed:', errMsg(err)));
  const refreshFleet = () => void fleet.refresh().catch((err) => console.log('[fleet] probe failed:', errMsg(err)));
  ipcMain.handle(IPC.FLEET_LIST, () => fleet.get());
  ipcMain.handle(IPC.FLEET_REFRESH, () => fleet.refresh());
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
      autoYes: s.autoApprovePlan || needsApproval(s.permissionMode, 'plan_approval') === 'allow',
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
      // project cố định theo session (null = chat ngoài project: chỉ global memory, không repo tool)
      const project = conv.projectId ? projectOf(conv.projectId) : null;
      const refs = project ? repoRefs(project.repos) : null;
      // chat ngoài project vẫn gọi worker được → repo scratch; git lỗi → chỉ còn memory tool
      let ws: { name: string; path: string } | undefined;
      if (!project) {
        try { ws = { name: 'workspace', path: ensureWorkspace() }; } catch (err) { console.log('[chat] workspace:', err instanceof Error ? err.message : err); }
      }
      // ngoài project: repo đã attach (giữ cả session) + workspace; mảng sống → repo_attach thêm được giữa lượt
      const toolRefs = refs ?? (ws ? [ws, ...repoRefs(conv.attached).map((r) => ({ ...r, name: r.name === 'workspace' ? 'workspace-2' : r.name }))] : null);
      const attach = async (raw: string) => {
        const dir = path.resolve(raw);
        if (!existsSync(dir)) return { ok: false, content: `no such folder: ${dir}` };
        const found = findRepos(dir);
        if (!found.length) return { ok: false, content: `no git repo found in ${dir} (searched 3 levels)` };
        const fresh = found.filter((f) => !conv.attached.includes(f));
        if (fresh.length) {
          const q = t('desktop.chat.attachAsk', { path: dir, n: fresh.length, list: fresh.slice(0, 12).map((f) => path.relative(dir, f) || '.').join(', ') + (fresh.length > 12 ? ', …' : '') });
          if (needsApproval(s.permissionMode, 'repo_attach') !== 'allow' && !(await ask(q, 'repo', ac.signal))) return { ok: false, content: 'user declined' };
          conv.attached.push(...fresh);
          try {
            conv.startedAt ||= new Date().toISOString().replace(/[:.]/g, '-');
            mkdirSync(chatDir(conv.projectId), { recursive: true });
            writeFileSync(attachedFile(conv), JSON.stringify(conv.attached), 'utf8');
          } catch (err) { console.log('[chat] attach persist:', err instanceof Error ? err.message : err); }
        }
        if (toolRefs) toolRefs.splice(1, toolRefs.length - 1, ...repoRefs(conv.attached).map((r) => ({ ...r, name: r.name === 'workspace' ? 'workspace-2' : r.name })));
        const names = (toolRefs ?? []).filter((r) => found.includes(r.path)).map((r) => `${r.name}: ${r.path}`);
        return { ok: true, content: `attached ${names.length} repo(s) — pass repo=<name>:\n${names.join('\n')}` };
      };
      const callModel = modelCaller(creds, s.brainModel);
      const r = await runBrainTurn({
        ...creds,
        history: conv.history,
        userText: p.text,
        model: s.brainModel,
        system: brainSystemPrompt({
          project: project && refs ? { name: project.name, repos: refs } : undefined,
          workspace: ws,
          attached: toolRefs && ws ? toolRefs.slice(1) : undefined,
          globalMemory: loadMemory(null),
          projectMemory: project ? loadMemory(project.id) : undefined,
          skills: availableSkills(project?.id ?? null),
          mode: s.permissionMode,
        }),
        tools: brainTools(toolRefs, { attach: !project && !!ws }),
        signal: ac.signal,
        execTool: projectToolExecutor(toolRefs ?? [], {
          projectId: project?.id ?? null,
          callModel,
          attach: !project && ws ? attach : undefined,
          approve: (q, kind) => ask(q, kind, ac.signal),
          askUser: (q) => askContinue(q, ac.signal),
          mode: s.permissionMode,
          hooksEnabled: s.hooksEnabled,
          templatesDir: s.templatesDir || protoAsset('templates') || path.join(ctx.protoDir, 'prototype', 'templates'),
          autoApprovePlan: s.autoApprovePlan,
          onLog: progress,
          signal: ac.signal,
          router: routerInfo(),
        }),
        onStep: (step) => send(EVENTS.CHAT_STEP, step),
      });
      const fresh = r.history.slice(conv.history.length);
      persistChat(conv, fresh);
      conv.history = r.history;
      conv.userTurns++;
      notify({ kind: 'orch', text: r.text || t('desktop.chat.noReply') });
      // reflection nền: sau lượt có dispatch/pipeline/merge hoặc mỗi 4 lượt user — không chặn chat
      const heavy = fresh.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use' && HEAVY_TOOLS.has(b.name)));
      if (heavy || conv.userTurns >= 4) void reflect(conv);
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
  ipcMain.handle(IPC.CHAT_SESSIONS, () => chatSessionsView(settings().projects, { projectId: chat.projectId, id: chat.startedAt }));
  // Dashboard/Settings theo session: activeRepo = repo đầu của project đang mở
  const followProject = (project: { repos: string[] } | null) => {
    const s = settings();
    if (project?.repos[0] && project.repos[0] !== s.activeRepo) saveSettings(ctx.settingsFile, { ...s, activeRepo: project.repos[0] });
  };
  ipcMain.handle(IPC.CHAT_OPEN, (_e, p: { projectId: string | null; id: string }) => {
    if (chatBusy) return { ok: false, error: t('desktop.chat.err.busyOpen') };
    const sf = sessionFile(settings().projects, p?.projectId, p?.id);
    if ('error' in sf) return { ok: false, error: sf.error };
    if (!existsSync(sf.file)) return { ok: false, error: t('desktop.chat.err.noSession', { id: String(p.id) }) };
    const { history, messages } = parseChatSession(readFileSync(sf.file, 'utf8'));
    const projectId = sf.project?.id ?? null;
    if (chat.startedAt !== p.id || chat.projectId !== projectId) void reflect(chat); // flush session cũ
    // ponytail: reflectedUpTo chỉ trong RAM — mở lại session cũ coi như đã reflect hết (không quét lại lịch sử)
    chat = { history, startedAt: p.id, projectId, reflectedUpTo: history.length, userTurns: 0, attached: [] };
    chat.attached = loadAttached(chat);
    followProject(sf.project);
    return { ok: true, messages, projectId, projectName: sf.project?.name ?? null };
  });
  ipcMain.handle(IPC.CHAT_NEW, (_e, p?: { projectId?: string | null }) => {
    if (chatBusy) return { ok: false, error: t('desktop.chat.err.busyOpen') };
    const f = findProject(settings().projects, p?.projectId);
    if ('error' in f) return { ok: false, error: f.error };
    void reflect(chat);
    resetChat(f.project?.id ?? null);
    followProject(f.project);
    return { ok: true, projectId: f.project?.id ?? null, projectName: f.project?.name ?? null };
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
    refreshFleet();
    return r;
  });
  ipcMain.handle(IPC.UNINSTALL_WORKER, (_e, id: string) => {
    const m = getManifest(id);
    if (!m) return { ok: false, detail: 'unknown' };
    const r = uninstallWorker(m);
    refreshFleet();
    return r;
  });

  ipcMain.handle(IPC.CONFORMANCE_RUN, async (_e, id: string) => {
    const m = getManifest(id);
    if (!m) return { badge: 'fail', cases: [], detail: `unknown worker ${id}` };
    return withRepo((repo) => runConformance(m, { repo, withSmoke: true }), (detail) => ({ badge: 'fail', cases: [], detail }));
  });
  // Skills — renderer chỉ gửi tên/scope/projectId/previewId; path luôn do main tính (skills.ts validate tên)
  const skillScope = (p: { scope?: unknown; projectId?: unknown } | undefined): [SkillScope, string | null] => {
    if (p?.scope === 'global') return ['global', null];
    if (p?.scope === 'project') return ['project', projectOf(p.projectId).id];
    throw new Error(t('core.skills.needProject'));
  };
  const strOf = (v: unknown): string => (typeof v === 'string' ? v : '');
  const strsOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  ipcMain.handle(IPC.SKILLS_LIST, (_e, p?: { projectId?: string | null }) => guard(() =>
    ({ skills: listSkills(p?.projectId ? projectOf(p.projectId).id : null) })));
  ipcMain.handle(IPC.SKILLS_SAVE, (_e, p: { scope: string; projectId?: string; skill: Record<string, unknown> }) => guard(() => {
    const [scope, id] = skillScope(p);
    const k = p?.skill ?? {};
    return { skill: saveSkill(scope, id, { name: strOf(k.name), description: strOf(k.description), workers: strsOf(k.workers), tags: strsOf(k.tags), body: strOf(k.body) }) };
  }));
  ipcMain.handle(IPC.SKILLS_REMOVE, (_e, p: { scope: string; projectId?: string; name: string }) => guard(() => {
    const [scope, id] = skillScope(p);
    removeSkill(scope, id, strOf(p?.name));
    return {};
  }));
  // ponytail: clone đồng bộ (spawnSync, timeout 60s) chặn main trong lúc clone — chuyển sang spawn async nếu UI đơ khó chịu
  ipcMain.handle(IPC.SKILLS_PREVIEW_GITHUB, (_e, p: { url: string }) => guard(() => previewGithub(strOf(p?.url))));
  ipcMain.handle(IPC.SKILLS_PREVIEW_LOCAL, () => guard(() => previewLocal()));
  ipcMain.handle(IPC.SKILLS_INSTALL, (_e, p: { previewId: string; names: string[]; scope: string; projectId?: string }) => guard(() => {
    const [scope, id] = skillScope(p);
    return { installed: installSkills({ previewId: strOf(p?.previewId), names: strsOf(p?.names), scope, projectId: id }) };
  }));
  ipcMain.handle(IPC.SKILLS_CHECK_UPDATE, (_e, p: { scope: string; projectId?: string; name: string }) => guard(() => {
    const [scope, id] = skillScope(p);
    return checkUpdate(scope, id, strOf(p?.name));
  }));
  ipcMain.handle(IPC.SKILLS_UPDATE, (_e, p: { previewId: string; scope: string; projectId?: string; name: string }) => guard(() => {
    const [scope, id] = skillScope(p);
    return { installed: updateSkill({ previewId: strOf(p?.previewId), name: strOf(p?.name), scope, projectId: id }) };
  }));
  ipcMain.handle(IPC.SKILLS_CANCEL_PREVIEW, (_e, p: { previewId: string }) => guard(() => {
    cancelPreview(strOf(p?.previewId));
    return {};
  }));
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
// projectId: cố định cho cả session (null = chat ngoài project)
// reflectedUpTo/userTurns: memory reflection — history[reflectedUpTo..] chưa reflect, userTurns = lượt user từ lần reflect trước
// attached: repo user nhắc tới trong chat ngoài project (repo_attach, đã duyệt) — lưu kèm session (<id>.repos.json)
interface Conv { history: Msg[]; startedAt: string; projectId: string | null; reflectedUpTo: number; userTurns: number; attached: string[] }
let chat: Conv = { history: [], startedAt: '', projectId: null, reflectedUpTo: 0, userTurns: 0, attached: [] };
let chatBusy = false;
let chatAbort: AbortController | null = null; // lượt đang chạy — chat:cancel abort
const resetChat = (projectId: string | null = chat.projectId) => {
  chat = { history: [], startedAt: '', projectId, reflectedUpTo: 0, userTurns: 0, attached: [] };
};
const attachedFile = (conv: Conv) => path.join(chatDir(conv.projectId), `${conv.startedAt}.repos.json`);
function loadAttached(conv: Conv): string[] {
  try {
    const v = JSON.parse(readFileSync(attachedFile(conv), 'utf8'));
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && existsSync(path.join(x, '.git'))) : [];
  } catch {
    return [];
  }
}

const HEAVY_TOOLS = new Set(['fleet_dispatch', 'fleet_pipeline', 'fleet_merge']);
const modelCaller = (creds: BrainCreds, model: string): CallModel => (system, user) => callBrainText({ ...creds, model }, system, user);
let reflectSettingsFile = '';
let reflectStep: (text: string) => void = () => {};
/** memory reflection nền cho phần hội thoại chưa reflect — lỗi chỉ log; step chỉ hiện nếu session còn đang mở */
async function reflect(conv: Conv): Promise<void> {
  const from = conv.reflectedUpTo;
  const msgs = conv.history.slice(from);
  const s = loadSettings(reflectSettingsFile);
  const creds = routerCreds();
  if (!msgs.length || !s.brainModel || !creds) return;
  conv.reflectedUpTo = conv.history.length;
  conv.userTurns = 0;
  try {
    const project = conv.projectId ? s.projects.find((p) => p.id === conv.projectId) : undefined;
    if (conv.projectId && !project) return; // project đã bị xoá
    const callModel = modelCaller(creds, s.brainModel);
    const ops = await reflectMemory({
      callModel,
      global: loadMemory(null),
      project: project ? { name: project.name, text: loadMemory(project.id) } : undefined,
      transcript: transcriptOf(msgs),
    });
    const r = await writeMemoryOps(project?.id ?? null, ops, callModel);
    if (r.errors.length) console.log('[memory] reflection ops skipped:', r.errors.join('; '));
    if (r.applied.length && chat === conv) reflectStep(t('desktop.memory.step', { summary: summarizeOps(r.applied) }));
  } catch (err) {
    conv.reflectedUpTo = Math.min(conv.reflectedUpTo, from); // lần sau thử lại
    console.log('[memory] reflection failed:', errMsg(err));
  }
}

/** append message mới vào ~/.orchestra/{projects/<id>/chat,chats}/<startedAt>.jsonl — chỉ nội dung hội thoại, không có key */
function persistChat(conv: Conv, msgs: Msg[]): void {
  try {
    conv.startedAt ||= new Date().toISOString().replace(/[:.]/g, '-');
    const dir = chatDir(conv.projectId);
    mkdirSync(dir, { recursive: true });
    const at = new Date().toISOString();
    appendFileSync(path.join(dir, `${conv.startedAt}.jsonl`), msgs.map((m) => JSON.stringify({ at, ...m })).join('\n') + '\n', 'utf8');
  } catch (err) {
    console.log('[chat] persist failed:', err instanceof Error ? err.message : err);
  }
}

// giữ import MANIFESTS cho wizard (đếm worker chưa cài)
void MANIFESTS;

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
