English | [Tiếng Việt](README.vi.md)

# Orchestra

Orchestra is an agent **brain** plus a local **LLM router proxy**. You talk only to Orchestra; it
surveys the repo, then hands coding work to agent CLIs (**claude**, **codex**) running as workers
in isolated git worktrees, with deterministic gates, a policy matrix, and project memory.

## Components

```
prototype/   core (TypeScript, no framework): brain, router, runner, dispatch, pipeline, gates,
             policy, memory, vault, conformance, i18n — plus the CLI (dist/cli.js)
desktop/     Electron app (main + vanilla renderer) — reuses prototype/src directly
extension/   VS Code extension — reuses prototype/src directly
docs/        specs, plans, quickstart
```

## Router (`prototype/src/router/`)

A local proxy on `127.0.0.1` (per-start token, Host guard). Desktop starts it automatically; the
brain and every worker CLI talk to the LLM through it.

- **Providers**: `anthropic`, `openai`, `anthropic-compatible`, `openai-compatible`, and **OAuth**
  `oauth-anthropic` / `oauth-openai` (subscription sign-in, PKCE, single-flight refresh). OAuth
  providers require ticking a mandatory risk-acknowledgement warning before they can be used.
  Provider metadata lives in `~/.orchestra/router.json`; API keys live only in the DPAPI vault.
- **Endpoints**: `POST /v1/messages`, `/v1/chat/completions`, `/v1/responses`; `GET /v1/models`
  (merged list as `<provider>/<model>`).
- **Translation**: Messages ⇄ Chat ⇄ Responses, streaming and non-streaming, including tool-call
  round-trips — so codex (Responses API) runs on any provider.
- **Auth sync at spawn** (no CLI config files touched): claude gets one inline `--settings` JSON
  (hooks + env); codex gets `-c model_providers.orch...` plus the router token via env.

## Brain and workers

The brain (`prototype/src/brain.ts`) is Orchestra's own agent loop (Messages API + tool calling).
Tools are tiered: T0 survey (`repo_glob`, `repo_grep`, `repo_read`, `git_diff`, `task_diff`,
`fleet_status`), T1 guarded actions (`fleet_dispatch`, `fleet_pipeline`, `skills_sync`), T2 needs
user approval (`fleet_merge`, `policy_promote`). `fleet_merge` is gated in code: diff review +
`npm test` before the approval modal.

Workers are the **claude** and **codex** CLIs, run headless in a worktree with scope checks, a
PreToolUse guard hook (net/`git push`/path escape), livelock detection, FS cross-check, and
session resume. Routing comes from `policy.yml` + track record (EMA).

## Desktop app (`desktop/`)

- **Chat** with the brain; **Sessions** sidebar resumes past brain conversations
  (`.orchestra/chat/*.jsonl`).
- **Dashboard**: fleet, tasks, live transcript.
- **Settings** tabs: General (repos, language **en/vi**, …), Workers, **Providers** (CRUD, test,
  quick-add, OAuth sign-in), Conformance, Skills, **Policy Matrix**.
- Tray, notifications, auto-update via GitHub Releases.

```bash
cd desktop && npm install && npm run build && npm start
```

## VS Code extension (`extension/`)

Activity-bar views Chat / Fleet / Tasks and commands Dispatch Task, Run Pipeline, Show Policy
Matrix, Review & Merge, Sync Skills, Install Worker. Settings under `orchestra.*`.

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
| `sync-skills <repo>` | render KB → `AGENTS.md` + `CLAUDE.md` |
| `router [--port n] [--default-model p/m]` | run the router standalone |

Language: `--lang en|vi` or `ORCHESTRA_LANG=vi` (default `en`).

## i18n

English and Vietnamese, shared by CLI, core, router, extension and desktop:
`prototype/src/i18n/` (`en.ts`, `vi.ts`, `index.ts`). `vi` is typed against `en`, so a missing key
fails `tsc`; `test/i18n.test.mjs` checks keys and placeholders. Text sent to LLMs/workers stays
English.

## Tests

```bash
cd prototype && npm run build && node --test test/*.test.mjs
cd extension && npm run build && node test/logic.test.mjs && node --test test/brainTools.test.mjs
cd desktop && npm run build && node test/contract.test.mjs && node test/renderer.test.mjs && node test/chatSessions.test.mjs
```

## Docs

- [Quickstart](docs/QUICKSTART.md) ([Tiếng Việt](docs/QUICKSTART.vi.md))
- Specs: [Pipeline DSL](docs/pipeline-dsl-spec.md) · [Worker Protocol](docs/worker-protocol-spec.md) ·
  [Role Policy](docs/role-policy-spec.md) · [Memory Interface](docs/memory-interface-spec.md)
- [Roadmap](docs/roadmap.md) · [Desktop plan](docs/desktop-plan.md) ·
  [Desktop E2E gate](docs/desktop-e2e-gate.md) · [P7 launch kit](docs/p7-launch-kit.md)
