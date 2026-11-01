# Orchestra — Roadmap tổng từ hiện tại đến sản phẩm hoàn thành

> Giả định: 1 dev full-time. Mọi mốc là ước lượng; exit criteria là điều kiện *đo được*,
> không phải cảm giác "xong". Cập nhật lại sau mỗi chặng.

---

## 0. Vị trí hiện tại (30/10/2026)

| Đã có | Trạng thái |
|---|---|
| 4 spec v0.1 khép vòng (DSL · Worker Protocol · Role Policy · Memory) | ✓ chốt |
| P1 prototype — registry, headless spawn, stream chuẩn hoá, smoke, supervisor-lite | ✓ chạy thật, PASS cả claude + codex |
| P2 prototype — worktree isolation, TaskBrief B1, permission matrix, dispatch theo role, scope check, task record | ✓ chạy thật trên demo-repo |

**Vị trí:** nguyên lý đã được chứng minh ở mức prototype. Phần còn lại của sản phẩm là
biến luồng "1 node 1 lệnh" thành **pipeline tự chạy**, rồi bọc vào **IDE**, rồi **hoàn thiện
đủ để người ngoài dùng**.

## 1. Định nghĩa "hoàn thành" — 2 cửa

### Cửa MVP (cuối chặng P5) — đo được:
1. Một dev **bên ngoài** cài được bằng 1 câu lệnh, dùng được trong buổi làm việc đầu tiên
   (onboarding ≤ 15 phút).
2. E2E thật: mở repo → tạo task → pipeline `plan → implement → verify → review` tự chạy qua
   ≥ 2 CLI khác nhau → user duyệt plan + merge → task record + patch được lưu.
3. Cross-review có thật: implement và review chạy trên 2 CLI khác họ, được log.
4. Mỗi task có trần chi phí; vượt trần → kill + escalate (không có hoá đơn bất ngờ).
5. Lỗi CLI (treo, sai format, đổi version) không làm crash orchestrator — degrade + báo rõ.

### Cửa v1.0 (cuối chặng P7) — đo được:
1. ≥ 3 CLI hỗ trợ, mỗi CLI có conformance suite chạy tự động theo version pin.
2. Supervisor đủ 4 lớp (kể cả FS watcher in-flight + deny globs ở tầng flag).
3. Memory loop khép: episodic → retrospective → proposal PR → user merge → policy/KB cập nhật.
4. 10–20 beta users dùng ≥ 2 tuần; ≥ 1 task/người/ngày trung bình.
5. Docs + troubleshooting tự phục vụ; npm install; crash rate < 1 task/100.

## 2. Các chặng

### P3 — Pipeline Runner (tuần 1–3): "biến DSL thành xương sống"

Mục tiêu: file `feature-dev.yml` chạy được tự động, không cần người gõ lệnh từng node.

- Loader YAML + validation luật V1–V10 (schema cấm xoá `verify`, cấm `when` trên verify…)
- DAG executor: topological order, skip propagation, node song song khi độc lập
- Node executors: plan (chặn duyệt), implement, verify, review, merge_gate
- Gate evaluator deterministic: `tests.green`, `verdict.approved`, `files_changed <= N`
- `on_fail`: retry / spawn_fix (giới hạn max_retries) / ask_user — fix node kèm context node fail
- Gate runner: map `acceptance_criteria` → lệnh test trong repo config, chạy thật
- Multi-task compose: DAG task → thứ tự merge → integration test sau mỗi merge → merge resolver
- DSL templates mặc định: `feature-dev.yml`, `hotfix.yml` vào `docs/templates/`

**Exit criteria:** demo-repo chạy `orchestra run "thêm cổng X"` → 4 node tự chạy, 1 case
verify fail → spawn_fix tự sửa → pass; 2 task song song merge được với integration test.
**Rủi ro chính:** viết loop chạy ổn định (trạng thái node, resume giữa chừng) — giữ đơn giản:
task = thư mục state, mỗi node một file, không cần DB.

### P4 — Policy từ file + Memory (tuần 4–6): "bộ não"

- `policy.yml` load + validate P1–P8; binding từ file thay binding trong code
- Track record: bảng SQLite tổng hợp từ task records (first_try_pass, override, blocks, EMA 30d)
- Routing dùng score thực: track_record + health + cost + preference + tag boost
- Memory tầng 2: migrate task records JSON → SQLite episodic + FTS5
- Memory tầng 3: KB markdown `.orchestra/kb/` + **injection vào brief có trần 2.5k token** + eviction
- Feedback events: capture user_edit_after_merge / verdict_rejected / task_reassigned
- Retrospective v0: job cluster task records → sinh proposal (KB diff + policy diff) dạng PR text

**Exit criteria:** chạy 10 task mô phỏng (vài task "fail" cố ý) → track record phản ánh đúng;
brief tự chứa KB entry đúng module; retrospective sinh ≥ 1 proposal hợp lý cho user duyệt.
**Rủi ro chính:** chất lượng chưng cất — dùng sample gate (n ≥ min_sample) ngay từ đầu,
không để memory "kể chuyện" dựa trên nhiễu.

### P5 — IDE Extension (tuần 7–11): "sản phẩm mang hình dạng" — MỤC TIÊU MVP

- VS Code extension (TypeScript, tái dùng runner core): 
  - **Fleet panel**: list/install/update CLI, auth status, badge conformance
  - **Task panel**: tạo task, xem pipeline node-by-node, transcript live (stream JSONL → tree view),
    diff review, nút duyệt plan / merge / kill
  - **Matrix UI**: role × worker × model — cell = policy.yml, sửa → diff → save
- Credential vault: Windows Credential Manager (DPAPI), inject lúc spawn, key không qua LLM
- Conformance runner v1: 8 case §10 chạy theo version pin, badge xanh/vàng/đỏ
- Package: `npm i -g orchestra-cli` (CLI core) + extension VSIX

**Exit criteria:** đạt đủ 5 điều kiện cửa MVP (§1).
**Rủi ro chính:** scope creep UI — chốt: panel thô mà chạy thật > đẹp mà demo.
Webview transcript là phiên bản 1, không làm editor tùy biến.

### P6 — Hardening + Beta (tuần 12–15): "đủ tin để giao cho người khác"

- Supervisor Lớp 3: FS watcher (chokidar) trên worktree, cross-check Observed vs Reported,
  deny globs xuống tầng flag (`--disallowedTools` rules cho claude; profile opencode),
  phát hiện network attempt, phân loại treo (hung/stuck/budget) — như §9b spec
- Conformance suite hoàn chỉnh + tự chạy khi registry thấy CLI update (badge vàng)
- Session resume, hot-swap worker giữa node
- Đường macOS/Linux verify (prototype đã cross-platform từ Node; test thật + fix)
- 10–20 beta users: kênh feedback, issue template, weekly release

**Exit criteria:** 2 tuần beta, crash rate < 1/100 task, ≥ 1 user chạy hằng ngày tự nguyện.
**Rủi ro chính:** số lượng cách CLI khác nhau phản hồi — mọi fix phải đi kèm 1 conformance case
mới, không fix point-to-point.

### P7 — Launch v1.0 (tuần 16–17)

- Publish npm + marketplace VS Code; docs site (quickstart 15 phút, khái niệm, manifest spec)
- Registry manifests cho cộng đồng đóng góp (PR + conformance tự động)
- Role pack / skill-sync v0: pack cài 1 lần, IDE sync AGENTS.md/CLAUDE.md/.codex cho worker
- Post-mortem beta → v1.0 checklist → release

**Exit criteria:** đạt đủ 5 điều kiện cửa v1.0 (§1).

## 3. Cross-cutting (chạy xuyên suốt)

| Lĩnh | Quy tắc |
|---|---|
| Kiểm chứng | Mọi chặng phải demo trên **CLI thật**, không fixture-only; fixture chỉ dùng cho replay |
| Chi phí dev | Mỗi buổi chạy demo ghi usage; nếu 1 tuần dev tốn > $20 model fee → tối ưu trước khi thêm feature |
| Hợp đồng chất lượng | unmapped-lines và first_try_pass là 2 số liệu luôn hiện trong output |
| Phạm vi | MVP không có: marketplace, multi-user/team sync, Docker isolation, hot-swap — các đề mục này là v1.x |
| Windows | Platform chính (máy dev); macOS/Linux verify ở P6, không sớm hơn |

## 4. Bảng mốc tổng

```
Tuần:     1───2───3───4───5───6───7───8───9──10──11──12──13──14──15──16──17
Chặng:    ├─────P3─────┤├─────P4────┤├────────P5 (MVP)────────┤├──P6──┤├P7┤
Cửa:                                  │                        │        │
                                 MVP review               Beta       v1.0
Đã xong (trước tuần 1): 4 spec v0.1 + P1 + P2 prototype ✓
```

Tổng: ~4 tháng solo full-time. Cắt ngắn được nếu: P5 chỉ làm CLI panel trước (mất 1–2 tuần),
hoặc memory chỉ làm episodic + KB injection bỏ retrospective (trả lại sau v1.0).

## 5. Hành động tiếp theo (tuần 1, ngày 1–2)

1. Thêm dependency `js-yaml`, viết loader `pipeline.ts`: parse `feature-dev.yml` + validation V1–V10
2. DAG executor v0: chạy tuần tự các node của `feature-dev` trên demo-repo, mỗi node reuse `dispatch()`
3. Demo đầu P3: 1 lệnh → plan (dừng duyệt qua CLI prompt) → implement → verify → review
   — đây là lần đầu tiên ý tưởng gốc chạy như một *quy trình*, không phải lệnh rời.
