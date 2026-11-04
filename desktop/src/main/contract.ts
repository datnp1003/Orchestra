// IPC contract — pure, NO electron import (unit-testable with plain node)
// Each channel maps 1:1 to a logic.ts function — Desktop writes no new logic (plan §5)
import { existsSync } from 'node:fs';
import { t, type Locale } from '../../../prototype/src/i18n/index.js';
import { PROJECT_ID_RE } from '../../../prototype/src/home.js';
import { isPermissionMode, type PermissionMode } from '../../../prototype/src/permissions.js';

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
  FLEET_REFRESH: 'fleet:refresh',
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
  APPROVAL_RESPOND: 'approval:respond',
  APPROVAL_PENDING: 'approval:pending',
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
  /** approval card inline in chat (replaces native modal) */
  APPROVAL_REQUEST: 'approval:request',
  APPROVAL_RESOLVED: 'approval:resolved',
  /** click notification → Chat + focus card */
  APPROVAL_FOCUS: 'approval:focus',
  /** background fleet probe done (startup / refresh / after install) → new snapshot */
  FLEET_CHANGED: 'fleet:changed',
} as const;

export const PAGES = ['dashboard', 'chat', 'transcript', 'settings', 'wizard'] as const;
export type Page = (typeof PAGES)[number];

export interface Project {
  /** slug(name)-xxxx, /^[\w-]+$/ — dir name ~/.orchestra/projects/<id> */
  id: string;
  name: string;
  repos: string[];
}

export interface AppSettings {
  /** project = group of repos (microservices); sessions + memory per project */
  projects: Project[];
  /** = union of all projects' repos (derived on validate) — kept for old code reading repos */
  repos: string[];
  activeRepo: string;
  /** Orchestra brain model — router id `<provider>/<model>`; '' = not chosen */
  brainModel: string;
  /** router default model (CLI sends unprefixed model); '' = use brainModel */
  routerDefaultModel: string;
  autoApprovePlan: boolean;
  hooksEnabled: boolean;
  templatesDir: string;
  /** UI language; missing (old settings / first run) → fallbackLang (main: detectLocale(app.getLocale())) */
  language: Locale;
  /** chat: ask | auto | full — enforced at the tool layer (needsApproval) */
  permissionMode: PermissionMode;
  /** chat Plan mode — independent of permissionMode; blocks execution tools and is announced in the conversation */
  planEnabled: boolean;
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
  permissionMode: 'ask',
  planEnabled: false,
};

export function validateSettings(raw: unknown, fallbackLang: Locale = DEFAULT_SETTINGS.language): AppSettings {
  const r = (raw ?? {}) as Partial<AppSettings>;
  const projects = Array.isArray(r.projects) ? validProjects(r.projects) : null;
  // has projects → repos = union of project repos; old settings (not migrated) → keep old repos
  const repos = projects ? [...new Set(projects.flatMap((p) => p.repos))] : strList(r.repos);
  const active = typeof r.activeRepo === 'string' ? r.activeRepo : '';
  return {
    projects: projects ?? [],
    repos,
    activeRepo: !projects || repos.includes(active) ? active : repos[0] ?? '',
    // orchestratorWorker/orchestratorModel (old CLI brain) in old settings files: ignored, no error
    // must be a router id `<provider>/<model>` — old values like 'worker-claude' → '' (forces re-pick)
    brainModel: typeof r.brainModel === 'string' && r.brainModel.includes('/') ? r.brainModel.trim() : '',
    routerDefaultModel: typeof r.routerDefaultModel === 'string' ? r.routerDefaultModel.trim() : '',
    autoApprovePlan: r.autoApprovePlan === true,
    hooksEnabled: r.hooksEnabled !== false,
    templatesDir: typeof r.templatesDir === 'string' ? r.templatesDir : '',
    language: r.language === 'en' || r.language === 'vi' ? r.language : fallbackLang,
    // old settings stored Plan as a permission ('plan') → Plan on + safe 'ask'
    permissionMode: isPermissionMode(r.permissionMode) ? r.permissionMode : DEFAULT_SETTINGS.permissionMode,
    planEnabled: r.planEnabled === true || (r as { permissionMode?: unknown }).permissionMode === 'plan',
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

/** active repo (or repos[0]) — throws if empty/missing, avoids running in process cwd */
export function requireRepo(s: Pick<AppSettings, 'activeRepo' | 'repos'>): string {
  const repo = s.activeRepo || s.repos[0] || '';
  if (!repo) throw new Error(t('desktop.err.noRepo'));
  if (!existsSync(repo)) throw new Error(t('desktop.err.repoMissing', { repo }));
  return repo;
}

/** payload types — renderer sends the right shape, main re-validates */
export interface DispatchPayload {
  goal: string;
  scope?: string[];
  worker?: string;
  model?: string;
  acceptance?: string[];
}
