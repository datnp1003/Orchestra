# Orchestra — Quickstart (15 minutes)

English | [Tiếng Việt](QUICKSTART.vi.md)

Orchestra = an IDE agent **orchestrator**: you chat, it plans, then hands work to agent CLIs
(Claude Code, Codex...) running in a gated pipeline that tests itself and cross-reviews before merging.

---

## Step 1 — Install (3 minutes)

**Desktop app** (recommended):
```
Run the installer: desktop/release/Orchestra Desktop Setup 0.2.0.exe
```
**Or the VS Code extension**: install `extension/orchestra-0.2.4.vsix` via Extensions → Install from VSIX.

**Or the CLI** (in a terminal):
```bash
cd Orchestra/prototype && npm install && npm run build
node dist/cli.js list          # show the fleet
```

Requirements: **Node.js ≥ 20** + git. Worker CLIs (claude/codex) are installed from inside the app
(Settings → Workers → Install) — no need to install them beforehand.

## Step 2 — Add a router provider (5 minutes)

The desktop app starts the **Orchestra router** (a local LLM proxy) automatically; the brain and every
worker CLI go through it — no per-CLI login needed. Settings → **Providers** → add a provider:
- **API key / your own gateway**: pick a kind (`anthropic`, `openai`, `*-compatible`), paste the key
  (+ base URL if you use a gateway) → the key is stored only in the vault; CLI configs are untouched.
- **OAuth subscription** (Claude Pro/Max or ChatGPT Plus/Pro): pick an `oauth-*` kind,
  read and tick the risk warning → sign in in the browser → paste the code.

Check: Settings → Workers lists installed CLIs with "Auth: via Orchestra router"; the model dropdown in the
chat composer is populated from the providers you added.

CLI only: `node dist/cli.js router` (providers in `~/.orchestra/router.json`).

## Step 3 — First task (5 minutes)

1. Settings → General → add your repo → pick the active repo in the top-right dropdown
2. **Chat** (recommended): type *"add <feature> to <place>"* — the orchestrator surveys the repo,
   determines the scope, picks a worker → you approve the action
3. The pipeline runs on its own: **plan → implement → verify → review (different CLI) → merge**
4. You only sign off on 2 gates: **approve the plan** (modal) and **merge**

## Step 4 — What you are seeing

| What you see | Meaning |
|---|---|
| `gate ✓ tests.green` | The runner **runs the test suite itself** — it does not trust the worker's word |
| `review: cross-CLI` | A CLI from a different family reviews the code the other CLI wrote — catches bugs self-review misses |
| `scope_check: PASS` | The worker only touched files within the brief's scope |
| Worktree `.orchestra/wt/` | All changes are isolated — they reach main only on merge |

## Step 5 — Advanced configuration

- **Model per role**: `.orchestra/policy.yml` → `bindings.coder[0].worker.model` (or Settings → Policy Matrix)
- **Skills/knowledge**: `.orchestra/kb/*.md` → auto-synced into `AGENTS.md`/`CLAUDE.md` for workers
- **Custom pipeline**: copy `prototype/templates/feature-dev.yml` → `.orchestra/pipelines/`
- **Memory**: task records live in `.orchestra/tasks/`; distill them with `node dist/cli.js retro <repo>`

Full details: `docs/` (4 specs + roadmap + desktop-plan + E2E gate).
