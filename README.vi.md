[English](README.md) | Tiếng Việt

# Orchestra

Orchestra là một **brain** (agent điều phối) kèm một **router proxy LLM** chạy local. Bạn chỉ nói
chuyện với Orchestra; nó khảo sát repo rồi giao việc code cho các agent CLI (**claude**, **codex**)
chạy như worker trong git worktree riêng, có gate deterministic, policy matrix và memory dài hạn.

## Thành phần

```
prototype/   core (TypeScript, không framework): brain, router, runner, dispatch, pipeline, gates,
             policy, permissions, memory, skills, vault, conformance, i18n — kèm CLI (dist/cli.js)
desktop/     app Electron (main + renderer vanilla) — dùng trực tiếp prototype/src
extension/   extension VS Code — dùng trực tiếp prototype/src
docs/        spec, kế hoạch, quickstart
```

Dữ liệu nằm ở `~/.orchestra/` (đổi bằng `ORCHESTRA_HOME`): `router.json`, `memory.md`, `skills/`,
`chats/`, `workspace/`, `projects/<id>/` (`chat/`, `memory.md`, `skills/`).

## Router (`prototype/src/router/`)

Proxy local trên `127.0.0.1` (token mỗi lần start, chặn Host lạ). Desktop tự start router và tải
trước danh sách model; brain và mọi worker CLI đều gọi LLM qua router.

- **Provider**: `anthropic`, `openai`, `anthropic-compatible`, `openai-compatible`, và **OAuth**
  `oauth-anthropic` / `oauth-openai` (đăng nhập bằng subscription, PKCE, refresh single-flight).
  Provider OAuth bắt buộc tick xác nhận cảnh báo rủi ro trước khi dùng.
  Metadata provider ở `~/.orchestra/router.json`; API key và token chỉ nằm trong vault DPAPI.
- **Endpoint**: `POST /v1/messages`, `/v1/messages/count_tokens`, `/v1/chat/completions`,
  `/v1/responses`; `GET /v1/models` (danh sách gộp dạng `<provider>/<model>`).
- **Dịch API**: Messages ⇄ Chat ⇄ Responses, cả stream lẫn non-stream, kể cả tool call
  round-trip — nên codex (Responses API) chạy được với mọi provider.
- **Chuẩn hoá non-stream**: upstream trả sai format cho request passthrough (vd. gateway trả
  `chat.completion` cho `/v1/messages`) thì router tự chuyển đổi.
- **Sync auth lúc spawn** (không đụng file config của CLI): claude nhận 1 `--settings` JSON inline
  (hooks + env); codex nhận `-c model_providers.orch...` cộng token router qua env.

## Brain và worker

Brain (`prototype/src/brain.ts`) là agent loop riêng của Orchestra (Messages API + tool calling).

- **Khảo sát**: `repo_glob`, `repo_grep`, `repo_read`, `git_diff`, `task_diff`, `fleet_status`.
- **Hành động**: `fleet_dispatch` (1 task; `readonly: true` cho việc khảo sát/review),
  `fleet_pipeline` (`feature-dev` | `hotfix`); cả hai nhận `skills`.
- **Cần duyệt**: `fleet_merge` (code kiểm task, scope và `npm test` trước khi hỏi), `policy_promote`.
- **Luôn có**: `memory_update`. Ngoài project có thêm `repo_attach` (xem dưới).
- Project nhiều repo: mọi repo tool nhận tên `repo`.

Worker là CLI **claude** và **codex**, chạy headless trong worktree (`.orchestra/wt/`) với scope
check, guard hook PreToolUse (net / `git push` / path escape), phát hiện livelock, FS cross-check và
session resume. Chọn worker theo `policy.yml` + track record (EMA). Mỗi lần dispatch, các entry
`.orchestra/kb/*.md` liên quan được đưa vào brief.

## Chế độ quyền

Chọn ở khung chat; chặn ở tầng tool, không chỉ dặn trong prompt.

| Hành động | plan | ask | auto | full |
|---|---|---|---|---|
| Dispatch / pipeline sửa code | chặn | hỏi | cho phép | cho phép |
| Merge, đổi policy | chặn | hỏi | hỏi | cho phép |
| Gắn repo | hỏi | hỏi | cho phép | cho phép |
| Duyệt plan của pipeline | hỏi | hỏi | hỏi | cho phép |

Ở `plan` chỉ chạy khảo sát và dispatch read-only. Ở `full` gate merge (task ok, scope ok, test pass)
vẫn áp dụng. Mode lạ → coi như `ask`.

Yêu cầu duyệt hiện thành **thẻ ngay trong chat** (Enter = duyệt, Esc = từ chối khi thẻ đang focus).
Khi cửa sổ không focus, Windows hiện thêm toast có nút Approve / Reject qua protocol `orchestra://`
— best-effort; thẻ trong chat mới là nguồn chính.

## Project, chat và memory

- **Project** gom một hoặc nhiều repo. Chat trong project thấy repo, memory và skill của project đó.
- **Chat ngoài project** vẫn gọi worker: chạy trong repo scratch `~/.orchestra/workspace` (tự tạo
  lần đầu dùng). Khi bạn nhắc tới một thư mục local, brain gọi `repo_attach`; bạn duyệt 1 lần (tuỳ
  chế độ quyền) và thư mục được gắn — git repo thành 1 repo, thư mục chứa nhiều git repo (vd.
  microservice) thì gắn từng repo (sâu tối đa 3 cấp; bỏ thư mục ẩn, `node_modules`, output build).
  Repo đã gắn được nhớ kèm session (`<session>.repos.json`).
- **Memory**: chung `~/.orchestra/memory.md` (sở thích user, fact chung; ~3000 ký tự) và theo
  project `projects/<id>/memory.md` (~5000 ký tự). Brain ghi qua `memory_update`; reflection chạy
  nền cũng rút fact sau các tool call nặng, mỗi 4 lượt user và khi đổi session. Vượt giới hạn →
  model gộp lại file. Secret bị che trước mỗi lần ghi. Cả hai file sửa được trong app.
- Chat ngoài project chỉ thấy memory chung.

## Skill (`prototype/src/skills.ts`)

Mỗi skill là một thư mục có `SKILL.md` (frontmatter `name`, `description` ≤ 1024 ký tự, `tags`,
`workers` tuỳ chọn) kèm file phụ. Phạm vi: global (`~/.orchestra/skills`) và theo project (đè global
cùng tên). Nguồn: tự viết, **cài từ GitHub** (preview, chọn, ghim commit, kiểm tra cập nhật), hoặc
**nhập từ Claude/Codex** (`~/.claude/skills`, `~/.codex/skills`). Khi dispatch, claude nhận skill
trong `.claude/skills/` của worktree, codex nhận trong prompt. Orchestra chỉ copy script của skill,
không bao giờ chạy.

## App Desktop (`desktop/`)

- **Sidebar**: Project (kèm session của từng project) và Chat ngoài project; trang project để sửa
  tên, repo, memory, skill và xem KB (chỉ đọc).
- **Chat** với brain: chọn model có ô tìm kiếm, chọn chế độ quyền, thẻ duyệt, tool call mỗi lượt
  gộp thành 1 dòng thu gọn/mở rộng (mỗi call mở xem input + kết quả), màn chat trống gọn.
- **Dashboard**: fleet, form dispatch / pipeline, 20 task mới nhất kèm transcript.
- Các tab **Cài đặt**: Chung (ngôn ngữ **en/vi**, thư mục template, tự duyệt plan, guard hook, kiểm
  tra cập nhật, memory chung), Workers (cài đặt, **Kiểm tra lại**), **Providers** (CRUD, test,
  quick-add, đăng nhập OAuth), Skills, **Policy Matrix**. Tab Conformance đang ẩn (badge vẫn ở
  Dashboard).
- Trạng thái fleet lấy từ cache được probe nền, nên chuyển trang không bị đơ.
- Tray, notification, auto-update qua GitHub Releases.

```bash
cd desktop && npm install && npm run build && npm start
```

## Extension VS Code (`extension/`)

View Chat / Fleet / Tasks trên Activity bar và các lệnh Dispatch Task, Run Pipeline, Show Policy
Matrix, Review & Merge, Install Worker, Refresh. Setting nằm dưới `orchestra.*`.

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
| `router [--port n] [--default-model p/m]` | chạy router độc lập |

Ngôn ngữ: `--lang en|vi` hoặc `ORCHESTRA_LANG=vi` (mặc định `en`).

## i18n

Tiếng Anh và tiếng Việt, dùng chung cho CLI, core, router, extension và desktop:
`prototype/src/i18n/` (`en.ts`, `vi.ts`, `index.ts`). `vi` được type theo `en` nên thiếu key là
`tsc` báo lỗi; `test/i18n.test.mjs` kiểm key và placeholder. Text gửi cho LLM/worker giữ tiếng Anh.

## Test

Build từng package trước (`npm run build`).

```bash
# prototype — unit test, không cần mạng
cd prototype && node --test test/*.test.mjs

# extension
cd extension && node --test test/brainTools.test.mjs
cd extension && node test/logic.test.mjs   # cần cài claude + codex; chạy 1 lượt claude THẬT (tốn token)
cd extension && npm test                   # integration test VS Code (dùng VS Code đã cài trên máy)

# desktop — node thường, không cần Electron
cd desktop && node test/contract.test.mjs && node test/renderer.test.mjs && node test/chatSessions.test.mjs && node test/fleetCache.test.mjs
cd desktop && node test/e2e-headless.mjs   # gọi model thật (~$1)
```

## Tài liệu

- [Quickstart](docs/QUICKSTART.vi.md) ([English](docs/QUICKSTART.md))
- Spec: [Pipeline DSL](docs/pipeline-dsl-spec.md) · [Worker Protocol](docs/worker-protocol-spec.md) ·
  [Role Policy](docs/role-policy-spec.md) · [Memory Interface](docs/memory-interface-spec.md)
- [Roadmap](docs/roadmap.md) · [Desktop plan](docs/desktop-plan.md) ·
  [Desktop E2E gate](docs/desktop-e2e-gate.md) · [P7 launch kit](docs/p7-launch-kit.md)

Tài liệu trong `docs/` viết bằng tiếng Anh (trừ QUICKSTART có bản tiếng Việt).
