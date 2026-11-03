// IPC contract — thuần, KHÔNG import electron (unit test được bằng node thường)
// Mỗi channel map 1:1 vào 1 hàm của logic.ts — Desktop không viết logic mới (plan §5)
import { existsSync } from 'node:fs';
import { t, type Locale } from '../../../prototype/src/i18n/index.js';

export const IPC = {
  APP_INFO: 'app:info',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  REPO_SET_ACTIVE: 'repo:set-active',
  REPO_ADD: 'repo:add',
  FLEET_LIST: 'fleet:list',
  TASKS_LIST: 'tasks:list',
  DISPATCH: 'dispatch',
  PIPELINE_RUN: 'pipeline:run',
  CHAT_EXCHANGE: 'chat:exchange',
  MATRIX_DATA: 'matrix:data',
  PROMOTE: 'matrix:promote',
  REVIEW_LIST: 'review:list',
  REVIEW_ACT: 'review:act',
  INSTALL_WORKER: 'install:worker',
  UNINSTALL_WORKER: 'install:uninstall',
  PROVIDERS_LIST: 'providers:list',
  PROVIDERS_SAVE: 'providers:save',
  PROVIDERS_DELETE: 'providers:delete',
  PROVIDERS_TEST: 'providers:test',
  ROUTER_STATUS: 'router:status',
  OAUTH_START: 'oauth:start',
  OAUTH_FINISH: 'oauth:finish',
  CONFORMANCE_RUN: 'conformance:run',
  SKILLS_SYNC: 'skills:sync',
  TERMINAL_CREATE: 'terminal:create',
  TERMINAL_INPUT: 'terminal:input',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_KILL: 'terminal:kill',
  UPDATE_CHECK: 'update:check',
  MODELS_LIST: 'models:list',
  BRAIN_MODELS: 'brain:models',
  CHAT_NEW: 'chat:new',
  CHAT_CANCEL: 'chat:cancel',
  CHAT_SESSIONS: 'chat:sessions',
  CHAT_OPEN: 'chat:open',
  I18N_GET: 'i18n:get',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

/** Events main → renderer (stream) */
export const EVENTS = {
  DISPATCH_EVENT: 'dispatch:event',
  PIPELINE_LOG: 'pipeline:log',
  INSTALL_LOG: 'install:log',
  CHAT_MESSAGE: 'chat:message',
  TERMINAL_DATA: 'terminal:data',
  TERMINAL_EXIT: 'terminal:exit',
  UPDATE_STATUS: 'update:status',
  CHAT_STEP: 'chat:step',
} as const;

export const PAGES = ['dashboard', 'chat', 'transcript', 'settings', 'wizard'] as const;
export type Page = (typeof PAGES)[number];

export interface AppSettings {
  repos: string[];
  activeRepo: string;
  /** model của Orchestra brain — id router `<provider>/<model>`; '' = chưa chọn */
  brainModel: string;
  /** model mặc định của router (CLI gửi model không prefix); '' = dùng brainModel */
  routerDefaultModel: string;
  autoApprovePlan: boolean;
  hooksEnabled: boolean;
  skillSync: boolean;
  templatesDir: string;
  /** ngôn ngữ UI; thiếu (settings cũ / lần đầu) → fallbackLang (main: detectLocale(app.getLocale())) */
  language: Locale;
}

export const DEFAULT_SETTINGS: AppSettings = {
  repos: [],
  activeRepo: '',
  brainModel: '',
  routerDefaultModel: '',
  autoApprovePlan: false,
  hooksEnabled: true,
  skillSync: true,
  templatesDir: '',
  language: 'en',
};

export function validateSettings(raw: unknown, fallbackLang: Locale = DEFAULT_SETTINGS.language): AppSettings {
  const r = (raw ?? {}) as Partial<AppSettings>;
  return {
    repos: Array.isArray(r.repos) ? r.repos.filter((x): x is string => typeof x === 'string' && x.length > 0) : [],
    activeRepo: typeof r.activeRepo === 'string' ? r.activeRepo : '',
    // orchestratorWorker/orchestratorModel (CLI brain cũ) trong settings file cũ: bỏ qua, không lỗi
    // phải là id router `<provider>/<model>` — giá trị cũ kiểu 'worker-claude' → '' (bắt chọn lại)
    brainModel: typeof r.brainModel === 'string' && r.brainModel.includes('/') ? r.brainModel.trim() : '',
    routerDefaultModel: typeof r.routerDefaultModel === 'string' ? r.routerDefaultModel.trim() : '',
    autoApprovePlan: r.autoApprovePlan === true,
    hooksEnabled: r.hooksEnabled !== false,
    skillSync: r.skillSync !== false,
    templatesDir: typeof r.templatesDir === 'string' ? r.templatesDir : '',
    language: r.language === 'en' || r.language === 'vi' ? r.language : fallbackLang,
  };
}

/** repo active (hoặc repos[0]) — throw nếu trống/không tồn tại, tránh chạy trong process cwd */
export function requireRepo(s: Pick<AppSettings, 'activeRepo' | 'repos'>): string {
  const repo = s.activeRepo || s.repos[0] || '';
  if (!repo) throw new Error(t('desktop.err.noRepo'));
  if (!existsSync(repo)) throw new Error(t('desktop.err.repoMissing', { repo }));
  return repo;
}

/** payload types — renderer gửi đúng shape, main validate lại */
export interface DispatchPayload {
  goal: string;
  scope?: string[];
  worker?: string;
  model?: string;
  acceptance?: string[];
}
