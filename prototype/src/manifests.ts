import type { FleetEvent, HeadlessOpts, Manifest, MapResult, SpawnSpec } from './types.js';

const ev = (worker: string, t: FleetEvent['t'], props: Record<string, unknown> = {}): FleetEvent => ({
  t,
  worker,
  ts: new Date().toISOString(),
  ...props,
});

// ---------- shared helpers ----------
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
// Reference format: claude -p --output-format stream-json
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
    // other subtypes (hook_started, hook_response, thinking_tokens, …) — known, ignored
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
// Reference format: thread.started / item.{started,updated,completed} / turn.{completed,failed}
// item.type: agent_message | command_execution | file_change | reasoning | token_count | error
// ⚠ experimental — re-verify against the pinned version when doing real conformance.
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
        // known but not mapped yet — ignored, not counted as unknown
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
  // no reliable non-interactive auth check in 2.1.x → 'unknown' until smoke passes
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
    // P6 — push deny globs down to the flag layer (Worker Protocol §9 Layer 2):
    // Edit/Write auto-approved only for in-scope patterns; out of scope → denied in headless.
    // Bash stays broad (test/build) — limitation: bash writes outside scope are caught by the FS cross-check.
    if (opts.sandbox === 'worktree-write' && opts.scope && opts.scope.length) {
      args.push(
        '--allowedTools',
        'Read',
        'Grep',
        'Glob',
        'Skill', // Orchestra skills copied into the worktree's .claude/skills/
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
  // R2a: claude ignores process ANTHROPIC_* (user settings.json overrides) → env via inline --settings
  routerArgs: (r, model) => {
    const m = model || r.defaultModel;
    return {
      settingsEnv: {
        ANTHROPIC_BASE_URL: r.baseUrl,
        ANTHROPIC_AUTH_TOKEN: r.token,
        // background requests (title, haiku…) also go through the router
        ...(m ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: m, ANTHROPIC_DEFAULT_SONNET_MODEL: m, ANTHROPIC_DEFAULT_OPUS_MODEL: m } : {}),
      },
    };
  },
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
  // R2a: codex 0.164 — provider 'orch' points at the router; wire_api chat sends no request → responses only
  routerArgs: (r, model) => {
    const m = model ? undefined : r.defaultModel; // model given → headless already adds -c model
    return {
      args: [
        '-c', 'model_provider="orch"',
        '-c', 'model_providers.orch.name="orch"',
        '-c', `model_providers.orch.base_url=${tomlStr(`${r.baseUrl}/v1`)}`,
        '-c', 'model_providers.orch.wire_api="responses"',
        '-c', 'model_providers.orch.env_key="ORCH_ROUTER_TOKEN"',
        ...(m ? ['-c', `model=${tomlStr(m)}`] : []),
      ],
      env: { ORCH_ROUTER_TOKEN: r.token },
    };
  },
  headless: (prompt: string, opts: HeadlessOpts): SpawnSpec => {
    const args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      codexSandbox(opts.sandbox),
    ];
    if (opts.model) args.push('-c', `model=${tomlStr(opts.model)}`);
    args.push(prompt);
    return { cmd: 'codex', args };
  },
  mapEvent: mapCodex,
  requiredEvents: ['session', 'usage'],
  hooksSupport: true,
  // codex 0.164 exec: hook via -c (TOML) + --dangerously-bypass-hook-trust; deny = JSON stdout (exit 2 not used)
  hookArgs: (cmd) => ['-c', `hooks.PreToolUse=[{matcher=".*",hooks=[{type="command",command=${tomlStr(cmd)},timeout=30}]}]`, '--dangerously-bypass-hook-trust'],
  experimental: true,
  notes: [
    'conformance pin: 0.164.0',
    'exec --json event format is experimental — unmapped lines signal the adapter needs fixing',
    '--skip-git-repo-check: prototype runs outside a git repo',
    'Windows non-admin: workspace-write fails (restricted-token sandbox) → worktree-write uses danger-full-access; isolation = git worktree + guard.cjs + scope check (Layer 4) + fs cross-check (Layer 3)',
    'guard.cjs blocks at pattern level (shell commands + paths in apply_patch), NOT an OS sandbox; hook depends on --dangerously-bypass-hook-trust',
  ],
};

/** codex --sandbox per node: read-only unchanged on every OS; worktree-write on win32 → danger-full-access
 *  (codex's unelevated restricted-token sandbox cannot spawn a shell — E2E t-mvyyi9rd-agyn). */
export function codexSandbox(sandbox: HeadlessOpts['sandbox'], platform: NodeJS.Platform = process.platform): string {
  if (sandbox !== 'worktree-write') return 'read-only';
  return platform === 'win32' ? 'danger-full-access' : 'workspace-write';
}

const antigravity: Manifest = {
  id: 'antigravity',
  display: 'Antigravity CLI',
  bin: 'antigravity',
  // distributed separately by Google — not via public npm
  install: {},
  versionCmd: { cmd: 'antigravity', args: ['--version'] },
  versionRegex: /([0-9]+\.[0-9]+\.[0-9]+)/,
  headless: () => ({ cmd: 'antigravity', args: ['-p'] }), // placeholder — conformance will verify/refute
  mapEvent: mapClaude, // assumes compatible stream-json — conformance case 2 will confirm
  requiredEvents: ['session', 'usage'],
  oauthProvider: 'google', // P6.6: native google channel only
  custom_provider: false, // does NOT accept a custom endpoint — user's distribution rule
  model_slots: { main: true, fast: false, plan: false },
  experimental: true,
  notes: [
    'not installed on the dev machine — manifest expresses the distribution rule: native google ONLY (OAuth gemini)',
    'custom endpoint: NOT supported — other model families cannot be distributed to this CLI',
    'conformance: untested (placeholder)',
  ],
};

export const MANIFESTS: Manifest[] = [claude, codex, antigravity];

export const getManifest = (id: string): Manifest | undefined => MANIFESTS.find((m) => m.id === id);
