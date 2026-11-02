// IPC contract — thuần, KHÔNG import electron (unit test được bằng node thường)
// Mỗi channel map 1:1 vào 1 hàm của logic.ts — Desktop không viết logic mới (plan §5)
import { existsSync } from 'node:fs';

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
  MATRIX_HTML: 'matrix:html',
  PROMOTE: 'matrix:promote',
  REVIEW_LIST: 'review:list',
  REVIEW_ACT: 'review:act',
  INSTALL_WORKER: 'install:worker',
  UNINSTALL_WORKER: 'install:uninstall',
  VAULT_SET: 'vault:set',
  VAULT_DELETE: 'vault:delete',
  CONFORMANCE_RUN: 'conformance:run',
  SKILLS_SYNC: 'skills:sync',
  TERMINAL_CREATE: 'terminal:create',
  TERMINAL_INPUT: 'terminal:input',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_KILL: 'terminal:kill',
  UPDATE_CHECK: 'update:check',
  MODELS_LIST: 'models:list',
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
} as const;

export const PAGES = ['dashboard', 'chat', 'transcript', 'matrix', 'settings', 'wizard'] as const;
export type Page = (typeof PAGES)[number];

export interface AppSettings {
  repos: string[];
  activeRepo: string;
  orchestratorWorker: string;
  /** '' = model mặc định của CLI */
  orchestratorModel: string;
  autoApprovePlan: boolean;
  hooksEnabled: boolean;
  skillSync: boolean;
  templatesDir: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  repos: [],
  activeRepo: '',
  orchestratorWorker: 'claude',
  orchestratorModel: '',
  autoApprovePlan: false,
  hooksEnabled: true,
  skillSync: true,
  templatesDir: '',
};

export function validateSettings(raw: unknown): AppSettings {
  const r = (raw ?? {}) as Partial<AppSettings>;
  return {
    repos: Array.isArray(r.repos) ? r.repos.filter((x): x is string => typeof x === 'string' && x.length > 0) : [],
    activeRepo: typeof r.activeRepo === 'string' ? r.activeRepo : '',
    orchestratorWorker: typeof r.orchestratorWorker === 'string' && r.orchestratorWorker ? r.orchestratorWorker : DEFAULT_SETTINGS.orchestratorWorker,
    orchestratorModel: typeof r.orchestratorModel === 'string' ? r.orchestratorModel : '',
    autoApprovePlan: r.autoApprovePlan === true,
    hooksEnabled: r.hooksEnabled !== false,
    skillSync: r.skillSync !== false,
    templatesDir: typeof r.templatesDir === 'string' ? r.templatesDir : '',
  };
}

/** repo active (hoặc repos[0]) — throw nếu trống/không tồn tại, tránh chạy trong process cwd */
export function requireRepo(s: Pick<AppSettings, 'activeRepo' | 'repos'>): string {
  const repo = s.activeRepo || s.repos[0] || '';
  if (!repo) throw new Error('Chưa chọn repo — thêm repo ở Cài đặt');
  if (!existsSync(repo)) throw new Error(`Repo không tồn tại: ${repo}`);
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
