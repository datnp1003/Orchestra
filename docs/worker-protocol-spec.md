# Orchestra Worker Protocol — Spec v0.1

Hợp đồng giữa Orchestrator (IDE agent) và các agent CLI (worker): manifest, TaskBrief,
stream chuẩn hoá, permission model, giám sát in-flight, và bộ công cụ `fleet.*`.

---

## 1. Nguyên tắc (bất biến)

1. **Worker là quá trình có hợp đồng, không phải terminal thân thiện.** Mỗi lần spawn có
   TaskBrief (đầu vào), stream JSONL (diễn tiến), và artifact contract (đầu ra). Hết hợp đồng → kết thúc.
2. **Deny by capability, không deny by instruction.** Không viết trong prompt "đừng làm X" rồi
   hy vọng worker vâng lời — khóa X ở tầng flag/sandbox/filesystem. Prompt chỉ là bản đồ, không phải tường.
3. **Không có permission prompt trong headless.** Một prompt chờ duyệt = deadlock (không ai trả lời).
   Mọi quyền được cấp hoặc từ chối *trước khi* spawn; vượt quyền *trong lúc chạy* → kill, không hỏi.
4. **Con người đứng ở cổng cố định, không đứng sau từng thao tác.** Duyệt plan + merge gate là
   2 cổng chính. Còn lại: orchestrator giám sát và chặn.
5. **Key không bao giờ đi qua LLM.** Orchestrator không nhận API key dưới mọi hình thức —
   vault inject vào env lúc spawn do runner (code thuần) thực hiện.
6. **Mọi prompt và mọi quyết định chặn đều lưu vết** vào task record (episodic) — audit được.

## 2. Vòng đời worker

```
dispatch(brief) ─► validate brief ─► resolve worker (Role Policy + fence) ─► spawn (flags/env/worktree)
      ▲                                                                          │
      │                                                              stream JSONL (chuẩn hoá)
      │                                                                          ▼
   fix/retry loop                                                          Supervisor in-flight
   (theo on_fail của DSL)                                       (deny pattern, budget, timeout)
                                                                                   │
                                                        done/fail ─► collect artifacts ─► gate (DSL)
```

## 3. Agent Manifest

Mỗi CLI một manifest — nguồn chân lý cho install, spawn, permission, model. Registry có thể
do cộng đồng đóng góp; conformance test (§10) chấm điểm trước khi hiển thị badge.

```yaml
id: claude
display: "Claude Code"
install:
  npm: "@anthropic-ai/claude-code"
  fallback: { winget: "Anthropic.ClaudeCode" }   # Windows: ưu tiên npm, fallback winget
version_check: "claude --version"
auth:
  modes: [subscription, api_key, bedrock, vertex]
  check: "claude auth status"                    # cần verify theo version pin
headless: "claude -p --output-format stream-json --verbose"
permission:
  mode_flag: "--permission-mode {mode}"          # plan | acceptEdits | bypassPermissions
  allow: "--allowedTools {allow}"
  deny:  "--disallowedTools {deny}"
  guarantee: worktree_only
model:
  custom_provider: true
  spawn_overrides:
    base_url: "env:ANTHROPIC_BASE_URL"
    api_key:  "env:ANTHROPIC_AUTH_TOKEN"          # giá trị lấy từ vault lúc spawn
    model:    "--model {model}"
    fast:     "env:ANTHROPIC_DEFAULT_HAIKU_MODEL"
  model_slots: { main: true, fast: true, plan: false }
strengths: [architecture, review, ui]            # dùng cho role routing
cost_tier: high
```

```yaml
id: codex
display: "Codex CLI"
install: { npm: "@openai/codex" }
version_check: "codex --version"
headless: "codex exec --json -a never"
permission:
  mode_flag: "--sandbox {mode}"                  # read-only | workspace-write | danger-full-access (cấm dùng)
  approval: "-a never"
  guarantee: workspace_write
model:
  custom_provider: true
  spawn_overrides:
    model:    "-c model={model}"
    provider: "-c model_provider={provider}"
    api_key:  "env:{env_key}"
  model_slots: { main: true, fast: false, plan: false }
strengths: [fast-implementation, refactor]
cost_tier: medium
```

```yaml
id: opencode
display: "OpenCode"
install: { npm: "opencode-ai" }
headless: "opencode run --print-logs"
permission: { guarantee: project_config }         # quyền khai báo trong opencode.json do runner ghi managed section
model:
  custom_provider: true
  spawn_overrides: { model: "--model {provider}/{model}" }
  model_slots: { main: true, fast: true, plan: true }
strengths: [research, docs]
cost_tier: low
```

```yaml
id: antigravity
display: "Antigravity CLI"
install: { npm: "@google/antigravity-cli" }       # placeholder — verify khi làm P1
version_check: "antigravity --version"
headless: "antigravity -p"
permission: { guarantee: unknown_until_conformance }
model:
  custom_provider: false                          # model chính gắn Google — không nhận config push
  model_slots: { main: true, fast: false, plan: false }
strengths: [research, big-context]                # vẫn route được như worker Google-only
```

> Mọi field `check`/flag đều phải chạy qua conformance test với version pin — manifest ghi
> `conformance: "x.y.z"` là version đã kiểm chứng. CLI update mà chưa test → badge vàng, không chặn.

## 4. Registry & Fleet management

```
fleet.list()               → [{id, installed, version, conformance, auth_ok, health}]
fleet.install(id)          → npm/winget/brew theo manifest, hiển thị tiến trình trong IDE
fleet.update(id)           → update + chạy lại conformance + báo diff flags nếu CLI đổi cú pháp
fleet.auth(id)             → mở guided login flow (mỗi CLI một cách — không tự động hoá OAuth)
fleet.smoke(id, model?)    → 1 prompt nhỏ headless ("reply OK") → xác nhận auth + model + stream hợp lệ
```

Badge trạng thái trên matrix Role × Worker × Model: xanh (conformance pass + smoke pass),
vàng (chưa test phiên bản mới), đỏ (auth lỗi / quota / smoke fail kèm lý do).

## 5. Credential Vault

- Lưu trữ: OS keychain (Windows Credential Manager / DPAPI) — không plaintext, không trong repo.
- Mỗi entry: `{provider, key, base_url?}`. Runner tra theo `spawn_overrides.api_key` của manifest.
- UI: 1 bảng "Providers" duy nhất — khai 1 lần, mọi CLI dùng chung. Đây là điểm bán UX then chốt.
- Trên matrix, cột key hiển thị trạng thái (đã cấu hình / thiếu), **không hiển thị giá trị**.

## 6. Config push — 3 mức ưu tiên

| Mức | Cơ chế | Dùng khi |
|---|---|---|
| 1 (mặc định) | **Spawn-time override**: env/flag lúc spawn | Mọi thứ có thể — model, base URL, key, permission. Không đụng config user, không cần restart, mỗi session một model |
| 2 | **Managed profile**: ghi section có namespace (`[profiles.orchestra-*]`, managed section của opencode.json), hiện diff, backup trước khi ghi | Auth/base URL không truyền được qua spawn |
| 3 | Đụng config toàn cục user | **Cấm mặc định** |

`model_slots` quyết định role vào được trong CLI tới mức nào: slot có → role gán trong 1 worker;
slot không → role gán ở tầng worker (cả CLI = 1 role, tách bằng worktree khác).

## 7. TaskBrief — schema đầu vào của worker

Do orchestrator (LLM) điền nội dung vào slot có schema; runner validate, sai schema → trả lại,
không tới tay worker. Đã chốt ở thảo luận: **orchestrator trả lời "Ở ĐÂU, THEO PATTERN GÌ,
XONG KHI NÀO" — worker trả lời "LÀM THẾ NÀO"**.

```jsonc
{
  "task_id": "task-17",
  "node": "implement",
  "role": "coder",
  "goal": "Thêm cổng thanh toán Momo vào checkout",
  "files_in_scope": ["src/payment/gateways/**", "src/pages/checkout/**"],  // hàng rào + entry points
  "constraints": ["theo PaymentGateway adapter (tham khảo stripe.ts)", "không sửa src/auth/**"],
  "forbidden_actions": ["git push", "cài package mới", "network"],
  "acceptance_criteria": ["momo.spec.green", "unit coverage >= 80%"],      // gate sẽ chấm — công bố trước
  "artifacts_in": ["plan@plan"],          // artifact từ node needs, kèm ref
  "artifacts_out": ["diff", "self_test_report"],
  "memory": { "inject": ["project_memory", "user_memory"], "hits": ["kb:payment-module"] },
  "budget": { "usd": 2.00, "minutes": 30 },
  "output_mode": "headless_stream_json"    // buộc từ manifest, worker không được interactive
}
```

Validation rules:

| # | Luật |
|---|---|
| B1 | `goal`, `files_in_scope`, `acceptance_criteria` bắt buộc không rỗng (brief thiếu hàng rào → từ chối). Node `plan` là ngoại lệ — brief của plan chính là task gốc |
| B2 | `artifacts_out` phải khớp outputs khai báo trong DSL node tương ứng |
| B3 | `forbidden_actions` phải map được thành deny pattern/capability (nếu không map được → cảnh báo, coi như chỉ là lời khuyên) |
| B4 | Brief gửi kèm snapshot vào task record — prompt luôn audit được |

## 8. Stream contract — JSONL chuẩn hoá

Adapter mỗi CLI đổi stream gốc (định dạng riêng, đổi theo version) thành event chuẩn:

```jsonl
{"t":"session","worker":"codex","session":"s-881","task":"task-17","node":"implement","pid":4021}
{"t":"message","role":"assistant","text":"Đang đọc src/payment/gateways/stripe.ts"}
{"t":"tool_use","tool":"Edit","target":"src/payment/gateways/momo.ts"}
{"t":"tool_result","ok":true}
{"t":"usage","tokens_in":18422,"tokens_out":1204,"usd":0.14,"model":"gpt-5.3-codex"}
{"t":"blocked","code":"path_escape","detail":"ghi ngoài worktree: ../orchestra/config.yml"}
{"t":"error","code":"budget_exceeded"}
{"t":"done","exit":0}
```

| Event | Nguồn |
|---|---|
| `session` | runner sinh khi spawn |
| `message`, `tool_use`, `tool_result` | ánh xạ từ stream-json của từng CLI |
| `usage` | metadata native của CLI; thiếu → ước lượng từ tokenizer, ghi chú `estimated: true` |
| `blocked` / `error` | supervisor + CLI native |
| `done` | exit code |

Bắt buộc trong conformance: mỗi loại event trên phải xuất hiện đúng lúc trong test scenario
(§10). Stream thô gốc vẫn lưu kèm (`raw_ref`) — khi CLI đổi format, replay lại để sửa adapter.

## 9. Permission model — 4 lớp

### Lớp 1 — Flag lúc spawn (từ manifest, theo node type)

| Node | mode (sandbox) | allow tools | deny tools | network |
|---|---|---|---|---|
| `plan`, `review` | read-only | Read/Grep/Glob | mọi tool ghi | off |
| `implement` | worktree-write | Read/Edit/Write/Bash(test, build) | `git push`, package manager, curl | off trừ khi node khai báo `net: true` |
| `verify` | worktree-write | Bash(test) | Edit/Write source (verify chỉ chạy test) | off |
| `run` | n/a | đúng 1 `command` trong DSL | còn lại | theo node |

### Lớp 2 — Filesystem là tường thật

- Worker chỉ có quyền ghi trong worktree của nó; main branch không chạm được.
- `files_in_scope` map thành **deny globs** ở tầng flag/sandbox của CLI (không chỉ nằm trong prompt).
- Merge vào main chỉ qua merge gate của orchestrator.

### Lớp 3 — Supervisor in-flight (code thuần, parse stream)

| Tín hiệu | Nguồn | Hành động |
|---|---|---|
| Lệnh khớp deny pattern (`git push`, `rm -rf`, `curl` khi net off, decode-exec...) | `tool_use` event | kill ngay → `{"t":"blocked"}` → node `on_fail` |
| Ghi ngoài worktree | deny globs + FS watcher | chặn ở sandbox; nếu vẫn xảy ra → kill |
| Vượt budget/wall clock | usage + ticker | kill, `error: budget_exceeded` |
| Permission prompt xuất hiện trong stream (CLI đổi hành vi) | pattern match | kill — coi như cấu hình lỗi, escalate `ask_user` kèm diagnostic |
| Loop vô hạn (cùng tool_use lặp N lần) | heuristic trên stream | kill, đánh dấu `stuck` |

### Lớp 4 — Sau khi chạy

Gate của DSL chấm artifact thật (không tin lời worker), review cross-CLI bắt phần còn lại.
Mọi kill/block ghi episodic với lý do — là tín hiệu feedback cho Role Policy (tầng 7).

## 9b. Quan sát hai nguồn, chặn 3 thời điểm, phát hiện treo

### Quan sát — Reported vs Observed

| Nguồn | Cách | Thấy gì | Điểm mù |
|---|---|---|---|
| **Reported** | stream JSONL §8 | message, tool_use, tool_result, usage | chỉ những gì CLI tự báo; subagent nội bộ có thể bị tóm lược |
| **Observed** | FS watcher (chokidar) trên worktree + process tree + `git status` | thay đổi file **thật**, tiến trình con thật | network khó quan sát trực tiếp — pattern trong command + proxy/ETW cho case cần kỹ |

Mỗi worker chạy song song 1 stream reader + 1 FS watcher từ lúc spawn. **Tin Observed hơn
Reported**: file đổi mà stream không có `tool_use` tương ứng (hoặc ngược lại) = bất thường,
đánh dấu ngay, không chờ gate.

### Chặn — 3 thời điểm, bảo đảm thật nằm ở thời điểm đầu

1. **Trước thực thi (bảo đảm chính — capability denial)**: sandbox flags, deny globs, worktree
   isolation, và **worker không nắm credential** (không có token git trong env → không thể push
   dù muốn). CLI hỗ trợ hook (vd PreToolUse) → manifest khai báo `hooks`, adapter wiring — chặn
   đúng trước khi lệnh chạy. Conformance test xác minh (case 8).
2. **Trong lúc chạy (lưới an toàn)**: stream parser + watcher phát hiện deny pattern / path
   escape / network khi `net: off` → kill process tree bằng **Job Object** (Windows) — tiến trình
   con chết theo parent. Trung thực về giới hạn: kill có độ trễ, lệnh có thể đã chạy xong trước
   khi kill tới — lớp này phòng khi CLI đổi hành vi hoặc cấu hình trượt, không phải lớp bảo đảm.
3. **Sau khi chạy (chốt hạ)**: merge gate. Thiệt hại giam trong worktree bị vứt — không merge =
   chưa có gì đã xảy ra. Đây là biên chứa cuối cùng và là lý do kiến trúc worktree không chỉ
   để tránh conflict.

### Phát hiện treo — 5 tín hiệu

| # | Tín hiệu | Xử lý |
|---|---|---|
| 1 | Im lặng stream > N phút (ngưỡng theo node type) | nghi — đối chiếu tín hiệu 2 để phân biệt "đang nghĩ lâu" |
| 2 | Process sống, CPU ≈ 0, không event | đứng chờ input (kinh điển: permission prompt lộ lên trong headless = lỗi cấu hình) → kill + escalate kèm diagnostic |
| 3 | Cùng `tool_use` lặp ≥ 5 lần cùng kết quả | livelock → kill, đánh dấu `stuck`, spawn fixer kèm context |
| 4 | Vượt wall clock (budget V9) | kill, `error: budget_exceeded` |
| 5 | ConPTY buffer đầy (bẫy Windows: không drain output thì tiến trình con block khi ghi) | reader thread luôn chạy, không bao giờ pause — phòng từ phía runner |

Không kill câm: snapshot last events + phân loại (hung → retry worker mới / stuck → fixer /
over-budget → escalate) → ghi episodic. Treo lặp lại trên cùng cặp CLI×node là tín hiệu âm
cho track record (Role Policy §5).

## 10. Conformance test — điều kiện badge

Chạy với version pin của CLI, các case bắt buộc:

1. `version_check` parse được.
2. Smoke run trả về stream có đủ event bắt buộc.
3. Node read-only thử ghi → bị chặn (không crash, không prompt).
4. Node worktree-write ghi ngoài scope → bị chặn bởi deny globs.
5. Model override qua spawn-time có hiệu lực (usage metadata phản ánh đúng model).
6. `net: off` → network attempt bị chặn.
7. Exit code / artifact trả về đúng contract của node type.
8. Hook pre-execution (manifest khai báo `hooks`) chặn lệnh khớp deny pattern **trước khi** lệnh chạy.

Registry đánh dấu `conformance: pass|fail|untested` theo từng version; update CLI chưa test → badge vàng.

## 11. Bộ công cụ `fleet.*` cho orchestrator

```
fleet.list()  fleet.install(id)  fleet.update(id)  fleet.auth(id)  fleet.smoke(id, model?)
fleet.dispatch(brief)      → session_id   (validate brief, spawn theo manifest)
fleet.poll(session)  fleet.stream(session) fleet.wait(session, timeout)
fleet.kill(session, reason)
fleet.collect(session)     → artifacts theo contract node
fleet.merge(task_ids, order)               → merge DAG + integration test (config.yml §8 của DSL spec)
```

Orchestrator **không có tool đọc vault** — key chỉ đi qua runner lúc spawn (nguyên tắc §1.5).

## 12. Packaging & phân phối

- **Chuẩn**: npm (`npm i -g orchestra-cli`) — đúng quy ước hệ sinh thái agent CLI.
- **Tuỳ chọn**: daemon chạy nền đóng exe bằng `bun build --compile` (không bắt user cài Node).
- **Bẫy đã ghi nhận**: `node-pty` là native addon — test đóng gói exe ngay từ P1; nếu gãy,
  tách PTY helper thành tiến trình con riêng thay vì nhúng vào exe.

## 13. Mở sau v0.1

- Session resume (`claude --resume`, tương đương của các CLI khác) để retry không mất context
- Hot-swapping worker giữa chừng (chuyển node sang CLI khác, bàn giao transcript)
- Docker/容器 isolation cho worker (`net: true` cần môi trường kín hơn worktree)
- Telemetry hiệu năng adapter theo version (phát hiện CLI đổi format trước khi user gặp lỗi)
