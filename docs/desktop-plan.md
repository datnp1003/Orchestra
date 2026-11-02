# Orchestra Desktop — Plan (v0.1)

> English only (canonical).

A standalone desktop application: the full power of Orchestra **without opening VS Code**.
Invariant principle: **the core stays put** — Desktop is just a new shell wrapping the runner/orchestrator
that already works well, exactly as the extension does.

---

## 1. Why Desktop (when the extension already exists)

| Need | Extension | Desktop |
|---|---|---|
| Use inside VS Code | ✓ | — |
| Use standalone (vim/neovim/no IDE) | ✗ | ✓ |
| **Multi-repo dashboard** (several projects at once) | ✗ (1 workspace) | ✓ |
| **Background running + notifications** (pipeline done, gate awaiting approval while you do something else) | ✗ | ✓ tray + toast |
| Install worker CLIs without a terminal | ⚠ (command + terminal) | ✓ full wizard (PATH, login) |
| Embedded terminal to watch workers directly | ✗ | ✓ (node-pty) |
| Distribution to people who don't use VS Code | ✗ | ✓ .exe installer |

Positioning: **extension = light client, Desktop = full client** — same core, same account/vault.

## 2. Shell: Electron first, Tauri considered later

| | Electron (chosen) | Tauri (later) |
|---|---|---|
| Reuse of the Node/TS core | **100%** — main process is Node, imports `prototype/src` as the extension does | Needs a sidecar (bun compile) or a Rust rewrite |
| Bundle size | ~90MB / heavier RAM | ~10MB |
| node-pty, sqlite, spawning CLIs | Native, already works | Via sidecar — complexity of 2 runtimes |
| Ecosystem maturity | electron-builder, auto-update, tray — standard | Good but newer |

Decision: **Electron for v1** — time to ship > size. Tauri is an optimization problem for
P-D4, not now. (Given the project context: 3 weeks to a usable Desktop at the cost of
80MB is a win.)

## 3. Architecture

```
┌────────────────────────── Orchestra Desktop (Electron) ─────────────────────────┐
│ Main process (Node)                                                             │
│   ├── direct core import: runner · dispatch · orchestrator · policy · memory    │
│   │   vault · conformance · models · skillsync   (like the extension, 0 rewrite)│
│   ├── RunnerPool: N concurrent repos (1 workspace state per repo)               │
│   ├── Tray + Notification (gate awaiting approval, pipeline done/failed)        │
│   └── IPC (contextBridge, contextIsolation ON)                                  │
│ Renderer (UI)                                                                   │
│   ├── Dashboard: Fleet + Tasks + Runs (3 existing webviews → 1 page)            │
│   ├── Chat Orchestrator (existing webview → page)                               │
│   ├── Live Transcript + embedded Terminal (node-pty)                            │
│   ├── Policy Matrix (click-promote — unchanged)                                 │
│   ├── Settings UI (replaces settings.json — same orchestra.* schema)            │
│   └── Install Wizard (worker npm + login guided + vault)                        │
└─────────────────────────────────────────────────────────────────────────────────┘
```

> Note: per-CLI vault env and the `models` registry (models.yml) are superseded by the router — providers are configured in desktop Settings → Providers.

Estimated reuse: **core 100% · UI ~80%** (HTML/CSS webviews turned into pages) ·
newly written: IPC layer, tray/notify, multi-repo, embedded terminal, installer config.

## 4. Stages

### P-D1 — A working shell (weeks 1–2) → Desktop MVP
- Scaffold Electron + TypeScript (reuse the extension's mixed-root tsconfig)
- IPC contract: `invoke('fleet:list')`, `invoke('dispatch', brief)`, `on('event', cb)`... —
  every function already exists in logic.ts and only needs wrapping
- First 4 pages: Dashboard · Chat · Transcript · Matrix
- electron-builder → NSIS installer; test install/uninstall on a real machine

**MVP gate:** install the .exe → without opening VS Code → dispatch + pipeline end-to-end from the app →
live transcript. If this gate isn't met within 2 weeks → stop and reassess (risk #1: IPC
is more laborious than the extension webview — mitigated by keeping logic.ts as the only API).

### P-D2 — Real work (week 3)
- Tray + Notification: gates awaiting plan/merge approval, pipeline done/failed, budget 80%
- Multi-repo: repo list (from settings + Recently opened), switch without restart
- Embedded terminal (node-pty) — watch workers like a real terminal; **electron-rebuild for the native module**
- Install Wizard: install worker + guided OAuth login + vault entry — merges 3 separate commands into 1 flow

### P-D3 — Trustworthy enough to distribute (week 4)
- Auto-update (electron-updater + GitHub Releases)
- Full Settings UI (reads/writes exactly the extension's `orchestra.*` schema — shared config)
- macOS/Linux builds + verification (P6 debt) — non-Windows vault fallback (keychain)
- App icon, installer metadata, (optional) code signing — if unsigned, document the SmartScreen steps

### P-D4 — After v1 (week 5+, optional)
- Evaluate Tauri (bun sidecar) if size/memory is a real user problem
- 1-click role-pack install (idea #3 — pack = KB + templates + policy snippet)
- Local dashboard mode (serve the UI over localhost — view from another machine)
- Opt-in telemetry (task success rate, cost) — feeds the Model Registry

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| IPC layer costs more effort than expected | logic.ts is the only API — IPC only wraps, no new logic |
| node-pty + electron ABI | electron-rebuild at the very start of P-D1 (trap recorded since P1) — if it breaks, the embedded Terminal slips to P-D3 |
| SmartScreen blocks the unsigned exe | v0.1 beta: document "More info → Run anyway"; cert in P-D3/P7 |
| Maintaining 2 UIs (extension + desktop) | shared webview HTML files; logic in 1 place; extension stays a light client — no logic cloning |
| UI scope creep | The P-D1 gate is the rule: 4 pages, nothing more |

## 6. Milestone chart

```
Week:     1──────2──────3──────4──────5────→
Stage:    ├──P-D1 (MVP)──┤├─P-D2─┤├─P-D3─┤├─P-D4→
Gate:            installer + E2E     tray/multi-repo  cross-platform
Already in place: core P1–P6 ✓ · 4 webview UIs ✓ · vault/install/conformance ✓
```

~4 weeks solo for the full Desktop. MVP (P-D1) = 2 weeks.

## 7. First tasks (days 1–2)

1. `Orchestra/desktop/`: scaffold Electron + TS (inherit the extension's mixed-root tsconfig)
2. IPC contract file (`ipc.ts`: channel list + types from logic.ts) — written first, code after
3. Dashboard page combining the 3 existing webviews — end-of-week-1 goal: one successful dispatch from Desktop
