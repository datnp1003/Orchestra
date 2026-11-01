# Orchestra Pipeline DSL — Spec v0.1

Ngôn ngữ khai báo quy trình cho IDE agent dạng orchestrator, điều phối các agent CLI
(Claude Code, Codex, OpenCode, ...) như worker.

---

## 1. Nguyên tắc thiết kế (bất biến)

1. **Node khai báo role, không khai báo lệnh.** DSL không nói "chạy claude với prompt X" —
   nó nói "cần một `coder`". Việc chọn CLI/model là việc của Router + Role Policy.
2. **`verify` là node bắt buộc.** Mọi pipeline phải có đúng một node `type: verify`,
   không được đặt điều kiện (`when`), không được xoá. User chỉ được *thêm* kiểm tra, không được bớt.
3. **Cross-review.** Node kiểm tra (verify/review) phải chạy trên CLI khác với node implement
   (khai báo `distinct_worker_from`). Nếu fleet không đủ CLI → escalate hỏi user.
4. **Runner deterministic, Orchestrator là LLM.** Router/gate/merge là code thuần — pipeline
   chạy được kể cả khi LLM orchestrator lỗi hoặc offline (chế độ reduced: dùng pipeline mặc định).
5. **Agent đề xuất, người dùng chốt.** Mọi thay đổi pipeline (kể cả do retrospective đề xuất)
   là một git diff trên file template — duyệt = merge.
6. **Fix loop luôn có chặn trên.** Mọi vòng lặp sửa lỗi giới hạn số lần, hết lượt → hỏi user.

## 2. Vị trí file & thứ tự ưu tiên

```
.orchestra/
  config.yml              # policy cấp project: integration, budget mặc định
  pipelines/
    feature-dev.yml       # template pipeline (project scope, đi theo git)
    hotfix.yml
    refactor.yml
  episodic.sqlite         # memory tầng 2 (task records)
  kb/                     # memory tầng 3 — project memory, markdown, review qua git
~/.zcode/
  pipelines/              # template pipeline global (mọi project)
  policy.yml              # Role Policy + User memory pointer (tầng 4, 5)
```

Ưa tiên khi resolve pipeline id: **project > global**. Template trong repo → được version,
diff-review được, share cả team.

## 3. Khái niệm cốt lõi

| Khái niệm | Ý nghĩa |
|---|---|
| **Pipeline** | 1 file YAML = 1 quy trình cho 1 task. `applies_to` quyết định task loại nào tự dùng pipeline này. |
| **Node** | Một bước trong DAG. Có `type` (ngữ nghĩa built-in), `role` (ai đảm nhiệm), `needs` (phụ thuộc), artifact vào/ra, `gate`, `on_fail`. |
| **Role** | Nhãn ngữ nghĩa: `planner`, `coder`, `verifier`, `reviewer`, ... Router map role → CLI/model qua Role Policy. |
| **Worker** | Một agent CLI cụ thể + model cụ thể, được Router chọn lúc dispatch. |
| **Artifact** | Sản phẩm có kiểu của node: `plan`, `diff`, `test_report`, `verdict`, ... Node nhận artifact từ node nó `needs`. |
| **Gate** | Điều kiện qua cửa — đánh giá bằng code deterministic, không phải LLM. |
| **Brief** | Gói đầu vào cho worker: params + artifact upstream + memory inject. Brief là interface duy nhất giữa orchestrator và worker. |

## 4. Node types chuẩn

| Type | Ngữ nghĩa built-in | Outputs mặc định |
|---|---|---|
| `plan` | Đọc code + brief, sinh plan & acceptance criteria. Thường `approval: required`. | `plan` |
| `implement` | Code trong worktree riêng. `self_test: true` → coder tự chạy test trước khi báo xong (kết quả chỉ mang tính tham khảo). | `diff`, `self_test_report` |
| `verify` | **Bắt buộc.** Chạy test suite độc lập trên trạng thái merge-rehearsal của worktree. Không tin `self_test_report`. | `test_report` |
| `review` | Đánh giá diff theo checklist + `test_report`. Sinh verdict. | `verdict`, `review_comments` |
| `check` | Phân tích LLM có chủ đích (hiệu năng, a11y, ...) sinh báo cáo. | `report` |
| `run` | Lệnh deterministic, KHÔNG dùng LLM (lint, benchmark, scanner). | `report` |
| `merge_gate` | Chỉ orchestrator chạy: tổng hợp gate, quyết định auto-merge hay hỏi user. | `merge_result` |

## 5. Cú pháp

### 5.1 Đầy đủ — `feature-dev.yml`

```yaml
id: feature-dev
version: 1
name: "Feature development"
applies_to:
  task_type: [feature, chore]        # task loại nào tự khớp pipeline này

params:                              # truyền lúc dispatch
  - name: target                     # mô tả tính năng
    required: true
  - name: e2e
    default: true
  - name: max_files_changed
    default: 30

memory:                              # hook vào memory interface
  brief_inject:                      # luôn bơm vào mọi brief
    - project_memory                 # tầng 3 (kb/)
    - user_memory                    # tầng 5
  retrieval:                         # tra khi cần, theo node
    - node: plan
      sources: [episodic, semantic, fleet]
      query: "{{ params.target }}"

nodes:
  - id: plan
    type: plan
    role: planner
    approval: required               # dừng, user duyệt plan mới chạy tiếp
    outputs: [plan]

  - id: implement
    type: implement
    needs: [plan]
    role: coder
    isolation: worktree              # mỗi task 1 worktree (mặc định)
    self_test: true                  # test lần 1 do coder tự chạy
    budget: { usd: 2.00, minutes: 30 }
    outputs: [diff, self_test_report]
    on_fail: { action: retry, max_retries: 1, then: ask_user }

  - id: verify
    type: verify                     # bắt buộc — schema cấm xoá & cấm when
    needs: [implement]
    role: verifier
    distinct_worker_from: [implement] # phải là CLI khác với coder
    inputs: [diff]
    outputs: [test_report]
    gate:
      - tests.green
      - if: params.e2e
        then: e2e.green
    on_fail:
      action: spawn_fix              # spawn node fix kèm context node fail
      max_retries: 2
      then: ask_user

  - id: security                     # node có điều kiện — chỉ chạy khi chạm path nhạy cảm
    when:
      paths: ["src/payment/**", "src/auth/**"]
    type: run                        # deterministic, không tốn LLM token
    command: "semgrep scan --config auto --error src/"
    needs: [verify]
    outputs: [scan_report]

  - id: review
    type: review
    needs: [verify, security]        # security bị skip → cạnh này tự coi là thoả
    role: reviewer
    distinct_worker_from: [implement]
    inputs: [diff, test_report]
    outputs: [verdict, review_comments]
    gate:
      - verdict.approved
    on_fail: { action: spawn_fix, max_retries: 2, then: ask_user }

  - id: merge_gate
    type: merge_gate
    needs: [review]
    policy: auto_if                  # tự merge khi đủ điều kiện, ngược lại hỏi user
    conditions:
      - all_gates_passed
      - files_changed <= {{ params.max_files_changed }}
    else: ask_user
```

### 5.2 Tối giản — `hotfix.yml`

```yaml
id: hotfix
version: 1
name: "Hotfix nhanh"
applies_to: { task_type: [hotfix, bug] }

params:
  - name: target
    required: true

nodes:
  - id: implement
    type: implement
    role: coder
    self_test: true
    outputs: [diff, self_test_report]

  - id: verify
    type: verify
    needs: [implement]
    role: verifier
    distinct_worker_from: [implement]
    gate: [tests.green]
    on_fail: { action: spawn_fix, max_retries: 1, then: ask_user }

  - id: merge_gate
    type: merge_gate
    needs: [verify]
    policy: ask_always               # hotfix: luôn chốt bằng tay
```

## 6. Ngữ nghĩa thực thi

### 6.1 Skip propagation
Node có `when:` không khớp → bị **skip**, không fail. Node phụ thuộc vào nó coi cạnh đó
là thoả. (Đơn giản, dự đoán được — không cần cú pháp dependency-optional.)

### 6.2 `on_fail` — vòng sửa lỗi có chặn

| action | Ý nghĩa |
|---|---|
| `retry` | Chạy lại chính node đó (spawn worker mới, cùng brief). |
| `spawn_fix` | Spawn node `fix` mới, kèm artifact của node fail (diff, test_report, review_comments) làm context. Đếm chung vào `max_retries` của node gốc. |
| `ask_user` | Dừng pipeline, hiện trạng thái + đề xuất, chờ user. |
| `abort` | Huỷ task, worktree giữ lại để debug. |

Fix node là node động (không có trong YAML tĩnh) — DAG tĩnh phải luôn phi chu trình;
vòng lặp chỉ tồn tại lúc runtime và bị chặn bởi `max_retries`.

### 6.3 Gate expressions — tập đóng, không shell

```
tests.green            e2e.green            verdict.approved
verdict.changes_requested                   files_changed <= N
coverage >= 0.8        scan.critical == 0   budget.spent_usd <= X
if: <param/expr>  then: <expr>
```
Chỉ được tham chiếu artifact đã khai báo và params. Không được gọi lệnh, không được
đọc file ngoài artifact — gate phải tái lập được (reproducible) từ task record.

### 6.4 Routing lúc dispatch — 3 lớp quyết định

```
Node khai báo role ──► Role Policy (matrix role → CLI/model, có track record tầng 7)
                   ──► worker_hint trong node (override nhẹ: prefer/avoid)
                   ──► pin: {cli, model}    (ép cứng — chỉ dùng khi debug)
```

Router sau đó kiểm tra ràng buộc `distinct_worker_from`: nếu fleet chỉ còn 1 CLI khả dụng
→ **không âm thầm bỏ qua**, escalate `ask_user` với cảnh báo mất cross-review.

### 6.5 Brief của mỗi node được ghép từ

1. `params` (mục tiêu, ràng buộc)
2. Artifacts từ các node `needs`
3. `memory.brief_inject` (project + user memory) + retrieval riêng của node
4. Node contract: phải trả artifact nào, gate nào sẽ được dùng để chấm
   → worker biết "bài thi" của mình ngay từ đầu.

## 7. Schema validation — luật cứng (kiểm tra khi load)

| # | Luật |
|---|---|
| V1 | Đúng một node `type: verify`. Không có → từ chối pipeline. |
| V2 | Node `verify` không được có `when` và không được nằm sau điều kiện nào làm nó skip được. |
| V3 | DAG tĩnh phi chu trình. |
| V4 | Mọi artifact dùng làm input phải được node trong `needs` sản xuất. |
| V5 | `distinct_worker_from` chỉ trỏ tới node trong cùng pipeline. |
| V6 | `on_fail.spawn_fix` bắt buộc có `max_retries` và `then`. |
| V7 | `merge_gate` bắt buộc có `policy` (`auto_if` cần `conditions`, `ask_always`/`ask_never` không cần). |
| V8 | Node `run` phải có `command` và không được là node duy nhất quyết verdict của pipeline. |
| V9 | `budget` thiếu → lấy mặc định từ Role Policy theo role; không có mặc định → từ chối (không chạy node không biết trần chi phí). |
| V10 | Template thiếu `version` → từ chối. Thay đổi template không bump version → warning, không chặn. |

## 8. Hợp nhất nhiều pipeline (tầng compose) — `.orchestra/config.yml`

Phần này KHÔNG nằm trong pipeline (pipeline = 1 task). Điều phối nhiều task song song
là policy cấp project:

```yaml
integration:
  merge_order: dag             # theo DAG phụ thuộc task; song song khác nhánh
  after_each_merge:
    run: verify                # integration test sau MỖI lần merge — bắt conflict ngữ nghĩa
    role: verifier
    distinct_worker_from: true # khác CLI với các coder liên quan nếu được
  on_conflict:
    action: spawn_resolver     # node merge-resolver, context = diff các task va chạm
    max_loops: 2
    then: ask_user
  on_integration_fail:
    action: spawn_fix          # phản hồi ngược về task gôc + report integration
    max_loops: 2
    then: ask_user
final:
  changelog: true
  summary: true                # tổng hợp toàn phiên → episodic + hiển thị
  cleanup_worktrees: on_green
```

## 9. Artifact schemas (chuẩn hoá để gate code đọc được)

```yaml
Plan:         { goal, steps[], files_touched[], acceptance_criteria[], risks[] }
Diff:         { worktree, branch, files[], patch_ref, lines_added, lines_removed }
TestReport:   { suite, passed, failed, skipped, duration_s, failures[] }
Verdict:      { result: approved|changes_requested|blocked, comments[], checklist{} }
ScanReport:   { tool, findings[{severity, file, line, rule}], error_count }
MergeResult:  { merged, order[], conflicts_resolved[], integration_reports[] }
```

Node type chuẩn sinh đúng schema của nó; node `check`/`run` sinh `report` tự do
nhưng gate chỉ đọc được field khai báo trong schema trên.

## 10. Versioning & agent đề xuất

- Template là file trong repo → mọi thay đổi qua git.
- Retrospective job đề xuất sửa template → sinh PR/diff gắn nhãn `[orchestra-proposal]`
  → user merge = chốt. Không tự ghi đè.
- `version` tăng theo semver: patch = sửa text/gate số, minor = thêm node, major = đổi
  luồng. Task đang chạy giữ nguyên bản template đã load lúc bắt đầu (snapshot vào task record).

## 11. JSON Schema (khung rút gọn, dùng cho validation khi load)

```yaml
type: object
required: [id, version, nodes]
properties:
  id:      { type: string, pattern: "^[a-z0-9-]+$" }
  version: { type: integer, minimum: 1 }
  applies_to:
    task_type: { type: array, items: { enum: [feature, bug, hotfix, refactor, chore, custom] } }
  params:  { type: array, items: { type: object, required: [name], properties:
             { name: { type: string }, required: { type: boolean }, default: {} } } }
  memory:  { type: object, properties:
             { brief_inject: { type: array, items: { enum: [project_memory, user_memory] } },
               retrieval: { type: array } } }
  nodes:
    type: array
    minItems: 2
    contains: { const: { type: verify } }     # V1 — kiểm tra chính xác ở logic, schema chỉ gợi ý
    items:
      type: object
      required: [id, type]
      properties:
        id:   { type: string }
        type: { enum: [plan, implement, verify, review, check, run, merge_gate] }
        needs: { type: array, items: { type: string } }
        role: { type: string }
        when:
          type: object
          properties:
            paths: { type: array, items: { type: string } }
            task_type: { type: string }
        approval: { enum: [required, optional, none] }
        distinct_worker_from: { type: array, items: { type: string } }
        budget: { type: object, properties: { usd: { type: number }, minutes: { type: integer } } }
        gate:  { type: array, items: { type: string } }
        on_fail:
          type: object
          required: [action]
          properties:
            action: { enum: [retry, spawn_fix, ask_user, abort] }
            max_retries: { type: integer, minimum: 0 }
            then: { enum: [ask_user, abort, continue] }
```

*(Luật V1–V10 kiểm tra bằng logic sau khi parse JSON Schema — schema chỉ chặn cấu trúc thô.)*

## 12. Mở khoá sau v0.1 (không đưa vào bản này)

- Sub-pipeline / node `pipeline_ref` (gọi pipeline khác như node)
- Node song song nội bộ (một node spawn nhiều worker thi nhau, lấy kết quả đầu qua gate — race mode)
- Template marketplace + rating theo track record fleet
- `when` mở rộng: metric repo (độ phức tạp, hot-path theo git history)
