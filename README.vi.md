[English](README.md) | Tiếng Việt

# Orchestra

Orchestra là một **brain** (agent điều phối) kèm một **router proxy LLM** chạy local. Bạn chỉ nói
chuyện với Orchestra; nó khảo sát repo rồi giao việc code cho các agent CLI (**claude**, **codex**)
chạy như worker trong git worktree riêng, có gate deterministic, policy matrix và project memory.

## Thành phần

```
prototype/   core (TypeScript, không framework): brain, router, runner, dispatch, pipeline, gates,
             policy, memory, vault, conformance, i18n — kèm CLI (dist/cli.js)
desktop/     app Electron (main + renderer vanilla) — dùng trực tiếp prototype/src
extension/   extension VS Code — dùng trực tiếp prototype/src
docs/        spec, kế hoạch, quickstart
```

## Router (`prototype/src/router/`)

Proxy local trên `127.0.0.1` (token mỗi lần start, chặn Host lạ). Desktop tự start router; brain
và mọi worker CLI đều gọi LLM qua router.

- **Provider**: `anthropic`, `openai`, `anthropic-compatible`, `openai-compatible`, và **OAuth**
  `oauth-anthropic` / `oauth-openai` (đăng nhập bằng subscription, PKCE, refresh single-flight).
  Provider OAuth bắt buộc tick xác nhận cảnh báo rủi ro trước khi dùng.
  Metadata provider ở `~/.orchestra/router.json`; API key chỉ nằm trong vault DPAPI.
- **Endpoint**: `POST /v1/messages`, `/v1/chat/completions`, `/v1/responses`; `GET /v1/models`
  (danh sách gộp dạng `<provider>/<model>`).
- **Dịch API**: Messages ⇄ Chat ⇄ Responses, cả stream lẫn non-stream, kể cả tool call
  round-trip — nên codex (Responses API) chạy được với mọi provider.
- **Sync auth lúc spawn** (không đụng file config của CLI): claude nhận 1 `--settings` JSON inline
  (hooks + env); codex nhận `-c model_providers.orch...` cộng token router qua env.

## Brain và worker

Brain (`prototype/src/brain.ts`) là agent loop riêng của Orchestra (Messages API + tool calling).
Tool chia tầng: T0 khảo sát (`repo_glob`, `repo_grep`, `repo_read`, `git_diff`, `task_diff`,
`fleet_status`), T1 hành động có guard (`fleet_dispatch`, `fleet_pipeline`, `skills_sync`), T2 cần
user duyệt (`fleet_merge`, `policy_promote`). `fleet_merge` có gate trong code: xem diff +
`npm test` trước khi hiện modal duyệt.

Worker là CLI **claude** và **codex**, chạy headless trong worktree với scope check, guard hook
PreToolUse (net / `git push` / path escape), phát hiện livelock, FS cross-check và session resume.
Chọn worker theo `policy.yml` + track record (EMA).

## App Desktop (`desktop/`)

- **Chat** với brain; sidebar **Sessions** mở lại các hội thoại brain cũ
  (`.orchestra/chat/*.jsonl`).
- **Dashboard**: fleet, task, transcript live.
- Các tab **Cài đặt**: Chung (repo, ngôn ngữ **en/vi**, …), Workers, **Providers** (CRUD, test,
  quick-add, đăng nhập OAuth), Conformance, Skills, **Policy Matrix**.
- Tray, notification, auto-update qua GitHub Releases.

```bash
cd desktop && npm install && npm run build && npm start
```

## Extension VS Code (`extension/`)

View Chat / Fleet / Tasks trên Activity bar và các lệnh Dispatch Task, Run Pipeline, Show Policy
Matrix, Review & Merge, Sync Skills, Install Worker. Setting nằm dưới `orchestra.*`.

## CLI (`prototype/`)

```bash
cd prototype && npm install && npm run build
node dist/cli.js <lệnh>
```

| Lệnh | Mục đích |
|---|---|
| `list` | trạng thái fleet (đã cài / version / auth) |
| `smoke <id> [--save-fixture]` | chạy smoke headless |
| `run <id> "<prompt>"` | chạy 1 prompt, in event JSONL chuẩn hoá |
| `replay <id> <fixture>` | phân tích stream đã ghi (offline) |
| `dispatch <repo> "<goal>" --node … --role … --scope …` | giao 1 task cho worker |
| `run-pipeline <repo> "<goal>" --template … --scope … [--yes]` | chạy pipeline template |
| `tasks <repo>` | liệt kê task record |
| `policy <repo>` | xem policy đã load + bindings |
| `stats <repo> [--dir d]` | fleet stats (EMA) + sync episodic sqlite |
| `feedback <repo> <type> …` | ghi feedback event |
| `retro <repo> [--dir d]` | retrospective → đề xuất (không tự apply) |
| `simulate <repo> <n>` | ghi n task record mô phỏng |
| `conformance <repo> <id> [--with-smoke] [--model m]` | bộ test Worker Protocol §10 |
| `vault <list\|set\|get\|delete\|auth>` | credential vault DPAPI |
| `install <id>` / `uninstall <id>` | cài/gỡ worker qua `npm -g` |
| `sync-skills <repo>` | render KB → `AGENTS.md` + `CLAUDE.md` |
| `router [--port n] [--default-model p/m]` | chạy router độc lập |

Ngôn ngữ: `--lang en|vi` hoặc `ORCHESTRA_LANG=vi` (mặc định `en`).

## i18n

Tiếng Anh và tiếng Việt, dùng chung cho CLI, core, router, extension và desktop:
`prototype/src/i18n/` (`en.ts`, `vi.ts`, `index.ts`). `vi` được type theo `en` nên thiếu key là
`tsc` báo lỗi; `test/i18n.test.mjs` kiểm key và placeholder. Text gửi cho LLM/worker giữ tiếng Anh.

## Test

```bash
cd prototype && npm run build && node --test test/*.test.mjs
cd extension && npm run build && node test/logic.test.mjs && node --test test/brainTools.test.mjs
cd desktop && npm run build && node test/contract.test.mjs && node test/renderer.test.mjs && node test/chatSessions.test.mjs
```

## Tài liệu

- [Quickstart](docs/QUICKSTART.vi.md) ([English](docs/QUICKSTART.md))
- Spec: [Pipeline DSL](docs/pipeline-dsl-spec.md) · [Worker Protocol](docs/worker-protocol-spec.md) ·
  [Role Policy](docs/role-policy-spec.md) · [Memory Interface](docs/memory-interface-spec.md)
- [Roadmap](docs/roadmap.md) · [Desktop plan](docs/desktop-plan.md) ·
  [Desktop E2E gate](docs/desktop-e2e-gate.md) · [P7 launch kit](docs/p7-launch-kit.md)

Tài liệu trong `docs/` viết bằng tiếng Anh (trừ QUICKSTART có bản tiếng Việt).
