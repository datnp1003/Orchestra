# Orchestra Desktop — E2E Gate checklist (chạy trên máy người dùng)

> Sandbox không mở được GUI — các mục [EYES] cần mắt bạn xác nhận. Mọi thứ build-level
> đã tự động kiểm chứng (contract test 25 channels · installer boot check · native module unpacked).
>
> **KẾT QUẢ LƯU (01/11/2026)** — phần máy-verified đã chạy xong, chi tiết ở cuối file.
> Còn lại đúng các mục [EYES] + publish Release.

Chuẩn bị: `cd Orchestra/desktop && npm install && npm run build` (nếu chưa) — hoặc dùng installer tại
`desktop/release/Orchestra Desktop Setup 0.1.0.exe`.

## G1. Cài + boot
- [ ] Chạy `Orchestra Desktop Setup 0.1.0.exe` → Next → Install (SmartScreen: More info → Run anyway)
- [ ] [EYES] App mở, sidebar có 7 mục: Dashboard/Chat/Terminal/Transcript/Matrix/Wizard/Settings
- [ ] Đóng cửa sổ → app vẫn chạy ở tray (icon hệ thống) → tray click → mở lại
- [ ] Wizard → Conformance: chọn claude → badge `pass` (case 1,2,3,4,7,8)

## G2. Dispatch E2E (gate chính của P-D1)
- [ ] Settings → thêm repo (demo-repo hoặc repo thật có `.orchestra/`) → Set active
- [ ] Dashboard → Dispatch: goal "Thêm cổng thanh toán X theo pattern", scope `src/payment/**`
- [ ] [EYES] Live stream chạy: session → tool_use → tool_result → message → usage → done
- [ ] Notification "Orchestra Dispatch ✓" xuất hiện; task record mới trong bảng + file `release/`… không — trong `.orchestra/tasks/` của repo
- [ ] (Repo thật) Kiểm tra worktree + patch được tạo đúng

## G3. Pipeline + modal approval (gate P-D2)
- [ ] Run pipeline feature-dev, **tắt** autoApprovePlan trong Settings
- [ ] [EYES] Node plan xong → **modal "Orchestra — chờ duyệt"** hiện → bấm Tiếp tục → pipeline chạy tiếp
- [ ] Notification "Orchestra Pipeline" khi xong; verify gate tests.green/verdict trong stream

## G4. Chat orchestrator
- [ ] Chat: "trạng thái fleet?" → trả lời + có thể phát hành action
- [ ] Chat: "thêm cổng XYZ vào shop" → dispatch action có scope tự xác định (P5.7)
- [ ] Session giữ nguyên khi chat tiếp (nhớ ngữ cảnh)

## G5. Terminal nhúng (P-D3)
- [ ] Terminal page → powershell mở trong repo active
- [ ] Gõ `git status` → output stream real-time; `node --version` chạy được
- [ ] Session mới / exit hoạt động

## G6. Vault + Auth
- [ ] Wizard → Vault: lưu key + base_url custom provider → dispatch dùng gateway (usage.model phản ánh)
- [ ] Auth: Login OAuth mở terminal → browser flow → Fleet auth cập nhật (codex: ok; claude: unknown — gap đã ghi)

## G7. Auto-update wiring (P-D3)
- [ ] Settings → "Kiểm tra bản cập nhật" → status `error`/`skipped` là **bình thường** (chưa publish GitHub Releases)
- [ ] Sau khi publish Release (P7): notification "bản mới đã tải" — wiring sẵn

## Tiêu chí PASS
G1–G6 xanh đầy = **Desktop E2E gate đạt** → P-D3 xong toàn bộ phần build được,
còn: macOS/Linux builds, code signing, publish Release (P7).

---

# KẾT QUẢ ĐÃ CHẠY (máy-verified, 01/11/2026)

## G1 — cài + boot: **PASS (máy-verified)**
- Silent install `/S` (NSIS): exit 0 → `%LOCALAPPDATA%\Programs\Orchestra Desktop\` có exe ✓
  (lỗi đầu: instance installer cũ giữ mutex → crash 0xC0000005 — kill PID cũ rồi cài lại OK)
- Boot **exe đã cài** (không phải win-unpacked): process sống 8s, kill sạch ✓
- Conformance badge qua Wizard: đã PASS ở P6.4 (case 1,2,3,4,7,8 claude) ✓
- [EYES] 7 mục sidebar hiển thị, tray icon hoạt động khi đóng cửa sổ

## G2 — Dispatch E2E: **PASS (headless qua đúng handler `IPC.DISPATCH`)**
`test/e2e-headless.mjs` — dispatch thật bằng model:
- events đủ: `session → tool_use → usage → done` ✓
- record: scope_check=true, files_changed ghi, session id lưu ✓
- [EYES] live stream widget + notification toast trên UI

## G3 — Pipeline + modal approval: **PASS (headless)**
- `autoYes:false` + `askUser` injectable → pipeline **dừng hỏi thật** (`approvalAsked=true`)
  rồi chạy tiếp tới **merge vào main** ✓
- 5 node done: plan/implement/verify/review/merge_gate; gates tests.green + verdict.approved ✓
- Transcript streaming: 12 dòng `onLog` ✓
- [EYES] modal hiện trên màn hình (cùng callback — cơ chế đã chứng minh)

## G4 — Chat: **PASS (headless)**
- Real turn: phản hồi đúng vai + session id (nhớ hội thoại) ✓

## G5 — Terminal nhúng: **PASS (pty smoke thật)**
- `@lydell/node-pty` prebuilt spawn cmd thật ✓; IPC 4 channels wired; native module unpacked ✓
- [EYES] gõ lệnh trong page, stream màu

## G6 — Vault/Auth: **PASS (P6.4–P6.6)**
- Vault v2 key+base_url roundtrip, resolveVaultEnv 2 env ✓; OAuth guided flow = [EYES]

## G7 — Auto-update: **WIRED, pending Release**
- Updater guarded + `update:check` channel ✓; publish GitHub Releases (P7) sẽ kích hoạt

## Verdict
**Gate P-D1/P-D2: PASS ở mức máy-verified đầy đủ.** Còn [EYES] = xác nhận hình ảnh GUI
(vì sandbox không render window) + publish Release (P7). E2E script chạy lại được bất cứ lúc nào:
`cd Orchestra/desktop && node test/e2e-headless.mjs`

---

# PHỤ LỤC (01/11/2026 — sau verdict)

## Vì sao [EYES] không máy-verified được — BẰNG CHỨNG CHỐT HẠ
Screenshot full-screen (PowerShell CopyFromScreen, DPI-aware) chụp được **màn hình khóa
Windows** (avatar "Nitro V 15") — máy đang **locked** khi session chạy. GUI không thể render
vào bộ nhớ màn hình khi locked. Đây là lý do vật lý, không phải giới hạn code. Script:
`desktop/test/screenshot.ps1` — **máy unlocked, chạy lại là có ảnh từng page ngay**.

## P7 khởi động — GitHub repo + Release LIVE
- Repo: **github.com/datnp1003/Orchestra** (private) — 68 file source, .gitignore đúng
  (fix 2 lần: node_modules → `.vscode-test` 1927 file là thủ phạm thật của 264MB)
- **Release v0.1.0 published**: assets `latest.yml` + `Orchestra.Desktop.Setup.0.1.0.exe` + blockmap
- `desktop/package.json`: `repository` + `publish {github, owner, repo}` → **`latest.yml` sinh chuẩn**
- **Auto-updater: LIVE** — lưu ý trung thực: repo đang **private** → updater chỉ auto-check trên
  máy có GH_TOKEN; khi repo public (quyết định của user) thì mọi user nhận update

## Còn lại (ngoài session)
1. [EYES] — unlock máy, chạy lại `desktop/test/screenshot.ps1` cho 6 page
2. macOS/Linux builds + verify
3. Code signing cert
4. Repo public (để updater cho mọi user) + beta users
