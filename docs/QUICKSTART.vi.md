# Orchestra — Quickstart (15 phút)

[English](QUICKSTART.md) | Tiếng Việt

Orchestra = agent **orchestrator**: bạn chat, nó lập plan, giao việc cho các agent CLI
(Claude Code, Codex) chạy trong pipeline có gate, tự test, tự review chéo, rồi mới merge.

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
(Cài đặt → Workers → Cài) — không cần cài trước.

## Bước 2 — Thêm provider cho router (5 phút)

Desktop tự chạy **Orchestra router** (LLM proxy local); brain + mọi worker CLI đi qua router —
không cần đăng nhập từng CLI. Cài đặt → **Providers** → thêm provider:
- **API key / gateway riêng**: chọn kind (`anthropic`, `openai`, `*-compatible`), dán key
  (+ base URL nếu dùng gateway) → key chỉ lưu trong vault, không đụng config CLI.
- **OAuth subscription** (gói Claude Pro/Max hoặc ChatGPT Plus/Pro): chọn kind `oauth-*`,
  đọc và tick cảnh báo rủi ro → đăng nhập trên trình duyệt (Anthropic: dán code lại vào app).

Kiểm tra: Cài đặt → Workers hiện CLI đã cài kèm "Auth: qua Orchestra router" (bấm **Kiểm tra lại**
sau khi cài); ô chọn model trong khung chat liệt kê model của các provider (gõ để tìm).

CLI thuần: `node dist/cli.js router` (providers ở `~/.orchestra/router.json`).

## Bước 3 — Task đầu tiên (5 phút)

1. Chọn **chế độ quyền** ở khung chat: `plan` (chỉ đọc), `ask` (duyệt mọi thay đổi — mặc định),
   `auto` (chỉ hỏi khi merge / đổi policy / duyệt plan), `full` (không hỏi; gate merge vẫn chạy).
2. Mở chat:
   - **Trong project** (sidebar → Projects → ＋, rồi thêm repo ở trang project) — brain thấy mọi
     repo của project; hoặc
   - **Ngoài project** (sidebar → Chats → ＋) — chỉ cần nhắc thư mục (*"xem D:\code\shop"*); brain
     hỏi 1 lần để gắn (thư mục chứa nhiều git repo thì gắn từng repo). Không nhắc thư mục thì làm
     trong repo scratch `~/.orchestra/workspace`.
3. Gõ *"thêm <tính năng> vào <chỗ>"* — brain tự khảo sát repo, xác định scope, chọn worker.
4. Duyệt bằng **thẻ hiện ngay trong chat** (Enter / Esc). Nếu cửa sổ đang ở nền, Windows có thể hiện
   thêm toast có nút Approve / Reject.
5. Pipeline tự chạy: **plan → implement → verify → review (CLI khác) → merge**.

## Bước 4 — Hiểu gì đang chạy

| Thứ bạn thấy | Nghĩa là |
|---|---|
| `gate ✓ tests.green` | Runner **tự chạy test suite** — không tin lời worker |
| `review: cross-CLI` | CLI khác họ review code cho CLI viết — bắt bug mà self-review bỏ sót |
| `scope_check: PASS` | Worker chỉ được chạm file trong phạm vi brief |
| Worktree `.orchestra/wt/` | Mọi thay đổi cách ly — merge mới vào main |
| Mỗi lượt 1 dòng thu gọn | Các tool call của lượt đó; mở ra xem input + kết quả từng call |

Dashboard hiện fleet, 20 task mới nhất và transcript live.

## Bước 5 — Cấu hình nâng cao

- **Model theo role**: `.orchestra/policy.yml` → `bindings.<role>[n].worker.model` (hoặc Cài đặt → Policy Matrix)
- **Memory**: brain tự giữ memory chung (`~/.orchestra/memory.md`) và memory theo project; sửa ở
  Cài đặt → Chung và trang project
- **Skill**: Cài đặt → Skills (global) hoặc trang project — tự viết, thêm từ GitHub, hoặc nhập từ
  Claude/Codex
- **Knowledge base**: `.orchestra/kb/*.md` trong repo → entry liên quan được đưa vào brief mỗi task
- **Pipeline riêng**: copy `prototype/templates/feature-dev.yml` vào thư mục của bạn → đặt ở
  Cài đặt → Chung → thư mục template
- **Lịch sử task**: record ở `.orchestra/tasks/`, chưng cất bằng `node dist/cli.js retro <repo>`

Chi tiết đầy đủ: `docs/` (4 spec + roadmap + desktop-plan + E2E gate).
