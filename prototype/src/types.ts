// Normalized events per Worker Protocol spec v0.1 §8
import type { ProviderConfig } from './router/providers.js';

/** R2a: local Orchestra router — auth "synced down" to the CLI at spawn, user config untouched */
export interface RouterInfo {
  baseUrl: string; // http://127.0.0.1:<port>, without '/v1'
  token: string;
  defaultModel?: string;
  /** present → policy binding models are checked with routerModelOk */
  providers?: ProviderConfig[];
}

export type EventType =
  | 'session'
  | 'message'
  | 'tool_use'
  | 'tool_result'
  | 'usage'
  | 'blocked'
  | 'error'
  | 'done';

export interface FleetEvent {
  t: EventType;
  worker: string;
  ts: string;
  [key: string]: unknown;
}

export interface SpawnSpec {
  cmd: string;
  args: string[];
}

export interface HeadlessOpts {
  sandbox?: 'read-only' | 'worktree-write';
  model?: string;
  /** P6: files_in_scope — supporting CLIs (claude) map it to allowedTools Edit/Write(pattern) */
  scope?: string[];
  /** P6.2: session resume — continue the previous conversation instead of a new session */
  resume?: string;
  /** P5.6: extra system prompt (--append-system-prompt) — for orchestrator chat */
  systemPrompt?: string;
  /** reference images (absolute paths inside the worktree) — CLIs with an image flag attach them to the prompt */
  images?: string[];
}

/** Result of mapping 1 raw JSONL line */
export interface MapResult {
  events: FleetEvent[];
  /** whether the raw line belongs to a known format — conformance signal */
  known: boolean;
}

export interface Manifest {
  id: string;
  display: string;
  bin: string;
  versionCmd: SpawnSpec;
  versionRegex: RegExp;
  authCmd?: SpawnSpec;
  /** build headless invocation; prompt is always the last arg, no shell */
  headless: (prompt: string, opts: HeadlessOpts) => SpawnSpec;
  /** map 1 raw JSONL line → 0..n normalized events */
  mapEvent: (raw: unknown, worker: string) => MapResult;
  /** events that must appear in the smoke test (Worker Protocol §10 case 2) */
  requiredEvents: EventType[];
  /**
   * P6.5 — Auth domain rule: the CLI's OAuth applies only to this provider.
   * Other providers' models → ONLY via vault API key + custom provider (API-translating gateway).
   * claude: anthropic · codex: openai · antigravity: google
   */
  oauthProvider?: string;
  /** P6.6: whether the CLI accepts a custom endpoint (base_url + key) — antigravity: false */
  custom_provider?: boolean;
  /** P6.6: model slots the CLI supports (Role Policy §level 3) */
  model_slots?: { main: boolean; fast: boolean; plan: boolean };
  /** P6.3: install — npm is the standard channel for agent CLIs (Worker Protocol §3); winget as Windows fallback */
  install?: { npm?: string; winget?: string };
  /** P6: CLI supports path-level permission rules (conformance case 4 runnable) */
  scopeRules?: boolean;
  /** P6.2: CLI supports PreToolUse hooks (conformance case 8 runnable) */
  hooksSupport?: boolean;
  /** P6.2: args attaching the PreToolUse hook (runner inserts before prompt) — absent = claude `--settings <file>` */
  hookArgs?: (hookCommand: string) => string[];
  /** R2a: point the CLI at the Orchestra router — args + env; settingsEnv (claude) merged with hooks into 1 `--settings` JSON */
  routerArgs?: (r: RouterInfo, model?: string) => { args?: string[]; env?: Record<string, string>; settingsEnv?: Record<string, string> };
  experimental?: boolean;
  notes: string[];
}
