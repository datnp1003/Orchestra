import type { FleetEvent, HeadlessOpts, Manifest, MapResult, SpawnSpec } from './types.js';

const ev = (worker: string, t: FleetEvent['t'], props: Record<string, unknown> = {}): FleetEvent => ({
  t,
  worker,
  ts: new Date().toISOString(),
  ...props,
});

// ---------- helpers chung ----------
const summarizeTarget = (input: unknown): string => {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    for (const k of ['file_path', 'path', 'command', 'pattern', 'url', 'query']) {
      const v = o[k];
      if (typeof v === 'string') return v.slice(0, 200);
    }
    const s = JSON.stringify(input);
    return s.length > 200 ? s.slice(0, 200) + '…' : s;
  }
  return String(input ?? '');
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
// TOML basic string
const tomlStr = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// ---------- Claude Code (stream-json) ----------
// Format tham chiếu: claude -p --output-format stream-json
//   {"type":"system","subtype":"init","session_id","model","cwd","tools":[..]}
//   {"type":"assistant","message":{"content":[{"type":"text"|"tool_use",...}]}}
//   {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id","is_error"}]}}
//   {"type":"result","subtype":"success"|"error_*","is_error","total_cost_usd","usage":{...},"result"}
function mapClaude(raw: unknown, worker: string): MapResult {
  if (!isObj(raw) || typeof raw['type'] !== 'string') return { events: [], known: false };
  const type = raw['type'];
  const events: FleetEvent[] = [];

  if (type === 'system') {
    if (raw['subtype'] === 'init') {
      events.push(
        ev(worker, 'session', {
          session: raw['session_id'],
          model: raw['model'],
          cwd: raw['cwd'],
          tools: raw['tools'],
          permission_mode: raw['permissionMode'],
        }),
      );
    }
    // các subtype khác (hook_started, hook_response, thinking_tokens, …) — đã biết, bỏ qua
    return { events, known: true };
  }

  if (type === 'assistant' && isObj(raw['message'])) {
    const msg = raw['message'] as Record<string, unknown>;
    const content = msg['content'];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!isObj(block)) continue;
        if (block['type'] === 'text' && typeof block['text'] === 'string') {
          events.push(ev(worker, 'message', { role: 'assistant', text: block['text'] }));
        } else if (block['type'] === 'tool_use') {
          events.push(
            ev(worker, 'tool_use', {
              tool: block['name'],
              id: block['id'],
              target: summarizeTarget(block['input']),
            }),
          );
        }
      }
    }
    return { events, known: true };
  }

  if (type === 'user' && isObj(raw['message'])) {
    const msg = raw['message'] as Record<string, unknown>;
    const content = msg['content'];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (isObj(block) && block['type'] === 'tool_result') {
          events.push(
            ev(worker, 'tool_result', {
              id: block['tool_use_id'],
              ok: block['is_error'] !== true,
            }),
          );
        }
      }
    }
    return { events, known: true };
  }

  if (type === 'result') {
    const usage = isObj(raw['usage']) ? raw['usage'] : {};
    events.push(
      ev(worker, 'usage', {
        tokens_in: usage['input_tokens'] ?? null,
        tokens_out: usage['output_tokens'] ?? null,
        usd: raw['total_cost_usd'] ?? null,
        model: raw['model'] ?? null,
      }),
    );
    if (raw['is_error'] === true || (typeof raw['subtype'] === 'string' && raw['subtype'].startsWith('error'))) {
      events.push(ev(worker, 'error', { code: raw['subtype'], detail: String(raw['result'] ?? '') }));
    }
    return { events, known: true };
  }

  return { events, known: false };
}

// ---------- Codex CLI (codex exec --json) ----------
// Format tham chiếu: thread.started / item.{started,updated,completed} / turn.{completed,failed}
// item.type: agent_message | command_execution | file_change | reasoning | token_count | error
// ⚠ experimental — cần verify lại theo version pin khi làm conformance thật.
function mapCodex(raw: unknown, worker: string): MapResult {
  if (!isObj(raw) || typeof raw['type'] !== 'string') return { events: [], known: false };
  const type = raw['type'];
  const events: FleetEvent[] = [];

  if (type === 'thread.started') {
    events.push(ev(worker, 'session', { session: raw['thread_id'] ?? null }));
    return { events, known: true };
  }

  if (type === 'turn.started') return { events, known: true };

  if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') {
    const item = isObj(raw['item']) ? raw['item'] : {};
    const itemType = typeof item['type'] === 'string' ? item['type'] : '';
    const done = type === 'item.completed';
    switch (itemType) {
      case 'agent_message':
        if (done && typeof item['text'] === 'string') {
          events.push(ev(worker, 'message', { role: 'assistant', text: item['text'] }));
        }
        break;
      case 'command_execution':
        if (!done) {
          events.push(ev(worker, 'tool_use', { tool: 'bash', id: raw['id'] ?? null, target: String(item['command'] ?? '') }));
        } else {
          const exit = item['exit_code'];
          events.push(ev(worker, 'tool_result', { id: raw['id'] ?? null, ok: exit === 0, exit_code: exit }));
        }
        break;
      case 'file_change':
        if (!done) {
          const changes = Array.isArray(item['changes']) ? item['changes'] : [];
          const targets = changes
            .map((c) => (isObj(c) ? String(c['path'] ?? '') : ''))
            .filter(Boolean)
            .join(', ');
          events.push(ev(worker, 'tool_use', { tool: 'file_change', id: raw['id'] ?? null, target: targets }));
        }
        break;
      case 'error':
        events.push(ev(worker, 'error', { code: 'item_error', detail: String(item['message'] ?? '') }));
        break;
      case 'token_count': {
        const info = isObj(item['info']) ? item['info'] : {};
        const tot = isObj(info['total_token_usage']) ? info['total_token_usage'] : {};
        if (tot['input_tokens'] !== undefined || tot['output_tokens'] !== undefined) {
          events.push(
            ev(worker, 'usage', {
              tokens_in: tot['input_tokens'] ?? null,
              tokens_out: tot['output_tokens'] ?? null,
              usd: null,
              model: item['model'] ?? null,
            }),
          );
        }
        break;
      }
      case 'reasoning':
      case 'web_search':
      case 'todo_list':
      case 'mcp_tool_call':
        // đã biết nhưng chưa map — chấp nhận bỏ qua, không tính là unknown
        break;
      default:
        return { events, known: false };
    }
    return { events, known: true };
  }

  if (type === 'turn.completed') {
    const usage = isObj(raw['usage']) ? raw['usage'] : {};
    events.push(
      ev(worker, 'usage', {
        tokens_in: usage['input_tokens'] ?? null,
        tokens_out: usage['output_tokens'] ?? null,
        usd: null,
      }),
    );
    return { events, known: true };
  }

  if (type === 'turn.failed' || type === 'error') {
    events.push(ev(worker, 'error', { code: type, detail: JSON.stringify(raw).slice(0, 300) }));
    return { events, known: true };
  }

  return { events, known: false };
}

// ---------- manifests ----------
const claude: Manifest = {
  id: 'claude',
  display: 'Claude Code',
  bin: 'claude',
  install: { npm: '@anthropic-ai/claude-code', winget: 'Anthropic.ClaudeCode' },
  oauthProvider: 'anthropic',
  versionCmd: { cmd: 'claude', args: ['--version'] },
  versionRegex: /([0-9]+\.[0-9]+\.[0-9]+)/,
  // không có auth check non-interactive đáng tin ở 2.1.x → 'unknown' đến khi smoke pass
  headless: (prompt: string, opts: HeadlessOpts): SpawnSpec => {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      opts.sandbox === 'worktree-write' ? 'acceptEdits' : 'plan',
    ];
    if (opts.model) args.push('--model', opts.model);
    if (opts.resume) args.push('--resume', opts.resume); // P6.2 session resume
    if (opts.systemPrompt) args.push('--append-system-prompt', opts.systemPrompt); // P5.6 chat brain
    // P6 — deny globs xuống tầng flag (Worker Protocol §9 Lớp 2):
    // Edit/Write chỉ auto-approve với pattern trong scope; ngoài scope → denied ở headless.
    // Bash vẫn rộng (test/build) — giới hạn: lệnh bash ghi ngoài scope do FS cross-check bắt.
    if (opts.sandbox === 'worktree-write' && opts.scope && opts.scope.length) {
      args.push(
        '--allowedTools',
        'Read',
        'Grep',
        'Glob',
        ...opts.scope.flatMap((p) => [`Edit(${p})`, `Write(${p})`]),
        'Bash',
      );
    }
    args.push(prompt);
    return { cmd: 'claude', args };
  },
  mapEvent: mapClaude,
  requiredEvents: ['session', 'message', 'usage'],
  scopeRules: true,
  hooksSupport: true,
  vault: { provider: 'anthropic', env: 'ANTHROPIC_AUTH_TOKEN', base_url_env: 'ANTHROPIC_BASE_URL' },
  notes: [
    'conformance pin: 2.1.310',
    'permission: --permission-mode plan (read-only) | acceptEdits (worktree-write)',
  ],
};

const codex: Manifest = {
  id: 'codex',
  display: 'Codex CLI',
  bin: 'codex',
  install: { npm: '@openai/codex' },
  oauthProvider: 'openai',
  versionCmd: { cmd: 'codex', args: ['--version'] },
  versionRegex: /([0-9]+\.[0-9]+\.[0-9]+)/,
  authCmd: { cmd: 'codex', args: ['login', 'status'] },
  vault: { provider: 'openai', env: 'OPENAI_API_KEY', base_url_env: 'OPENAI_BASE_URL' },
  headless: (prompt: string, opts: HeadlessOpts): SpawnSpec => {
    const args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      codexSandbox(opts.sandbox),
    ];
    if (opts.model) args.push('-c', `model=${opts.model}`);
    args.push(prompt);
    return { cmd: 'codex', args };
  },
  mapEvent: mapCodex,
  requiredEvents: ['session', 'usage'],
  hooksSupport: true,
  // codex 0.164 exec: hook qua -c (TOML) + --dangerously-bypass-hook-trust; deny = JSON stdout (exit 2 không dùng)
  hookArgs: (cmd) => ['-c', `hooks.PreToolUse=[{matcher=".*",hooks=[{type="command",command=${tomlStr(cmd)},timeout=30}]}]`, '--dangerously-bypass-hook-trust'],
  experimental: true,
  notes: [
    'conformance pin: 0.164.0',
    'event format exec --json là experimental — unmapped lines là tín hiệu cần sửa adapter',
    '--skip-git-repo-check: prototype chạy ngoài git repo',
    'Windows non-admin: workspace-write fail (restricted-token sandbox) → worktree-write dùng danger-full-access; isolation = git worktree + guard.cjs + scope check (Lớp 4) + fs cross-check (Lớp 3)',
    'guard.cjs là chặn mức pattern (lệnh shell + path trong apply_patch), KHÔNG phải OS sandbox; hook phụ thuộc --dangerously-bypass-hook-trust',
  ],
};

/** codex --sandbox theo node: read-only giữ nguyên mọi OS; worktree-write trên win32 → danger-full-access
 *  (unelevated restricted-token sandbox của codex không spawn được shell — E2E t-mvyyi9rd-agyn). */
export function codexSandbox(sandbox: HeadlessOpts['sandbox'], platform: NodeJS.Platform = process.platform): string {
  if (sandbox !== 'worktree-write') return 'read-only';
  return platform === 'win32' ? 'danger-full-access' : 'workspace-write';
}

const antigravity: Manifest = {
  id: 'antigravity',
  display: 'Antigravity CLI',
  bin: 'antigravity',
  // Google phân phối riêng — không qua npm public
  install: {},
  versionCmd: { cmd: 'antigravity', args: ['--version'] },
  versionRegex: /([0-9]+\.[0-9]+\.[0-9]+)/,
  headless: () => ({ cmd: 'antigravity', args: ['-p'] }), // placeholder — conformance sẽ verify/bác
  mapEvent: mapClaude, // giả định stream-json tương thích — case 2 conformance sẽ xác nhận
  requiredEvents: ['session', 'usage'],
  oauthProvider: 'google', // P6.6: duy nhất kênh native google
  custom_provider: false, // KHÔNG nhận custom endpoint — luật phân phối của user
  model_slots: { main: true, fast: false, plan: false },
  experimental: true,
  notes: [
    'chưa cài trên máy dev — manifest thể hiện luật phân phối: CHỈ native google (OAuth gemini)',
    'custom endpoint: KHÔNG hỗ trợ — model family khác không phân phối được cho CLI này',
    'conformance: untested (placeholder)',
  ],
};

export const MANIFESTS: Manifest[] = [claude, codex, antigravity];

export const getManifest = (id: string): Manifest | undefined => MANIFESTS.find((m) => m.id === id);
