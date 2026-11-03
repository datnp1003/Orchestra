# Orchestra — Quickstart (15 minutes)

English | [Tiếng Việt](QUICKSTART.vi.md)

Orchestra = an agent **orchestrator**: you chat, it plans, then hands work to agent CLIs
(Claude Code, Codex) running in a gated pipeline that tests itself and cross-reviews before merging.

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
  read and tick the risk warning → sign in in the browser (Anthropic: paste the code back).

Check: Settings → Workers lists installed CLIs with "Auth: via Orchestra router" (use **Refresh
status** after installing); the model picker in the chat composer lists the providers' models
(type to search).

CLI only: `node dist/cli.js router` (providers in `~/.orchestra/router.json`).

## Step 3 — First task (5 minutes)

1. Pick a **permission mode** in the composer: `plan` (read-only), `ask` (approve every change —
   default), `auto` (ask only for merge / policy / plan), `full` (no questions; merge gates still run).
2. Start a chat:
   - **In a project** (sidebar → Projects → ＋, then add repos on the project page) — the brain sees
     all its repos; or
   - **Outside a project** (sidebar → Chats → ＋) — just name a folder (*"look at D:\code\shop"*);
     the brain asks once to attach it (a folder of several git repos attaches each). Without a folder,
     work happens in the scratch repo `~/.orchestra/workspace`.
3. Type *"add <feature> to <place>"* — the brain surveys the repo, sets the scope, picks a worker.
4. Approve in the **card that appears in the chat** (Enter / Esc). If the window is in the
   background, a Windows toast with Approve / Reject may also appear.
5. Pipelines run on their own: **plan → implement → verify → review (different CLI) → merge**.

## Step 4 — What you are seeing

| What you see | Meaning |
|---|---|
| `gate ✓ tests.green` | The runner **runs the test suite itself** — it does not trust the worker's word |
| `review: cross-CLI` | A CLI from a different family reviews the code the other CLI wrote — catches bugs self-review misses |
| `scope_check: PASS` | The worker only touched files within the brief's scope |
| Worktree `.orchestra/wt/` | All changes are isolated — they reach main only on merge |
| One collapsed line per turn | The turn's tool calls; expand to see each call's input + result |

Dashboard shows the fleet, the 20 most recent tasks and the live transcript.

## Step 5 — Advanced configuration

- **Model per role**: `.orchestra/policy.yml` → `bindings.<role>[n].worker.model` (or Settings → Policy Matrix)
- **Memory**: the brain keeps global (`~/.orchestra/memory.md`) and per-project memory on its own;
  edit them in Settings → General and on the project page
- **Skills**: Settings → Skills (global) or the project page — write one, add from GitHub, or import
  from Claude/Codex
- **Knowledge base**: `.orchestra/kb/*.md` in a repo → relevant entries are recalled into each task brief
- **Custom pipeline**: copy `prototype/templates/feature-dev.yml` into your own folder → set it in
  Settings → General → templates dir
- **Task history**: records live in `.orchestra/tasks/`; distill them with `node dist/cli.js retro <repo>`

Full details: `docs/` (4 specs + roadmap + desktop-plan + E2E gate).
