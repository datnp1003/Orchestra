# Orchestra Desktop — Kế hoạch (v0.1)

Ứng dụng desktop độc lập: toàn bộ sức mạnh của Orchestra **không cần mở VS Code**.
Nguyên tắc bất biến: **core đứng yên** — Desktop chỉ là shell mới bọc runner/orchestrator
đang chạy tốt, đúng như extension đã làm.

---

## 1. Vì sao cần Desktop (khi đã có extension)

| Nhu cầu | Extension | Desktop |
|---|---|---|
| Dùng trong VS Code | ✓ | — |
| Dùng độc lập (vim/neovim/không IDE) | ✗ | ✓ |
| **Multi-repo dashboard** (nhiều project cùng lúc) | ✗ (1 workspace) | ✓ |
| **Chạy nền + notification** (pipeline xong, gate chờ duyệt khi đang việc khác) | ✗ | ✓ tray + toast |
| Cài CLI worker không cần terminal | ⚠ (command + terminal) | ✓ wizard đầy đủ (PATH, login) |
| Terminal nhúng xem worker trực tiếp | ✗ | ✓ (node-pty) |
| Phân phối cho người không dùng VS Code | ✗ | ✓ installer .exe |

Định vị: **extension = light client, Desktop = full client** — cùng core, cùng account/vault.

## 2. Shell: Electron trước, Tauri cân nhắc sau

| | Electron (chọn) | Tauri (để sau) |
|---|---|---|
| Tái dùng core Node/TS | **100%** — main process là Node, import `prototype/src` như extension đang làm | Phải sidecar (bun compile) hoặc viết lại Rust |
| Bundle size | ~90MB / RAM nặng hơn | ~10MB |
| node-pty, sqlite, spawn CLI | Native, đã chạy | Qua sidecar — phức tạp 2 runtime |
| Kinh nghiệm hệ sinh thái | electron-builder, auto-update, tray — chuẩn | Tốt nhưng mới hơn |

Quyết định: **Electron cho v1** — tốc độ ra bản > dung lượng. Tauri là bài toán tối ưu của
P-D4, không phải bây giờ. (Ứng với bối cảnh dự án: 3 tuần ra Desktop dùng được đánh đổi
80MB là lời.)

## 3. Kiến trúc

```
┌────────────────────────── Orchestra Desktop (Electron) ─────────────────────────┐
│ Main process (Node)                                                             │
│   ├── import core trực tiếp: runner · dispatch · orchestrator · policy · memory │
│   │   vault · conformance · models · skillsync   (giống extension, 0 rewrite)   │
│   ├── RunnerPool: N repo đồng thời (mỗi repo 1 workspace state)                 │
│   ├── Tray + Notification (gate chờ duyệt, pipeline done/failed)                │
│   └── IPC (contextBridge, contextIsolation BẬT)                                 │
│ Renderer (UI)                                                                   │
│   ├── Dashboard: Fleet + Tasks + Runs (từ 3 webview hiện có → 1 trang)          │
│   ├── Chat Orchestrator (webview hiện có → page)                                │
│   ├── Live Transcript + Terminal nhúng (node-pty)                               │
│   ├── Policy Matrix (click-promote — giữ nguyên)                                │
│   ├── Settings UI (thay settings.json — cùng schema orchestra.*)                │
│   └── Install Wizard (worker npm + login guided + vault)                        │
└─────────────────────────────────────────────────────────────────────────────────┘
```

Tái sử dụng ước tính: **core 100% · UI ~80%** (HTML/CSS webviews chuyển thành pages) ·
mới viết: IPC layer, tray/notify, multi-repo, terminal nhúng, installer config.

## 4. Chặng

### P-D1 — Shell chạy được (tuần 1–2) → MVP Desktop
- Scaffold Electron + TypeScript (tái dùng tsconfig mixed-root như extension)
- IPC contract: `invoke('fleet:list')`, `invoke('dispatch', brief)`, `on('event', cb)`... —
  mỗi hàm đã có trong logic.ts chỉ cần bọc
- 4 page đầu: Dashboard · Chat · Transcript · Matrix
- electron-builder → NSIS installer; test cài/gỡ trên máy thật

**Gate MVP:** cài .exe → không mở VS Code → dispatch + pipeline end-to-end từ app →
transcript live. Nếu gate này không đạt trong 2 tuần → dừng, đánh giá lại (rủi ro số 1: IPC
dầm mưa dãi hơn webview extension — mitigate bằng giữ logic.ts làm API duy nhất).

### P-D2 — Vào việc thật (tuần 3)
- Tray + Notification: gate chờ duyệt plan/merge, pipeline done/failed, budget 80%
- Multi-repo: danh sách repo (từ settings + Recently opened), switch không restart
- Terminal nhúng (node-pty) — xem worker như terminal thật; **electron-rebuild cho native module**
- Install Wizard: cài worker + login OAuth guided + vault entry — gộp 3 command rời thành 1 luồng

### P-D3 — Đủ tin để phân phối (tuần 4)
- Auto-update (electron-updater + GitHub Releases)
- Settings UI đầy đủ (đọc/ghi đúng schema `orchestra.*` của extension — dùng chung config)
- macOS/Linux builds + verify (nợ P6) — vault non-Windows fallback (keychain)
- App icon, installer metadata, (optional) code signing — unsigned thì ghi hướng dẫn SmartScreen

### P-D4 — Sau v1 (tuần 5+, tùy chọn)
- Đánh giá Tauri (sidecar bun) nếu size/memory là vấn đề thật của user
- Role-pack install 1-click (ý #3 — pack = KB + templates + policy snippet)
- Local dashboard mode (serve UI qua localhost — xem từ máy khác)
- Telemetry opt-in (task success rate, cost) — nuôi Model Registry

## 5. Rủi ro & biện pháp

| Rủi ro | Biện pháp |
|---|---|
| IPC layer tốn công hơn dự kiến | logic.ts là API duy nhất — IPC chỉ bọc, không viết logic mới |
| node-pty + electron ABI | electron-rebuild ngay P-D1 đầu tiên (bẫy đã ghi từ P1) — nếu gãy, Terminal nhúng trễ sang P-D3 |
| SmartScreen chặn unsigned exe | v0.1 beta: ghi hướng dẫn "More info → Run anyway"; cert để P-D3/P7 |
| Duy trì 2 UI (extension + desktop) | webview HTML dùng chung file; logic 1 chỗ; extension giữ làm light client — không clone logic |
|范围 creep UI | Gate P-D1 là luật: 4 page, không thêm |

## 6. Bảng mốc

```
Tuần:     1──────2──────3──────4──────5────→
Chặng:    ├──P-D1 (MVP)──┤├─P-D2─┤├─P-D3─┤├─P-D4→
Gate:            installer + E2E     tray/multi-repo  cross-platform
Đã có sẵn: core P1–P6 ✓ · 4 webview UI ✓ · vault/install/conformance ✓
```

~4 tuần solo cho Desktop full. MVP (P-D1) = 2 tuần.

## 7. Việc đầu tiên (ngày 1–2)

1. `Orchestra/desktop/`: scaffold Electron + TS (kế thừa mixed-root tsconfig của extension)
2. IPC contract file (`ipc.ts`: danh sách channel + types từ logic.ts) — viết trước, code sau
3. Dashboard page ghép 3 webview hiện có — mục tiêu cuối tuần 1: dispatch từ Desktop thành công 1 lần
