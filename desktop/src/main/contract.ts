// IPC contract — thuần, KHÔNG import electron (unit test được bằng node thường)
// Mỗi channel map 1:1 vào 1 hàm của logic.ts — Desktop không viết logic mới (plan §5)
import { existsSync } from 'node:fs';
import { t, type Locale } from '../../../prototype/src/i18n/index.js';
import { PROJECT_ID_RE } from '../../../prototype/src/home.js';

export const IPC = {
  APP_INFO: 'app:info',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  PROJECTS_LIST: 'projects:list',
  PROJECT_GET: 'project:get',
  PROJECT_CREATE: 'project:create',
  PROJECT_ADD_REPO: 'project:addRepo',
  PROJECT_REMOVE_REPO: 'project:removeRepo',
  PROJECT_RENAME: 'project:rename',
  PROJECT_DELETE: 'project:delete',
  MEMORY_GET: 'memory:get',
  MEMORY_SET: 'memory:set',
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
  SKILLS_LIST: 'skills:list',
  SKILLS_SAVE: 'skills:save',
  SKILLS_REMOVE: 'skills:remove',
  SKILLS_PREVIEW_GITHUB: 'skills:previewGithub',
  SKILLS_PREVIEW_LOCAL: 'skills:previewLocal',
  SKILLS_INSTALL: 'skills:install',
  SKILLS_CHECK_UPDATE: 'skills:checkUpdate',
  SKILLS_UPDATE: 'skills:update',
  SKILLS_CANCEL_PREVIEW: 'skills:cancelPreview',
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

export interface Project {
  /** slug(name)-xxxx, /^[\w-]+$/ — tên thư mục ~/.orchestra/projects/<id> */
  id: string;
  name: string;
  repos: string[];
}

export interface AppSettings {
  /** project = nhóm repo (microservices); session + memory theo project */
  projects: Project[];
  /** = hợp các repo của mọi project (dẫn xuất khi validate) — giữ cho code cũ đọc repos */
  repos: string[];
  activeRepo: string;
  /** model của Orchestra brain — id router `<provider>/<model>`; '' = chưa chọn */
  brainModel: string;
  /** model mặc định của router (CLI gửi model không prefix); '' = dùng brainModel */
  routerDefaultModel: string;
  autoApprovePlan: boolean;
  hooksEnabled: boolean;
  templatesDir: string;
  /** ngôn ngữ UI; thiếu (settings cũ / lần đầu) → fallbackLang (main: detectLocale(app.getLocale())) */
  language: Locale;
}

export const DEFAULT_SETTINGS: AppSettings = {
  projects: [],
  repos: [],
  activeRepo: '',
  brainModel: '',
  routerDefaultModel: '',
  autoApprovePlan: false,
  hooksEnabled: true,
  templatesDir: '',
  language: 'en',
};

export function validateSettings(raw: unknown, fallbackLang: Locale = DEFAULT_SETTINGS.language): AppSettings {
  const r = (raw ?? {}) as Partial<AppSettings>;
  const projects = Array.isArray(r.projects) ? validProjects(r.projects) : null;
  // có projects → repos = hợp repo của project; settings cũ (chưa migrate) → giữ repos cũ
  const repos = projects ? [...new Set(projects.flatMap((p) => p.repos))] : strList(r.repos);
  const active = typeof r.activeRepo === 'string' ? r.activeRepo : '';
  return {
    projects: projects ?? [],
    repos,
    activeRepo: !projects || repos.includes(active) ? active : repos[0] ?? '',
    // orchestratorWorker/orchestratorModel (CLI brain cũ) trong settings file cũ: bỏ qua, không lỗi
    // phải là id router `<provider>/<model>` — giá trị cũ kiểu 'worker-claude' → '' (bắt chọn lại)
    brainModel: typeof r.brainModel === 'string' && r.brainModel.includes('/') ? r.brainModel.trim() : '',
    routerDefaultModel: typeof r.routerDefaultModel === 'string' ? r.routerDefaultModel.trim() : '',
    autoApprovePlan: r.autoApprovePlan === true,
    hooksEnabled: r.hooksEnabled !== false,
    templatesDir: typeof r.templatesDir === 'string' ? r.templatesDir : '',
    language: r.language === 'en' || r.language === 'vi' ? r.language : fallbackLang,
  };
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0))] : []);
function validProjects(raw: unknown[]): Project[] {
  const seen = new Set<string>();
  return raw.flatMap((x) => {
    const p = (x ?? {}) as Partial<Project>;
    if (typeof p.id !== 'string' || !PROJECT_ID_RE.test(p.id) || seen.has(p.id) || typeof p.name !== 'string' || !p.name.trim()) return [];
    seen.add(p.id);
    return [{ id: p.id, name: p.name.trim(), repos: strList(p.repos) }];
  });
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
