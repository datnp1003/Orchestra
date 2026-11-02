# Orchestra Worker Protocol — Spec v0.1
> English only (canonical). Vietnamese UI strings live in prototype/src/i18n/vi.ts.

Contract between the Orchestrator (IDE agent) and the agent CLIs (workers): manifest, TaskBrief,
normalized stream, permission model, in-flight supervision, and the `fleet.*` toolset.

---

## 1. Principles (invariant)

1. **A worker is a process with a contract, not a friendly terminal.** Every spawn has a
   TaskBrief (input), a JSONL stream (progress), and an artifact contract (output). Contract ends → process ends.
2. **Deny by capability, not by instruction.** Don't write "don't do X" in the prompt and
   hope the worker obeys — lock X at the flag/sandbox/filesystem layer. The prompt is a map, not a wall.
3. **No permission prompts in headless mode.** A prompt waiting for approval = deadlock (nobody answers).
   Every permission is granted or denied *before* spawn; overstepping *at runtime* → kill, no asking.
4. **Humans stand at fixed gates, not behind every action.** Plan approval + merge gate are
   the 2 main gates. Everything else: the orchestrator supervises and blocks.
5. **Keys never pass through the LLM.** The orchestrator never receives an API key in any form —
   the vault injects into env at spawn time, done by the runner (plain code).
6. **Every prompt and every blocking decision is logged** to the task record (episodic) — auditable.

## 2. Worker lifecycle

```
dispatch(brief) ─► validate brief ─► resolve worker (Role Policy + fence) ─► spawn (flags/env/worktree)
      ▲                                                                          │
      │                                                              stream JSONL (normalized)
      │                                                                          ▼
   fix/retry loop                                                          Supervisor in-flight
   (per the DSL's on_fail)                                      (deny pattern, budget, timeout)
                                                                                   │
                                                        done/fail ─► collect artifacts ─► gate (DSL)
```

## 3. Agent Manifest

One manifest per CLI — the source of truth for install, spawn, permission, model. The registry can
be community-contributed; the conformance test (§10) scores it before a badge is shown.

```yaml
id: claude
display: "Claude Code"
install:
  npm: "@anthropic-ai/claude-code"
  fallback: { winget: "Anthropic.ClaudeCode" }   # Windows: prefer npm, fall back to winget
version_check: "claude --version"
auth:
  modes: [subscription, api_key, bedrock, vertex]
  check: "claude auth status"                    # must be verified against the pinned version
headless: "claude -p --output-format stream-json --verbose"
permission:
  mode_flag: "--permission-mode {mode}"          # plan | acceptEdits | bypassPermissions
  allow: "--allowedTools {allow}"
  deny:  "--disallowedTools {deny}"
  guarantee: worktree_only
model:
  custom_provider: true
  spawn_overrides:
    base_url: "env:ANTHROPIC_BASE_URL"
    api_key:  "env:ANTHROPIC_AUTH_TOKEN"          # value taken from the vault at spawn time
    model:    "--model {model}"
    fast:     "env:ANTHROPIC_DEFAULT_HAIKU_MODEL"
  model_slots: { main: true, fast: true, plan: false }
strengths: [architecture, review, ui]            # used for role routing
cost_tier: high
```

```yaml
id: codex
display: "Codex CLI"
install: { npm: "@openai/codex" }
version_check: "codex --version"
headless: "codex exec --json -a never"
permission:
  mode_flag: "--sandbox {mode}"                  # read-only | workspace-write | danger-full-access (forbidden)
  approval: "-a never"
  guarantee: workspace_write
model:
  custom_provider: true
  spawn_overrides:
    model:    "-c model={model}"
    provider: "-c model_provider={provider}"
    api_key:  "env:{env_key}"
  model_slots: { main: true, fast: false, plan: false }
strengths: [fast-implementation, refactor]
cost_tier: medium
```

```yaml
id: opencode
display: "OpenCode"
install: { npm: "opencode-ai" }
headless: "opencode run --print-logs"
permission: { guarantee: project_config }         # permissions declared in opencode.json; runner writes a managed section
model:
  custom_provider: true
  spawn_overrides: { model: "--model {provider}/{model}" }
  model_slots: { main: true, fast: true, plan: true }
strengths: [research, docs]
cost_tier: low
```

```yaml
id: antigravity
display: "Antigravity CLI"
install: { npm: "@google/antigravity-cli" }       # placeholder — verify during P1
version_check: "antigravity --version"
headless: "antigravity -p"
permission: { guarantee: unknown_until_conformance }
model:
  custom_provider: false                          # main model tied to Google — does not accept config push
  model_slots: { main: true, fast: false, plan: false }
strengths: [research, big-context]                # still routable as a Google-only worker
```

> Every `check`/flag field must pass the conformance test against a pinned version — the manifest records
> `conformance: "x.y.z"` as the verified version. CLI updated but not yet tested → yellow badge, not blocked.

## 4. Registry & Fleet management

```
fleet.list()               → [{id, installed, version, conformance, auth_ok, health}]
fleet.install(id)          → npm/winget/brew per manifest, progress shown in the IDE
fleet.update(id)           → update + rerun conformance + report flag diff if the CLI changed syntax
fleet.auth(id)             → open guided login flow (each CLI differs — OAuth is not automated)
fleet.smoke(id, model?)    → 1 small headless prompt ("reply OK") → confirms auth + model + valid stream
```

Status badge on the Role × Worker × Model matrix: green (conformance pass + smoke pass),
yellow (new version not yet tested), red (auth error / quota / smoke fail, with reason).

## 5. Credential Vault

> Note: per-CLI vault env injection is superseded by the router — providers are configured in desktop Settings → Providers, and brain/worker CLIs reach them through the router.

- Storage: OS keychain (Windows Credential Manager / DPAPI) — no plaintext, nothing in the repo.
- Each entry: `{provider, key, base_url?}`. The runner looks it up via the manifest's `spawn_overrides.api_key`.
- UI: a single "Providers" table — configure once, shared by every CLI. This is the key UX selling point.
- On the matrix, the key column shows status (configured / missing), **never the value**.

## 6. Config push — 3 priority levels

| Level | Mechanism | Use when |
|---|---|---|
| 1 (default) | **Spawn-time override**: env/flag at spawn | Everything possible — model, base URL, key, permission. Doesn't touch user config, no restart needed, one model per session |
| 2 | **Managed profile**: write a namespaced section (`[profiles.orchestra-*]`, managed section of opencode.json), show the diff, back up before writing | Auth/base URL that can't be passed at spawn |
| 3 | Touch the user's global config | **Forbidden by default** |

`model_slots` decides how far roles can go inside a CLI: slot present → role assigned within 1 worker;
slot absent → role assigned at the worker level (whole CLI = 1 role, separated by a different worktree).

## 7. TaskBrief — worker input schema

The orchestrator (LLM) fills content into schema'd slots; the runner validates, wrong schema → returned,
never reaches the worker. Settled in discussion: **the orchestrator answers "WHERE, BY WHICH PATTERN,
DONE WHEN" — the worker answers "HOW"**.

```jsonc
{
  "task_id": "task-17",
  "node": "implement",
  "role": "coder",
  "goal": "Add the Momo payment gateway to checkout",
  "files_in_scope": ["src/payment/gateways/**", "src/pages/checkout/**"],  // fence + entry points
  "constraints": ["follow the PaymentGateway adapter (see stripe.ts)", "do not modify src/auth/**"],
  "forbidden_actions": ["git push", "install new packages", "network"],
  "acceptance_criteria": ["momo.spec.green", "unit coverage >= 80%"],      // the gate will grade these — published upfront
  "artifacts_in": ["plan@plan"],          // artifacts from the needs nodes, with ref
  "artifacts_out": ["diff", "self_test_report"],
  "memory": { "inject": ["project_memory", "user_memory"], "hits": ["kb:payment-module"] },
  "budget": { "usd": 2.00, "minutes": 30 },
  "output_mode": "headless_stream_json"    // forced by the manifest, worker may not be interactive
}
```

Validation rules:

| # | Rule |
|---|---|
| B1 | `goal`, `files_in_scope`, `acceptance_criteria` are required and non-empty (brief without a fence → rejected). The `plan` node is the exception — the plan's brief is the original task |
| B2 | `artifacts_out` must match the outputs declared in the corresponding DSL node |
| B3 | `forbidden_actions` must map to a deny pattern/capability (if it can't be mapped → warning, treated as advice only) |
| B4 | The brief is sent with a snapshot into the task record — prompts are always auditable |

## 8. Stream contract — normalized JSONL

Each CLI's adapter converts the native stream (its own format, changing per version) into standard events:

```jsonl
{"t":"session","worker":"codex","session":"s-881","task":"task-17","node":"implement","pid":4021}
{"t":"message","role":"assistant","text":"Reading src/payment/gateways/stripe.ts"}
{"t":"tool_use","tool":"Edit","target":"src/payment/gateways/momo.ts"}
{"t":"tool_result","ok":true}
{"t":"usage","tokens_in":18422,"tokens_out":1204,"usd":0.14,"model":"gpt-5.3-codex"}
{"t":"blocked","code":"path_escape","detail":"write outside worktree: ../orchestra/config.yml"}
{"t":"error","code":"budget_exceeded"}
{"t":"done","exit":0}
```

| Event | Source |
|---|---|
| `session` | emitted by the runner at spawn |
| `message`, `tool_use`, `tool_result` | mapped from each CLI's stream-json |
| `usage` | CLI-native metadata; missing → estimated via tokenizer, marked `estimated: true` |
| `blocked` / `error` | supervisor + CLI native |
| `done` | exit code |

Required for conformance: each event type above must appear at the right time in the test scenario
(§10). The raw native stream is stored alongside (`raw_ref`) — when a CLI changes format, replay it to fix the adapter.

## 9. Permission model — 4 layers

### Layer 1 — Spawn-time flags (from the manifest, by node type)

| Node | mode (sandbox) | allow tools | deny tools | network |
|---|---|---|---|---|
| `plan`, `review` | read-only | Read/Grep/Glob | every write tool | off |
| `implement` | worktree-write | Read/Edit/Write/Bash(test, build) | `git push`, package manager, curl | off unless the node declares `net: true` |
| `verify` | worktree-write | Bash(test) | Edit/Write source (verify only runs tests) | off |
| `run` | n/a | exactly 1 `command` from the DSL | everything else | per node |

### Layer 2 — The filesystem is the real wall

- A worker can only write inside its own worktree; the main branch is out of reach.
- `files_in_scope` maps to **deny globs** at the CLI's flag/sandbox layer (not just in the prompt).
- Merging into main only happens through the orchestrator's merge gate.

### Layer 3 — In-flight supervisor (plain code, parses the stream)

| Signal | Source | Action |
|---|---|---|
| Command matches a deny pattern (`git push`, `rm -rf`, `curl` when net is off, decode-exec...) | `tool_use` event | kill immediately → `{"t":"blocked"}` → node `on_fail` |
| Write outside the worktree | deny globs + FS watcher | blocked at the sandbox; if it still happens → kill |
| Budget/wall clock exceeded | usage + ticker | kill, `error: budget_exceeded` |
| Permission prompt appears in the stream (CLI changed behavior) | pattern match | kill — treated as misconfiguration, escalate `ask_user` with diagnostics |
| Infinite loop (same tool_use repeated N times) | heuristic on the stream | kill, mark `stuck` |

### Layer 4 — After the run

The DSL gate grades real artifacts (doesn't trust the worker's word); cross-CLI review catches the rest.
Every kill/block is logged to episodic with a reason — a feedback signal for Role Policy (tier 7).

## 9b. Two observation sources, blocking at 3 points, hang detection

### Observation — Reported vs Observed

| Source | How | Sees | Blind spot |
|---|---|---|---|
| **Reported** | JSONL stream §8 | message, tool_use, tool_result, usage | only what the CLI reports itself; internal subagents may be summarized |
| **Observed** | FS watcher (chokidar) on the worktree + process tree + `git status` | **real** file changes, real child processes | network is hard to observe directly — patterns in commands + proxy/ETW for cases that need care |

Each worker runs 1 stream reader + 1 FS watcher in parallel from spawn. **Trust Observed over
Reported**: a file changes with no matching `tool_use` in the stream (or vice versa) = anomaly,
flagged immediately, without waiting for the gate.

### Blocking — 3 points in time, the real guarantee is the first

1. **Before execution (main guarantee — capability denial)**: sandbox flags, deny globs, worktree
   isolation, and **the worker holds no credentials** (no git token in env → cannot push
   even if it wants to). CLIs that support hooks (e.g. PreToolUse) → manifest declares `hooks`, the adapter wires them — blocking
   right before the command runs. Verified by the conformance test (case 8).
2. **During the run (safety net)**: stream parser + watcher detect deny patterns / path
   escape / network when `net: off` → kill the process tree via **Job Object** (Windows) — child processes
   die with the parent. Honest about the limits: kill has latency, the command may have finished before
   the kill arrives — this layer guards against CLI behavior changes or config drift, it is not the guarantee layer.
3. **After the run (final word)**: the merge gate. Damage is contained in a worktree that gets discarded — no merge =
   nothing happened. This is the last containment boundary and the reason the worktree architecture isn't only
   about avoiding conflicts.

### Hang detection — 5 signals

| # | Signal | Handling |
|---|---|---|
| 1 | Stream silent > N minutes (threshold per node type) | suspect — cross-check signal 2 to distinguish "thinking for a long time" |
| 2 | Process alive, CPU ≈ 0, no events | waiting for input (classic: a permission prompt surfacing in headless = misconfiguration) → kill + escalate with diagnostics |
| 3 | Same `tool_use` repeated ≥ 5 times with the same result | livelock → kill, mark `stuck`, spawn a fixer with context |
| 4 | Wall clock exceeded (budget V9) | kill, `error: budget_exceeded` |
| 5 | ConPTY buffer full (Windows trap: if output isn't drained, the child process blocks on write) | reader thread always runs, never pauses — prevented on the runner side |

No silent kills: snapshot the last events + classify (hung → retry with a new worker / stuck → fixer /
over-budget → escalate) → log to episodic. Repeated hangs on the same CLI×node pair are a negative signal
for the track record (Role Policy §5).

## 10. Conformance test — badge criteria

Run against the CLI's pinned version, required cases:

1. `version_check` is parseable.
2. Smoke run returns a stream with all required events.
3. A read-only node attempting to write → blocked (no crash, no prompt).
4. A worktree-write node writing outside scope → blocked by deny globs.
5. Spawn-time model override takes effect (usage metadata reflects the correct model).
6. `net: off` → network attempt is blocked.
7. Exit code / artifacts match the node type's contract.
8. Pre-execution hook (manifest declares `hooks`) blocks a command matching a deny pattern **before** it runs.

The registry marks `conformance: pass|fail|untested` per version; an untested CLI update → yellow badge.

## 11. The `fleet.*` toolset for the orchestrator

```
fleet.list()  fleet.install(id)  fleet.update(id)  fleet.auth(id)  fleet.smoke(id, model?)
fleet.dispatch(brief)      → session_id   (validate brief, spawn per manifest)
fleet.poll(session)  fleet.stream(session) fleet.wait(session, timeout)
fleet.kill(session, reason)
fleet.collect(session)     → artifacts per the node contract
fleet.merge(task_ids, order)               → merge DAG + integration test (config.yml §8 of the DSL spec)
```

The orchestrator **has no tool to read the vault** — keys only pass through the runner at spawn (principle §1.5).

## 12. Packaging & distribution

- **Standard**: npm (`npm i -g orchestra-cli`) — matches the agent CLI ecosystem convention.
- **Optional**: background daemon packaged as an exe via `bun build --compile` (users don't need Node installed).
- **Known trap**: `node-pty` is a native addon — test exe packaging from P1 onward; if it breaks,
  split the PTY helper into a separate child process instead of embedding it in the exe.

## 13. Open after v0.1

- Session resume (`claude --resume`, and the equivalent in other CLIs) so retries don't lose context
- Hot-swapping workers mid-run (move a node to another CLI, hand over the transcript)
- Docker/container isolation for workers (`net: true` needs a tighter environment than a worktree)
- Adapter performance telemetry per version (detect CLI format changes before users hit errors)
