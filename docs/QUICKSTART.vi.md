# Orchestra — Quickstart (15 phút)

[English](QUICKSTART.md) | Tiếng Việt

Orchestra = IDE agent **orchestrator**: bạn chat, nó lập plan, giao việc cho các agent CLI
(Claude Code, Codex...) chạy trong pipeline có gate, tự test, tự review chéo, rồi mới merge.

---

## Bước 1 — Cài (3 phút)

**Desktop app** (khuyên dùng):
```
Chạy installer: desktop/release/Orchestra Desktop Setup 0.2.0.exe
```
**Hoặc VS Code extension**: cài `extension/orchestra-0.2.4.vsix` qua Extensions → Install from VSIX.

**Hoặc CLI** (dùng trong terminal):
```bash
cd Orchestra/prototype && npm install && npm run build
node dist/cli.js list          # xem fleet
```

Yêu cầu máy: **Node.js ≥ 20** + git. Worker CLI (claude/codex) cài ngay trong app
(Settings → Workers → Install) — không cần cài trước.

## Bước 2 — Thêm provider cho router (5 phút)

Desktop tự chạy **Orchestra router** (LLM proxy local); brain + mọi worker CLI đi qua router —
không cần đăng nhập từng CLI. Settings → **Providers** → thêm provider:
- **API key / gateway riêng**: chọn kind (`anthropic`, `openai`, `*-compatible`), dán key
  (+ base URL nếu dùng gateway) → key chỉ lưu trong vault, không đụng config CLI.
- **OAuth subscription** (gói Claude Pro/Max hoặc ChatGPT Plus/Pro): chọn kind `oauth-*`,
  đọc và tick cảnh báo rủi ro → đăng nhập trên trình duyệt → dán code.

Kiểm tra: Settings → Workers hiện CLI đã cài kèm "Auth: qua Orchestra router"; model dropdown trong
khung chat lấy từ provider đã thêm.

CLI thuần: `node dist/cli.js router` (providers ở `~/.orchestra/router.json`).

## Bước 3 — Task đầu tiên (5 phút)

1. Settings → Chung → thêm repo của bạn → chọn repo active ở dropdown góc trên
2. **Chat** (khuyên dùng): gõ *"thêm <tính năng> vào <chỗ>*" — orchestrator tự khảo sát repo,
   tự xác định scope, tự chọn worker → bấm duyệt action
3. Pipeline tự chạy: **plan → implement → verify → review (CLI khác) → merge**
4. Bạn chỉ chốt 2 cổng: **duyệt plan** (modal) và **merge**

## Bước 4 — Hiểu gì đang chạy

| Thứ bạn thấy | Nghĩa là |
|---|---|
| `gate ✓ tests.green` | Runner **tự chạy test suite** — không tin lời worker |
| `review: cross-CLI` | CLI khác họ review code cho CLI viết — bắt bug mà self-review bỏ sót |
| `scope_check: PASS` | Worker chỉ được chạm file trong phạm vi brief |
| Worktree `.orchestra/wt/` | Mọi thay đổi cách ly — merge mới vào main |

## Bước 5 — Cấu hình nâng cao

- **Model theo role**: `.orchestra/policy.yml` → `bindings.coder[0].worker.model` (hoặc Settings → Policy Matrix)
- **Skill/knowledge**: `.orchestra/kb/*.md` → tự sync thành `AGENTS.md`/`CLAUDE.md` cho worker
- **Pipeline riêng**: copy `prototype/templates/feature-dev.yml` → `.orchestra/pipelines/`
- **Memory**: task records ở `.orchestra/tasks/`, chưng cất bằng `node dist/cli.js retro <repo>`

Chi tiết đầy đủ: `docs/` (4 spec + roadmap + desktop-plan + E2E gate).
