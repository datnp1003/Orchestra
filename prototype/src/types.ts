// Event chuẩn hoá theo Worker Protocol spec v0.1 §8
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
  /** P6: files_in_scope — CLI hỗ trợ (claude) sẽ map thành allowedTools Edit/Write(pattern) */
  scope?: string[];
  /** P6.2: session resume — tiếp tục hội thoại cũ thay vì phiên mới */
  resume?: string;
  /** P5.6: system prompt bổ sung (--append-system-prompt) — cho orchestrator chat */
  systemPrompt?: string;
}

/** Kết quả map 1 dòng raw JSONL */
export interface MapResult {
  events: FleetEvent[];
  /** raw line có thuộc format đã biết không — conformance signal */
  known: boolean;
}

export interface Manifest {
  id: string;
  display: string;
  bin: string;
  versionCmd: SpawnSpec;
  versionRegex: RegExp;
  authCmd?: SpawnSpec;
  /** build headless invocation; prompt luôn là args cuối, không qua shell */
  headless: (prompt: string, opts: HeadlessOpts) => SpawnSpec;
  /** map 1 raw JSONL line → 0..n event chuẩn */
  mapEvent: (raw: unknown, worker: string) => MapResult;
  /** event bắt buộc phải xuất hiện trong smoke test (Worker Protocol §10 case 2) */
  requiredEvents: EventType[];
  /** P5.2: vault injection — key từ DPAPI vault set vào env lúc spawn, không qua LLM */
  vault?: { provider: string; env: string; /** P6.4: custom provider base URL env (ANTHROPIC_BASE_URL / OPENAI_BASE_URL) */ base_url_env?: string };
  /**
   * P6.5 — Auth domain rule: OAuth của CLI chỉ áp dụng cho provider này.
   * Model của provider khác → CHỈ qua vault API key + custom provider (gateway dịch API).
   * claude: anthropic · codex: openai · antigravity: google
   */
  oauthProvider?: string;
  /** P6.6: CLI có nhận custom endpoint (base_url + key) không — antigravity: false */
  custom_provider?: boolean;
  /** P6.6: slot model CLI hỗ trợ (Role Policy §mức 3) */
  model_slots?: { main: boolean; fast: boolean; plan: boolean };
  /** P6.3: cài đặt — npm là kênh chuẩn của agent CLI (Worker Protocol §3); winget fallback Windows */
  install?: { npm?: string; winget?: string };
  /** P6: CLI hỗ trợ path-level permission rules (conformance case 4 chạy được) */
  scopeRules?: boolean;
  /** P6.2: CLI hỗ trợ PreToolUse hooks qua --settings (conformance case 8 chạy được) */
  hooksSupport?: boolean;
  experimental?: boolean;
  notes: string[];
}
