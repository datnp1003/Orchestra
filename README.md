English | [Tiếng Việt](README.vi.md)

# Orchestra

Orchestra is an agent **brain** plus a local **LLM router proxy**. You talk only to Orchestra; it
surveys your repos, then hands coding work to agent CLIs (**claude**, **codex**) running as workers
in isolated git worktrees, with deterministic gates, a policy matrix, and long-term memory.

## Components

```
prototype/   core (TypeScript, no framework): brain, router, runner, dispatch, pipeline, gates,
             policy, permissions, memory, skills, vault, conformance, i18n — plus the CLI (dist/cli.js)
desktop/     Electron app (main + vanilla renderer) — reuses prototype/src directly
extension/   VS Code extension — reuses prototype/src directly
docs/        specs, plans, quickstart
```

Data lives in `~/.orchestra/` (override with `ORCHESTRA_HOME`): `router.json`, `memory.md`,
`skills/`, `chats/`, `workspace/`, `projects/<id>/` (`chat/`, `memory.md`, `skills/`).

## Router (`prototype/src/router/`)

A local proxy on `127.0.0.1` (per-start token, Host guard). Desktop starts it automatically and
prefetches the model list; the brain and every worker CLI talk to the LLM through it.

- **Providers**: `anthropic`, `openai`, `anthropic-compatible`, `openai-compatible`, and **OAuth**
  `oauth-anthropic` / `oauth-openai` (subscription sign-in, PKCE, single-flight refresh). OAuth
  providers require ticking a mandatory risk-acknowledgement warning before they can be used.
  Provider metadata lives in `~/.orchestra/router.json`; API keys and tokens live only in the DPAPI vault.
- **Endpoints**: `POST /v1/messages`, `/v1/messages/count_tokens`, `/v1/chat/completions`,
  `/v1/responses`; `GET /v1/models` (merged list as `<provider>/<model>`).
- **Translation**: Messages ⇄ Chat ⇄ Responses, streaming and non-streaming, including tool-call
  round-trips — so codex (Responses API) runs on any provider.
- **Non-stream normalization**: if an upstream answers a passthrough request in the wrong format
  (e.g. a gateway returning `chat.completion` for `/v1/messages`), the router converts it.
- **Auth sync at spawn** (no CLI config files touched): claude gets one inline `--settings` JSON
  (hooks + env); codex gets `-c model_providers.orch...` plus the router token via env.

## Brain and workers

The brain (`prototype/src/brain.ts`) is Orchestra's own agent loop (Messages API + tool calling).

- **Survey**: `repo_glob`, `repo_grep`, `repo_read`, `git_diff`, `task_diff`, `fleet_status`.
- **Act**: `fleet_dispatch` (one task; `readonly: true` for survey/review work), `fleet_pipeline`
  (`feature-dev` | `hotfix`); both take `skills`.
- **Approval-gated**: `fleet_merge` (code checks the task, scope and `npm test` before asking),
  `policy_promote`.
- **Always available**: `memory_update`. Outside a project also `repo_attach` (see below).
- In a multi-repo project every repo tool takes a `repo` name.

Workers are the **claude** and **codex** CLIs, run headless in a worktree (`.orchestra/wt/`) with
scope checks, a PreToolUse guard hook (net / `git push` / path escape), livelock detection, FS
cross-check and session resume. Routing comes from `policy.yml` + track record (EMA). Each dispatch
gets relevant `.orchestra/kb/*.md` entries recalled into its brief.

## Permission modes

Picked in the chat composer; enforced at the tool layer, not just in the prompt.

| Action | plan | ask | auto | full |
|---|---|---|---|---|
| Code-changing dispatch / pipeline | blocked | ask | allow | allow |
| Merge, policy change | blocked | ask | ask | allow |
| Repo attach | ask | ask | allow | allow |
| Pipeline plan approval | ask | ask | ask | allow |

In `plan` only survey and read-only dispatch run. In `full` the merge gates (task ok, scope ok,
tests pass) still apply. An unknown mode falls back to `ask`.

Approvals appear as **cards in the chat** (Enter = approve, Esc = reject when the card is focused).
When the window is not focused, Windows also shows a toast with Approve / Reject buttons via the
`orchestra://` protocol — best-effort; the in-chat card is the source of truth.

## Projects, chats and memory

- A **project** groups one or more repos. Chats started in a project see its repos, its memory
  and its skills.
- **Chats outside a project** still use workers: they run in a scratch git repo
  `~/.orchestra/workspace` (created on first use). When you name a local folder, the brain calls
  `repo_attach`; you approve once (per permission mode), and the folder is attached — a git repo as
  one repo, a folder of several git repos (e.g. microservices) as each of them (up to 3 levels deep;
  hidden dirs, `node_modules`, build output skipped). Attached repos are remembered with the session
  (`<session>.repos.json`).
- **Memory**: global `~/.orchestra/memory.md` (user preferences, general facts; ~3000 chars) and
  per-project `projects/<id>/memory.md` (~5000 chars). The brain writes via `memory_update`; a
  background reflection also extracts facts after heavy tool calls, every 4 user turns, and when a
  session is switched. Over budget → the model consolidates the file. Secrets are redacted before
  every write. Both files are editable in the app.
- Chats outside a project only see global memory.

## Skills (`prototype/src/skills.ts`)

A skill is a folder with `SKILL.md` (frontmatter `name`, `description` ≤ 1024 chars, optional
`tags`, `workers`) plus optional files. Scopes: global (`~/.orchestra/skills`) and per-project
(overrides global by name). Sources: write your own, **install from GitHub** (preview, pick, pinned
to a commit, update check), or **import from Claude/Codex** (`~/.claude/skills`, `~/.codex/skills`).
On dispatch, claude gets them in the worktree's `.claude/skills/`, codex gets them in the prompt.
Skill scripts are copied, never executed by Orchestra.

## Desktop app (`desktop/`)

- **Sidebar**: Projects (each with its sessions) and Chats outside projects; project page for name,
  repos, memory, skills and read-only KB.
- **Chat** with the brain: model picker with search, permission-mode picker, approval cards, the
  tool calls of each turn grouped into one collapsible line (each call expands to input + result),
  compact empty-chat screen.
- **Dashboard**: fleet, dispatch / pipeline forms, the 20 most recent tasks and their transcript.
- **Settings** tabs: General (language **en/vi**, templates dir, auto-approve plan, guard hook,
  update check, global memory), Workers (install, **Refresh status**), **Providers** (CRUD, test,
  quick-add, OAuth sign-in), Skills, **Policy Matrix**. The Conformance tab is hidden (badge still on
  the Dashboard).
- Fleet status comes from a cache probed in the background, so switching pages never blocks.
- Tray, notifications, auto-update via GitHub Releases.

```bash
cd desktop && npm install && npm run build && npm start
```

## VS Code extension (`extension/`)

Activity-bar views Chat / Fleet / Tasks and commands Dispatch Task, Run Pipeline, Show Policy
Matrix, Review & Merge, Install Worker, Refresh. Settings under `orchestra.*`.

## CLI (`prototype/`)

```bash
cd prototype && npm install && npm run build
node dist/cli.js <command>
```

| Command | Purpose |
|---|---|
| `list` | fleet status (installed / version / auth) |
| `smoke <id> [--save-fixture]` | headless smoke run |
| `run <id> "<prompt>"` | run one prompt, print normalized JSONL events |
| `replay <id> <fixture>` | analyze a recorded stream offline |
| `dispatch <repo> "<goal>" --node … --role … --scope …` | dispatch one task to a worker |
| `run-pipeline <repo> "<goal>" --template … --scope … [--yes]` | run a pipeline template |
| `tasks <repo>` | list task records |
| `policy <repo>` | show loaded policy + bindings |
| `stats <repo> [--dir d]` | fleet stats (EMA) + sync episodic sqlite |
| `feedback <repo> <type> …` | record a feedback event |
| `retro <repo> [--dir d]` | retrospective → proposals (never auto-applied) |
| `simulate <repo> <n>` | write n simulated task records |
| `conformance <repo> <id> [--with-smoke] [--model m]` | Worker Protocol §10 suite |
| `vault <list\|set\|get\|delete\|auth>` | DPAPI credential vault |
| `install <id>` / `uninstall <id>` | install/remove a worker via `npm -g` |
| `router [--port n] [--default-model p/m]` | run the router standalone |

Language: `--lang en|vi` or `ORCHESTRA_LANG=vi` (default `en`).

## i18n

English and Vietnamese, shared by CLI, core, router, extension and desktop:
`prototype/src/i18n/` (`en.ts`, `vi.ts`, `index.ts`). `vi` is typed against `en`, so a missing key
fails `tsc`; `test/i18n.test.mjs` checks keys and placeholders. Text sent to LLMs/workers stays
English.

## Tests

Build each package first (`npm run build`).

```bash
# prototype — unit tests, no network
cd prototype && node --test test/*.test.mjs

# extension
cd extension && node --test test/brainTools.test.mjs
cd extension && node test/logic.test.mjs   # needs claude + codex installed; runs a REAL claude turn (costs tokens)
cd extension && npm test                   # VS Code integration test (uses the locally installed VS Code)

# desktop — plain node, no Electron
cd desktop && node test/contract.test.mjs && node test/renderer.test.mjs && node test/chatSessions.test.mjs && node test/fleetCache.test.mjs
cd desktop && node test/e2e-headless.mjs   # real model calls (~$1)
```

## Docs

- [Quickstart](docs/QUICKSTART.md) ([Tiếng Việt](docs/QUICKSTART.vi.md))
- Specs: [Pipeline DSL](docs/pipeline-dsl-spec.md) · [Worker Protocol](docs/worker-protocol-spec.md) ·
  [Role Policy](docs/role-policy-spec.md) · [Memory Interface](docs/memory-interface-spec.md)
- [Roadmap](docs/roadmap.md) · [Desktop plan](docs/desktop-plan.md) ·
  [Desktop E2E gate](docs/desktop-e2e-gate.md) · [P7 launch kit](docs/p7-launch-kit.md)

## License

[MIT](LICENSE)
