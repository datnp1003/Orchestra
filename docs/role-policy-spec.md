# Orchestra Role Policy — Spec v0.1

Mảnh nối giữa Pipeline DSL (node khai báo `role`) và Worker Protocol (manifest khai báo khả năng).
Role Policy trả lời: **node này cần role X → worker nào (CLI + model), với quyền gì, trần chi phí nào,
và ai là phương án dự phòng.** Resolution là code deterministic — LLM chỉ gợi ý, không quyết cuối.

---

## 1. Nguyên tắc (bất biến)

1. **Router quyết bằng code, Orchestrator gợi ý bằng ngữ nghĩa.** Orchestrator gắn tags cho task
   (`ui`, `payment`, `refactor`...); router dùng tags để boost điểm — nhưng lựa chọn cuối deterministic
   và được ghi log cùng lý do. Re-run cùng điều kiện → cùng worker.
2. **Policy là file trong git, không phải state ẩn.** Mỗi thay đổi policy là một diff review được.
   Retrospective đề xuất bằng PR, người dùng merge = chốt. Không tự ghi đè, không auto-apply.
3. **Mọi role phải có trần chi phí** (luật V9 của DSL spec) và **profile quyền** — không có mặc định ngầm.
4. **Cross-review là ràng buộc của hệ thống, không phải gu của model.** Router loại worker đã dùng
   cho node bị `distinct_worker_from` trỏ tới — trước cả khi chấm điểm.
5. **Suy giảm có kiểm soát (graceful degradation).** Không bao giờ âm thầm bỏ ràng buộc: fleet thiếu
   phương án → escalate `ask_user` kèm cảnh báo rõ (vd mất cross-review).

## 2. Vị trí file & ưu tiên

```
~/.zcode/policy.yml          # global — gu cá nhân, matrix mặc định
.orchestra/policy.yml        # project — override theo repo (đi theo git, share team)
```

Merge theo key: project đè global từng mục (role → bindings thay nguyên khối, không gộp sâu).

## 3. Schema đầy đủ — `policy.yml`

```yaml
version: 1

roles:                                 # định nghĩa role + mặc định
  planner:
    description: "Đọc code, sinh plan + acceptance criteria"
    permission_profile: readonly
    budget: { usd: 1.00, minutes: 20 }
  coder:
    description: "Implement trong worktree"
    permission_profile: worktree-write
    budget: { usd: 2.00, minutes: 30 }
  verifier:
    description: "Chạy test suite độc lập"
    permission_profile: verify-only
    budget: { usd: 0.50, minutes: 15 }
  reviewer:
    description: "Review diff cross-CLI"
    permission_profile: readonly
    budget: { usd: 1.00, minutes: 20 }
  researcher:
    description: "Tìm hiểu yêu cầu, thư viện, so sánh phương án"
    permission_profile: readonly
    budget: { usd: 0.80, minutes: 25 }
  fixer:                               # node fix động (spawn_fix) kế thừa role của node gốc
    description: "Sửa theo feedback verify/review"
    permission_profile: worktree-write
    budget: { usd: 1.00, minutes: 20 }
  resolver:                            # merge conflict resolver (compose layer)
    description: "Giải conflict khi merge nhiều task"
    permission_profile: worktree-write
    budget: { usd: 1.50, minutes: 30 }

# Matrix: role → danh sách ứng viên theo thứ tự ưu tiên (score sắp lúc dispatch)
bindings:
  coder:
    - worker: { cli: codex,    model: gpt-5.3-codex }
      boost_when: { tags: [refactor, backend, performance] }
    - worker: { cli: claude,   model: opus-4.6 }
      boost_when: { tags: [ui, architecture, payment] }
    - worker: { cli: opencode, model: kimi-k2.5 }
      when: { budget_tier: low }          # chỉ xét khi user chọn chế độ tiết kiệm
  verifier:
    - worker: { cli: claude, model: sonnet-4.6 }
    - worker: { cli: opencode, model: deepseek-v4 }
  reviewer:
    - worker: { cli: claude, model: opus-4.6 }
    - worker: { cli: gemini, model: gemini-3-pro }
  planner:
    - worker: { cli: claude, model: opus-4.6 }
    - worker: { cli: gemini, model: gemini-3-pro }      # 1M context cho repo lớn
  researcher:
    - worker: { cli: gemini, model: gemini-3-pro }      # big-context
    - worker: { cli: opencode, model: deepseek-v4 }

# Profile quyền — được Worker Protocol §9 Lớp 1 dịch thành flag lúc spawn
permission_profiles:
  readonly:
    sandbox: read_only
    allow: [Read, Grep, Glob, WebSearch]
    deny:  [Write, Edit, Bash]
    net: false
  worktree-write:
    sandbox: worktree_only
    allow: [Read, Grep, Glob, Write, Edit, "Bash(test,build)"]
    deny:  ["git push", "package-install", "curl"]
    net: false                          # node khai báo net: true mới mở — profile không mở hộ
  verify-only:
    sandbox: worktree_only
    allow: [Read, "Bash(test)"]
    deny:  [Write, Edit]
    net: false

routing:                                # trọng số chấm điểm ứng viên
  weights: { track_record: 0.4, health: 0.2, cost: 0.2, preference: 0.1, speed: 0.1 }
  min_sample: 10                        # dưới N lần chạy, track record chưa đáng tin
  decay: 30d                            # track record giảm theo thời gian
  budget_mode: balanced                 # balanced | performance | low  (user chỉnh 1 chạm)

fleet_constraints:
  cross_review: required                # bắt buộc ≥2 CLI khác họ trong fleet cho verifier/reviewer
  max_parallel_tasks: 3                 # trần song song toàn cục (quota/budget)
  reserved_for_review: []              # có thể reserve 1 CLI chỉ làm review
```

## 4. Thuật toán resolve (runner, deterministic)

```
resolve(role, node, task):
  1. candidates = bindings[role]
       lọc: CLI installed ∧ auth_ok ∧ conformance ≠ fail
            model khả dụng (manifest.custom_provider ∨ model native)
            model_slots hỗ trợ slot node yêu cầu (nếu node dùng slot)
            permission profile thỏa được bởi `guarantee` của CLI
            KHÔNG trùng worker đã gán cho node trong distinct_worker_from (cùng task)
  2. score(c) = w·track_record(c, role, task_type)      # tầng 7 fleet memory
             + w·health(c)                              # conformance + smoke badge
             + w·(1 − cost_norm(c))                     # theo budget_mode
             + w·preference(c)                          # boost_when tags khớp, user_overrides
             + w·speed(c)
  3. pick = argmax; ghi log: {pick, candidates, scores, tags, reason}
  4. rỗng → escalate: nới ràng buộc nào KHÔNG được — hỏi user:
       "Không có CLI thứ hai cho cross-review node 'verify'.
        Tiếp tục với cùng CLI (mất kiểm chứng chéo)? / Dừng task."
```

Điểm lưu ý thiết kế:

- **Override từ DSL node**: `worker.hint.prefer/avoid` cộng/trừ điểm; `worker.hint.pin` ép cứng
  (chỉ dùng debug — router vẫn log "pinned" để audit).
- **budget_mode**: `low` tự động nghiêng về worker rẻ + cho phép ứng viên có `when: budget_tier: low`;
  `performance` bỏ qua cost weight. 1 chọn dropdown trong UI, không phải sửa YAML.
- **Log quyết định là artifact**: mỗi dispatch ghi `{pick, scores, reason}` vào task record —
  retrospective đọc được *vì sao* worker X được chọn hôm đó.

## 5. Track record (fleet memory — tầng 7)

Runner tổng hợp từ episodic records, **không qua LLM** — đây là bảng số liệu, không phải ký ức:

```jsonc
{
  "worker": "codex", "role": "coder", "task_type": "feature",   // key tra cứu
  "window": "30d",
  "dispatched": 14, "gate_passed": 11, "first_try_pass": 9,
  "retries_avg": 0.4, "overreach_blocks": 1,
  "avg_cost_usd": 1.7, "avg_minutes": 22,
  "user_override_to": 2,      // user đổi sang worker khác sau khi thấy kết quả — tín hiệu âm
  "user_override_from": 0,    // user đổi sang worker này — tín hiệu dương
  "ema_score": 0.78           # decay 30d, cập nhật sau mỗi task
}
```

Nguồn tín hiệu (tự nhiên phát sinh trong quy trình, không ai phải đánh giá tay):

| Tín hiệu | Trọng số cảm nhận |
|---|---|
| `first_try_pass` (qua gate không cần retry/fix) | dương mạnh nhất |
| `user_override_from` → worker này | dương |
| `user_override_to` (bỏ worker này) | âm |
| `overreach_blocks` | âm — worker hay vượt quyền |
| cost/minutes trên trung bình role | âm nhẹ |

`min_sample: 10`: dưới 10 lần chạy, `ema_score` không vào routing — dùng `strengths` của
manifest + `boost_when` làm ưu tiên ban đầu. Fleet mới = gu cấu hình; fleet cũ = số liệu tự chứng.

## 6. Learning loop — từ track record đến policy

```
episodic + feedback events ─► runner tổng hợp track record (hàng đêm / sau N task)
        │
        └─► retrospective job (LLM) đọc track record + log routing
              → sinh PROPOSAL (PR gắn [orchestra-proposal]):
                  - đề xuất đổi thứ tự bindings ("codex fail 40% task UI, n=12
                    → đề xuất hạ claude lên #1 cho coder khi tag=ui")
                  - đề xuất thêm/sửa permission profile, budget
              → user review diff → merge = chốt | đóng = bỏ qua (ghi nhận để không đề xuất lại)
```

Điều kiện đề xuất: `n ≥ min_sample` và chênh lệch có ý nghĩa (vd ≥ 20 điểm % first_try_pass).
Mỗi đề xuất phải kèm bằng chứng số liệu — không được đề xuất theo "cảm nhận".

## 7. Validation rules (luật cứng khi load policy)

| # | Luật |
|---|---|
| P1 | Mọi role được DSL template tham chiếu phải có định nghĩa trong `roles` (cảnh báo nếu thiếu `bindings` — dispatch sẽ escalate) |
| P2 | Mọi binding phải trỏ tới manifest tồn tại trong registry |
| P3 | `fleet_constraints.cross_review: required` → fleet phải có ≥2 CLI khác *họ* (không phải 2 version của 1 CLI) khả dụng cho verifier/reviewer, ngược lại cảnh báo đỏ trên matrix |
| P4 | `permission_profiles` cấm `sandbox: danger_full_access` và cấm `net: true` mặc định cho role ghi (luật của Worker Protocol) |
| P5 | Mọi role bắt buộc có `budget` (V9) |
| P6 | Model trong binding phải thỏa `custom_provider` của manifest và `model_slots` của slot yêu cầu |
| P7 | `weights` trong `routing` phải tổng = 1.0 |
| P8 | Thay đổi policy không bump `version` → warning (như DSL V10) |

## 8. UI trên matrix (khái niệm)

```
              codex/gpt-5.3-c  claude/opus-4.6  opencode/kimi  gemini-3-pro
coder         ● #1 (0.82)      ○ #2 (0.79)      ○ low          —
verifier      —                ● #1 (0.91)      ○ #2 (0.74)    —
reviewer      —                ● #1             —              ○ #2
planner       —                ● #1             —              ○ #2 (1M ctx)
researcher    —                —                ○ #2           ● #1
              ● được chọn  ○ dự phòng  badge: ✓ conformance  ⚠ untested  ✗ auth/quota
```

- Cell là **duy nhất nguồn chân truth**: click → sửa `policy.yml` → diff → save. Không có state ẩn trong UI.
- Badge lấy từ registry health; cell mờ khi CLI fail conformance/smoke.
- Toggle `budget_mode` + trần `$` mỗi role đặt ngay trên matrix.

## 9. JSON Schema (khung rút gọn)

```yaml
type: object
required: [version, roles, bindings, routing]
properties:
  version: { type: integer, minimum: 1 }
  roles:
    type: object
    additionalProperties:
      type: object
      required: [permission_profile, budget]
      properties:
        description: { type: string }
        permission_profile: { type: string }      # phải tồn tại trong permission_profiles
        budget: { type: object, required: [usd, minutes] }
  bindings:
    type: object
    additionalProperties:
      type: array
      items:
        type: object
        required: [worker]
        properties:
          worker: { type: object, required: [cli], properties:
                    { cli: { type: string }, model: { type: string } } }
          boost_when: { type: object }
          when: { type: object }
  permission_profiles: { type: object }
  routing:
    type: object
    properties:
      weights: { type: object }
      min_sample: { type: integer, minimum: 1 }
      decay: { type: string }
      budget_mode: { enum: [balanced, performance, low] }
```

## 10. Mở sau v0.1

- A/B routing: chạy song song 2 worker cùng node, lấy kết quả tốt qua gate (tốn 2× — chỉ cho role quan trọng)
- Policy theo thư mục/module (`coder` khác nhau cho `src/ui/**` và `src/core/**`)
- Import rating từ marketplace role-pack (kết hợp với track record cục bộ)
- Skill-sync per role: role nào gắn skill pack nào (điểm nối với ý #3 của ý tưởng gốc)
