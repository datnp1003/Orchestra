# Orchestra

IDE agent đóng vai orchestrator, điều phối các agent CLI (Claude Code, Codex, OpenCode,
Grok Build, ...) như worker trong một quy trình có kiểm chứng chéo, có memory, có gate.

## 3 trụ cột

1. **Agent Fleet Registry** — download/update/auth-status các agent CLI ngay trong IDE,
   manifest khai báo khả năng (`custom_provider`, `model_slots`, chi phí, thế mạnh).
2. **Orchestrator + Workers** — IDE agent lập plan, gán role (planner/coder/verifier/reviewer),
   dispatch CLI headless (`claude -p`, `codex exec`, ...) vào git worktree riêng,
   gate bằng code deterministic, hợp nhất qua merge DAG + integration test sau mỗi lần merge.
3. **Config Push + Memory** — một Model Registry + Role Policy trung tâm, push model/provider
   xuống từng CLI lúc spawn (spawn-time override, không đụng config user); memory 7 tầng
   (working → episodic → project → procedural → user → semantic → fleet), retrospective job
   chưng cất feedback thành đề xuất — agent đề xuất, người dùng chốt.

## Cấu trúc

```
Orchestra/
  README.md
  docs/                        # 4 spec v0.1 + roadmap.md (đến v1.0) + desktop-plan.md (app độc lập)
  prototype/                   # P1 + P2 prototype — ĐÃ CHẠY THẬT trên máy dev
    src/
      types.ts                 # event chuẩn §8: session/message/tool_use/tool_result/usage/error/done
      manifests.ts             # manifest claude (2.1.310) + codex (0.164.0), adapter mapper
      registry.ts              # fleet.list: installed / version / auth
      runner.ts                # spawn headless, parse JSONL, raw persistence, supervisor-lite
      cli.ts                   # list | smoke | run | replay
    fixtures/                  # stream thật đã ghi (claude) — replay offline cho conformance
```

## Lộ trình

- **P1** — Registry + install/update + auth dashboard + chạy 1 CLI headless trong panel.
- **P2** — Tools `fleet.dispatch/poll/review/merge` + worktree management (Windows: node-pty).
- **P3** — Role routing, skill-sync xuống worker, pipeline planner → N implementers → reviewer,
  retrospective job + memory.

## Spec liên quan

- ✅ [Pipeline DSL v0.1](docs/pipeline-dsl-spec.md)
- ✅ [Worker Protocol v0.1](docs/worker-protocol-spec.md)
- ✅ [Role Policy v0.1](docs/role-policy-spec.md)
- ✅ [Memory Interface v0.1](docs/memory-interface-spec.md)
- 📋 [Desktop Plan v0.1](docs/desktop-plan.md) — kế hoạch Orchestra Desktop (Electron, MVP 2 tuần)

**Bộ thiết kế đã khép vòng.**

## Prototype P1 — trạng thái kiểm chứng (30/10/2026)

| Hạng mục | Kết quả |
|---|---|
| Registry `list` | ✓ phát hiện claude 2.1.310 + codex 0.164.0 trên máy thật |
| Smoke `claude -p --output-format stream-json` | **PASS** — session/message/usage/done, unmapped=0 |
| Smoke `codex exec --json` | **PASS** — session/message/usage/done, unmapped=0 |
| Replay fixture offline | ✓ 8/8 dòng known, đủ required events |
| Vòng đời đầy đủ có tool | ✓ session → tool_use(Bash) → tool_result → message → usage → done |
| Supervisor kill (wall clock 5s) | ✓ `kill_reason=wall_clock_exceeded`, exit=1 |

## Prototype P2 — trạng thái kiểm chứng (30/10/2026)

Thêm: `brief.ts` (TaskBrief B1–B3), `worktree.ts` (isolation), `permissions.ts` (matrix theo node),
`policy.ts` (resolve deterministic + log), `dispatch.ts` (orchestrate + task record episodic-lite).

| Kiểm chứng | Kết quả |
|---|---|
| Dispatch implement → **codex workspace-write trong worktree thật** | ✓ tạo `momo.ts` đúng pattern, scope PASS, record + patch lưu |
| Dispatch implement pin claude (acceptEdits) | ✓ worker **tự tôn trọng hàng rào**: bỏ yêu cầu sửa README trong goal vì brief khóa scope |
| Scope violation detector (unit test) | ✓ `README.md` flagged khi ngoài `src/payment/**`; file trong scope pass |
| Dispatch plan → claude read-only | ✓ 0 file thay đổi, plan trả về message |
| Task records | ✓ `.orchestra/tasks/*.json` (brief snapshot B4 + routing log + usage) + `*.patch` |

Chưa làm (thuộc P3): FS watcher in-flight (Lớp 3), deny globs ở tầng flag, merge gate + integration,
policy.yml từ file + track record, gate runner tự chạy acceptance_criteria, CLI adapter thứ ba.

## Prototype P3 — trạng thái kiểm chứng (31/10/2026)

Thêm: `pipeline.ts` (loader + validation V1–V10 + topoSort), `gates.ts` (evaluator deterministic),
`orchestrator.ts` (DAG executor, on_fail/spawn_fix, approval, merge gate, state.json),
`templates/feature-dev.yml` + `hotfix.yml`, demo-repo có test thật (`node --test`).

| Kiểm chứng | Kết quả |
|---|---|
| Chạy pipeline `feature-dev` 4 node tự động | **OK ✓** plan(claude) → implement(codex, worktree) → verify → review → merge vào main |
| Gate `tests.green` | ✓ runner **tự chạy `npm test`** trong worktree (exit=0) — không tin lời worker |
| Gate `verdict.approved` + cross-CLI | ✓ implement=codex, review=claude nhờ `distinct_worker_from`; VERDICT parse deterministic |
| Gate `files_changed <= N` | ✓ 1 file ≤ 10 trước khi merge |
| Bug phát hiện + sửa: run 1 merge khi reviewer nói changes_requested | ✓ sau vá: gate được chấm, unit-test cả 2 chiều pass; run 2 chính xác |
| Multi-task merge thật | ✓ `git merge --no-ff` branch worktree vào main, momo.ts + zalopay.ts nằm trên main |

Chưa chạy end-to-end: vòng spawn_fix (review fail → fix → re-review — code có, unit test có,
nhưng reviewer thật đã approve nên chưa kích hoạt); template hotfix (ask_always);
song song hoá node độc lập; resume run giữa chừng.

Chạy: `node dist/cli.js run-pipeline demo-repo "<goal>" --scope "src/payment/**" --yes`

## Prototype P4 — trạng thái kiểm chứng (31/10/2026)

Thêm: `policy.ts` rewrite (policy.yml từ file + validate P2/P7/P8 + scoring theo track record),
`memory.ts` (fleet stats EMA half-life 30d · episodic sqlite qua `node:sqlite` · feedback events
JSONL+sqlite · KB markdown frontmatter + recall có trần token), `retro.ts` (retrospective v0
sinh proposal, không tự apply), `policy.yml` proto-default, dispatch inject KB vào brief.

| Kiểm chứng | Kết quả |
|---|---|
| `policy <repo>` | ✓ load proto-default, 0 lỗi validate, bindings hiện đúng |
| Simulate 30 task (codex ~70% pass, claude ~95%) | ✓ ema phản ánh đúng: claude 1.00 / codex 0.61 (decay 30d hoạt động) |
| **Routing theo track record** | ✓ claude score 6.00 thắng codex 5.07 dù codex là binding #1 — **số liệu lật ngược cấu hình** |
| Retrospective | ✓ sinh 2 proposals: KB (module src/payment, bằng chứng 30 task) + Policy (coder 100% vs 67%, chênh 33 điểm %) |
| KB injection vào brief | ✓ dispatch plan scope `src/payment/**` → `brief.memory.hits = ["kb-payment-module"]` |
| Feedback events | ✓ user_edit_after_merge + verdict_rejected → sqlite 2 rows + feedback.jsonl mirror |
| Episodic sqlite | ✓ 13 task records sync từ JSON → `node:sqlite`, không dependency ngoài |

Chưa làm (P4.5/P5): matrix UI, track record dùng `user_override_to/from` (cần dispatch UI),
retrospective dùng LLM (đang deterministic), token đếm chính xác (đang ~chars/4).

Chạy: `node dist/cli.js simulate demo-repo 30 && node dist/cli.js stats demo-repo --dir sim-tasks && node dist/cli.js retro demo-repo --dir sim-tasks`

## Prototype P5 slice 1 — VS Code Extension (31/10/2026)

`extension/` — extension nhúng runner core (import trực tiếp `prototype/src`, 1 codebase):

- **Fleet panel** (Activity bar): trạng thái CLI thật — installed/version/auth, experimental badge
- **Tasks panel**: 30 task record gần nhất, click mở record JSON
- **`Orchestra: Dispatch Task`**: input goal/scope/worker → dispatch → **live transcript webview**
  (stream JSONL tô màu theo event type — core thêm hook `onEvent`)
- **`Orchestra: Run Pipeline`**: chọn template → chạy 4 node, log live qua hook `onLog`
- **`Orchestra: Show Policy Matrix`**: webview bảng role×worker (EMA + n) + KB entries

| Kiểm chứng | Kết quả |
|---|---|
| `tsc` strict (core + extension chung 1 compilation) | 0 lỗi |
| Logic test bằng node thường (`test/logic.test.mjs`) | **PASS** — fleet claude@2.1.310 + codex@0.164.0, 13 task records, matrix HTML có roles + KB + policy hợp lệ |
| Đóng gói `vsce package` | **orchestra-0.1.0.vsix** (62 files, 178 KB) — manifest hợp lệ |
| Integration test VS Code GUI (`@vscode/test-electron`) | ⚠ **bị chặn bởi sandbox** — không spawn được Electron GUI từ session này (kể cả khi trỏ `vscodeExecutablePath` vào VS Code đã cài). Đã thử 2 lần |

Cài thử UI thật (chạy tay trên máy):
```bash
code --install-extension "Orchestra/extension/orchestra-0.1.0.vsix"
# hoặc mở dev host: code --extensionDevelopmentPath="Orchestra/extension" "Orchestra/prototype/demo-repo"
```

## Prototype P5 slice 2 — Vault + Conformance + Review&Merge (31/10/2026)

- **`vault.ts`** — Credential Vault DPAPI CurrentUser (`~/.orchestra-vault/`): secret qua stdin
  (không nằm trong command line), runner **tự inject env lúc spawn** theo `manifest.vault`
  (claude → `ANTHROPIC_AUTH_TOKEN`), `vault get` chỉ in dạng mask, key không bao giờ qua LLM
- **`conformance.ts`** — Worker Protocol §10 thành suite thật: case 1 (version), 2 (smoke stream),
  **3 (read-only write block — kiểm chứng bằng yêu cầu ghi thật, file không xuất hiện)**,
  7 (stream contract); case 4/6/8 ghi rõ `n/a P6`; badge JSON `.orchestra/conformance/<id>-<version>.json`
- **Review & Merge UI** — `orchestra.reviewMerge`: quickpick task mergeable (branch chưa vào main,
  phát hiện bằng `merge-base --is-ancestor`) → mở patch → Merge vào main (git merge --no-ff) hoặc
  Reject (+ feedback `verdict_rejected` cho worker — tín hiệu track record)

| Kiểm chứng | Kết quả |
|---|---|
| Vault DPAPI roundtrip (set/get-masked/list/delete) | ✓ — sửa 1 bug thật: PS 5.1 cần `Add-Type System.Security` |
| Conformance **claude 2.1.310** | **badge: pass** (case 1,2,3,7 pass; 4,5,6,8 n/a có lý do) |
| Conformance **codex 0.164.0** | **badge: pass** |
| Review & Merge — merge path | ✓ merge commit vào main từ branch test |
| Review & Merge — reject path | ✓ feedback `verdict_rejected` + branch giữ lại |
| Logic test 4 nhóm + vsce | PASS — `orchestra-0.1.0.vsix` (64 files) chứa reviewMerge |

Chưa làm (P5 slice 3+): matrix **sửa được** (cell → policy.yml diff), dispatch UI lưu
`user_override_to/from`, conformance case 5 cần model+custom provider, case 4/6/8 (P6).

## Prototype P5 slice 3 — Matrix interactive + Override tracking (31/10/2026)

- **Matrix sửa được**: webview `Show Policy Matrix` giờ interactive — click ô worker =
  **promote lên #1** cho role đó → ghi `.orchestra/policy.yml` (project scope) → reload matrix
  + Fleet panel. Đúng triết lý spec: *"cell là nguồn chân truth, sửa = một diff review được"*.
- **Override tracking**: `orchestra.dispatch` khi user chọn worker khác auto-pick → ghi feedback
  `task_reassigned` (từ auto → pin) — tín hiệu `user_override_to/from` cho track record EMA
  (memory-interface §4.2), lần đầu có nguồn dữ liệu thật cho trường này
- **Conformance badge trên Fleet panel**: worker có badge pass/fail từ JSON §10 hiện ngay trong tree

| Kiểm chứng | Kết quả |
|---|---|
| `promoteWorker` (click cell) | ✓ policy.yml project ghi đúng thứ tự (claude trước codex), `source=project`, 0 lỗi validate, cleanup trả lại proto-default |
| `trackOverride` | ✓ đúng 1 event khi override; 0 khi trùng auto-pick; 0 khi dispatch fail |
| `conformanceBadge` | ✓ claude@2.1.310 → `pass` |
| Logic test 7 nhóm | **PASS** |
| vsce | **orchestra-0.1.0.vsix** (64 files, 185 KB) |

Cài thử: `code --install-extension "Orchestra/extension/orchestra-0.1.0.vsix"` → mở demo-repo →
Activity bar rocket icon → thử Dispatch / Review & Merge / Show Policy Matrix (click cell).

## Prototype P6 slice 1 — Supervisor Lớp 3 + deny globs tầng flag (31/10/2026)

- **Lớp 3 — Observed vs Reported**: `fs.watch` recursive trên worktree thu `fsChanged`
  (Observed) song song với `tool_use` targets (Reported) → `computeFsCrossCheck` bất thường
  ra `fs_cross_check` trong task record — *đánh dấu, không auto-kill* (đúng §9b). Heuristic
  đã tinh chỉnh sau khi chạy thật: lọc event thư mục không đuôi file (settle noise lúc
  worktree vừa tạo — phát hiện ngay trên dispatch thật đầu tiên)
- **LivelockDetector**: cùng tool_use lặp ≥5 → kill `livelock_stuck` + event `blocked`
  (§9b tín hiệu 3) — unit test cả 2 chiều
- **Deny globs xuống tầng flag** (Lớp 2): claude `--allowedTools Edit(pattern) Write(pattern)`
  theo `files_in_scope` — ghi ngoài scope bị CLI denied ngay, không phải đợi post-run
- **Conformance case 4 chạy thật**: worker bị yêu cầu tạo `out.txt` (ngoài scope) + `in-scope/a.txt`
  → **out.txt không xuất hiện** = flag-level enforcement được chứng minh thực nghiệm
- **Badge stale**: CLI update mà chưa chạy lại conformance → Fleet panel hiện `stale` (vàng)

| Kiểm chứng | Kết quả |
|---|---|
| LivelockDetector (5 lần giống nhau / 5 target khác nhau) | ✓ đúng 2 chiều |
| computeFsCrossCheck (file lạ bắt / thư mục lọc) | ✓ sau tinh chỉnh từ real-run |
| claude scope args → `Edit(src/payment/**) Write(src/payment/**)` | ✓ |
| Conformance claude **badge: pass** (case 1,2,3,4,7 pass) | ✓ — case 4 thực nghiệm |
| Conformance codex **badge: pass** (case 4 n/a — không hỗ trợ path rules) | ✓ |
| FS cross-check trong dispatch thật | ✓ `fs_cross_check` vào record — và bắt được noise, dẫn tới tinh chỉnh |
| Logic tests + vsce | PASS — `orchestra-0.1.0.vsix` (64 files) |

Còn lại của P6: case 6 network OS-level (proxy/ETW), case 8 hooks pre-execution, session
resume/hot-swap, macOS/Linux verify, beta users — không làm được trong session này (đã ghi lý do).

## Prototype P6 slice 2 — Hooks + Session Resume (31/10/2026): HOÀN THIỆN P6

- **`hooks/guard.cjs`** — PreToolUse hook chặn **trước khi lệnh chạy** (Lớp 1 hoàn chỉnh):
  net-off patterns (curl/wget/nc/ssh/...), `git push`, `rm -rf /`, path escape khỏi worktree.
  Runner tự sinh settings file (`--settings`) cho CLI hỗ trợ (claude), env `ORCH_GUARD_*` truyền cấu hình.
  *Lưu ý trung thực: net là pattern-level, không phải OS guarantee — case 6 OS-level vẫn n/a.*
- **Session resume** — `runHeadless` capture session id, `resumeSession` → claude `--resume`;
  orchestrator **retry node implement tự resume session cũ** (sửa lỗi không mất context).
  *Hot-swap worker giữa chừng vẫn chưa làm — cần dịch transcript giữa các CLI.*
- **Portability audit**: vault trả null trên non-Windows (không crash), taskkill/fswatch đã guard.

| Kiểm chứng | Kết quả |
|---|---|
| guard.cjs unit — 5 rules (curl/net-off qua, npm test qua, git push, path escape, trong worktree) | **5/5 PASS** |
| Conformance claude **case 8 thật**: curl + net off → hook deny, bằng chứng trong stream | **PASS** — badge: **pass (case 1,2,3,4,7,8)** |
| Conformance codex | badge: pass (case 4/8 n/a có lý do) |
| **Session resume thực nghiệm**: phiên 1 nhớ số 42 → phiên 2 resume cùng session id → trả lời đúng "42" | **PASS** |
| Logic tests + vsce | PASS — `orchestra-0.1.0.vsix` (64 files) |

**P6 kết luận**: supervisor đủ 4 lớp với case 3/4/8 kiểm chứng thực nghiệm; case 6 OS-level là
mục còn lại (cần hạ tầng proxy/ETW). Còn ngoài tech: beta users, macOS/Linux verify — thuộc
phần việc con người/môi trường.

## Prototype P5.4 — VS Code Settings + Skill-sync v0 (31/10/2026)

Trả lời 2 câu hỏi thiết kế: "cấu hình setting ntn?" và "skill/plugin ra sao?" — bằng code chạy được.

**Settings** (`contributes.configuration` — hiện trong VS Code Settings UI, 저장 trong settings.json):

| Setting | Mặc định | Ý nghĩa |
|---|---|---|
| `orchestra.defaultRepo` | "" | Repo khi workspace không có `.orchestra/` |
| `orchestra.autoApprovePlan` | false | Run Pipeline tự duyệt plan |
| `orchestra.hooksEnabled` | true | Guard hook pre-execution (git push / net patterns / path escape) |
| `orchestra.skillSync` | true | Tự sync KB → AGENTS.md/CLAUDE.md trước mỗi dispatch |
| `orchestra.templatesDir` | "" | Thư mục pipeline templates |

**Kiến trúc skill/plugin của Orchestra — 4 tầng:**

| Tầng | Cơ chế | Phân phối |
|---|---|---|
| Editor plugin | VS Code extension (VSIX) | Marketplace |
| Fleet plugin | Agent manifest (registry §3 Worker Protocol) | PR vào registry + conformance CI |
| **Knowledge plugin — skill** | KB entry `.orchestra/kb/*.md` → **skill-sync render ra `AGENTS.md` + `CLAUDE.md`** ở repo root → worker CLI đọc ngay khi checkout worktree | Git (repo là marketplace) |
| Workflow plugin | Pipeline template `.orchestra/pipelines/*.yml` | Git + marketplace sau |

**Skill-sync v0 đã chạy thật**: `syncSkills(repo)` render 1 KB entry → `AGENTS.md` + `CLAUDE.md`
với header AUTO-GENERATED + id truy vết; dispatch gọi tự động **trước khi tạo worktree** nên
worker nhận phiên bản mới nhất; command `Orchestra: Sync Skills` + CLI `sync-skills`.

| Kiểm chứng | Kết quả |
|---|---|
| Logic test 8 nhóm (thêm skillsync: files + nội dung + header + id) | **PASS** — test bắt 1 bug thật: render thiếu id KB → sửa |
| sync-skills thật trên demo-repo | ✓ AGENTS.md/CLAUDE.md sinh đúng nội dung payment-module |
| vsce | **orchestra-0.1.0.vsix** (65 files, 190 KB) — có configuration + syncSkills command |

## Prototype P5.5 — Model riêng cho từng CLI (31/10/2026)

**Trả lời "cấu hình riêng model cho CLI nào không?": có — ở 4 mức, và gap thật vừa được vá.**

Thiết kế có từ đầu (spec) nhưng implement mới tới CLI flag; giờ model chảy từ policy tới worker:

| Mức | Cách | Ưu tiên |
|---|---|---|
| 1. Per-invocation | `dispatch --model worker-codex` / input box trong extension | cao nhất |
| 2. Per-binding (policy.yml) | `- worker: { cli: codex, model: gpt-5.3-codex }` — **role `coder` của codex dùng model X, role `reviewer` của codex dùng model Y** | theo policy |
| 3. Per-slot (manifest `model_slots`) | claude có slot fast (`ANTHROPIC_DEFAULT_HAIKU_MODEL`), opencode có plan/small_model | theo manifest |
| 4. Mặc định CLI | không truyền gì | nền |

Vá được: `resolveWorker` giờ trả `model` từ binding → `dispatch` truyền xuống spawn
(`claude --model X`, `codex -c model=X`) → `record.routing.model` + `brief.model` ghi vết.

| Kiểm chứng | Kết quả |
|---|---|
| Policy fixture với `model: gpt-test-x` trong binding → resolveWorker trả đúng pick+model | ✓ |
| Args: claude `--model worker-claude`, codex `-c model=worker-codex` | ✓ |
| **Dispatch thật** `--model worker-claude` → record `routing.model` + `brief.model` | ✓ |
| Logic tests + vsce | PASS — 65 files |

## Prototype P5.6 — Chat với Orchestrator (01/11/2026)

Lấp lỗ hổng UX lớn nhất: **Chat panel trong sidebar** — giao tiếp tự nhiên với orchestrator
thay vì chỉ input box.

**Kiến trúc chat** (giống đúng vai trò orchestrator trong thiết kế):
- **Brain = 1 CLI trong fleet** (setting `orchestra.orchestratorWorker`, mặc định claude) chạy
  **read-only + net-off + guard hook** — orchestrator không tự làm, chỉ tư vấn và phát hành action
- **`--append-system-prompt`** nạp nhân cách orchestrator + bảng action; **session resume** giữ
  nguyên hội thoại giữa các tin nhắn (brain "nhớ" như chat thật)
- Orchestrator phát hành action trong fenced block ```orchestra {json}``` → extension parse +
  **thực thi qua đường dispatch/pipeline đầy đủ guard** → kết quả `[orchestra-runner]` feedback
  lại vào session → orchestrator phản hồi tiếp. Vòng lặp agent hoàn chỉnh.

| Action | Làm gì |
|---|---|
| `dispatch {goal, scope?, worker?, model?}` | dispatch implement worker (có guard + skill-sync + override tracking) |
| `pipeline {template, goal, scope?}` | chạy 4-node pipeline |
| `status` | fleet + 5 task gần nhất |
| `sync_skills` | KB → AGENTS.md/CLAUDE.md |

| Kiểm chứng | Kết quả |
|---|---|
| Parser action (block hợp lệ + block JSON lỗi) | ✓ 1 nhận, 1 bỏ qua không crash |
| **Real chat turn**: "Bạn là ai?" → orchestrator tự giới thiệu đúng vai + có session id | ✓ |
| vsce | **orchestra-0.1.0.vsix** (65 files) — Chat view trong sidebar |

### P5.7 — Chat biết "thêm vào chỗ nào" (01/11/2026)

Vá 2 lỗ hổng: chat brain thiếu KB injection + thiếu rule xác định scope. Sau vá, **thử nghiệm
thật với input tự nhiên không nói vị trí**: *"Thêm cổng thanh toán VNPay vào shop cho tôi."*

Orchestrator tự làm đủ 4 bước (đúng thiết kế 4 nguồn):
1. Đọc project memory → biết module payment ở `src/payment/gateways/`, 3 gateway có sẵn, pattern chung
2. Khảo sát repo (Glob/Grep/Read trong plan mode) xác nhận
3. Phát hành dispatch với **scope đúng** `["src/payment/**","tests/payment.test.ts"]`
4. Goal ghi rõ constraint từ KB: `import type`, không parameter property, UTF-8 không BOM — kể cả đề nghị thêm test

→ Worker nhận brief có hàng rào chuẩn mà user chỉ gõ một câu. Nếu orchestrator vẫn không chắc
scope → rule 4c buộc nó hỏi lại user thay vì đoán; nếu vẫn thiếu scope → B1 từ chối dispatch.

## Prototype P6.3 — Install Worker từ Fleet panel (01/11/2026)

Trả lời "không có codex/claude trên máy thì VS Code thấy được để tải về?": giờ có cơ chế thật.

- **Manifest `install`**: `npm` là kênh chuẩn (`@anthropic-ai/claude-code`, `@openai/codex`), winget fallback
- **`installWorker(id)`**: kiểm tra npm trên PATH → `npm i -g` stream log → verify version bằng chính `version_check` của manifest
- **Fleet panel**: worker `✗` chưa cài **click là cài** — progress notification + log ra Output channel "Orchestra — install"
- **Auth sau install**: OAuth trình duyệt không tự động được (đúng spec §4) — extension mở terminal và nhắc chạy CLI lần đầu để login
- Lưu ý trung thực: máy cần Node.js/npm (installer kiểm tra và báo rõ); sau install PATH mới có thể cần restart VS Code

| Kiểm chứng | Kết quả |
|---|---|
| Cycle thật: install gói npm nhỏ → `checkStatus` thấy bin trên PATH → uninstall → sạch | **PASS** |
| Trường hợp chưa thấy PATH sau install | báo đúng message hướng dẫn (không crash) |
| Logic tests + vsce | PASS — **orchestra-0.2.0.vsix** |

## Prototype P6.4 — Auth & Custom Provider (01/11/2026)

Trả lời "chỗ nào cấu hình custom provider, OAuth openai/anthropic?" — đúng kiến trúc
"Orchestra sync auth xuống CLI" (Worker Protocol §5/§6): **spawn-time env injection, không đụng config CLI**.

**Vault v2**: entry `{secret, base_url}` (JSON trong DPAPI) — không chỉ key mà là provider config.
**`resolveVaultEnv(manifest)`**: 1 hàm duy nhất trả env cần inject — key + base_url.

| CLI | Key env | Base URL env (custom provider) |
|---|---|---|
| claude | `ANTHROPIC_AUTH_TOKEN` | `ANTHROPIC_BASE_URL` |
| codex | `OPENAI_API_KEY` | `OPENAI_BASE_URL` |

**UI — command `Orchestra: Auth Worker`** (Fleet panel → chọn worker):
- `Login (OAuth/subscription)` — mở terminal chạy CLI, trình duyệt mở OAuth; xong bấm Refresh Fleet
- `API key → Vault` — input password box, lưu DPAPI, inject lúc spawn
- `Custom provider` — base URL + key (vd gateway nội bộ) → 2 env inject lúc spawn
- `Xoá credential`

| Kiểm chứng | Kết quả |
|---|---|
| Vault v2 roundtrip: key + base_url lưu/get riêng | ✓ |
| `resolveVaultEnv(claude)` → `{ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL}` | ✓ |
| Codex chưa cấu hình → `{}` (không inject rác) | ✓ |
| Set key riêng **giữ nguyên base_url** — bug bắt từ test, sửa | ✓ |
| Logic tests + vsce | PASS — **orchestra-0.2.1.vsix** |

**Ranh giới trung thực**: OAuth subscription là state của CLI bản thân nó (token do CLI tự quản
sau login) — Orchestra KHÔNG lưu/copy OAuth token, chỉ (a) mở terminal guided flow, (b) phát hiện
trạng thái auth, (c) sync phần Orchestra quản: API key + custom provider base URL qua env lúc spawn.

### Auth domain rule (P6.5) — encode thành luật trong manifest

> **CLI của provider nào chỉ OAuth được provider đó.** Model của provider khác → duy nhất
> đường API key + custom provider (gateway dịch API). Codex không thể OAuth Anthropic.

| CLI | OAuth domain (`manifest.oauthProvider`) | Đường chéo provider khác |
|---|---|---|
| claude | `anthropic` | vault custom provider → `ANTHROPIC_BASE_URL` + key |
| codex | `openai` | vault custom provider → `OPENAI_BASE_URL` + key (gateway OpenAI-compatible) |

UI phản ánh luật: nhãn Login ghi rõ `OAuth <provider> (subscription của CLI này)`, option
Custom provider ghi rõ "ĐƯỜNG DUY NHẤT để CLI chạy model của provider khác". Cùng vault
provider-name không đồng nghĩa cùng OAuth domain — vault là kênh API, OAuth là kênh subscription,
hai thứ tách bạch tuyệt đối.

**orchestra-0.2.2.vsix** — 9/9 logic tests PASS.

## Prototype P6.6 — Model Registry + phân phối channel-based (01/11/2026)

Chốt luật bạn phát biểu: **Orchestra liệt kê MỌI model — nhưng phân phối cho CLI dựa trên
khả năng hỗ trợ + provider của CLI đó.**

- **`models.yml`** (Model Registry): mọi model kèm `family` (provider gốc) + `gateway`
  (vault provider cho model custom) — native anthropic/openai/google + custom endpoint models
- **`resolveModelFor(cli, model)`** → kênh phân phối:
  - `native` — model family === oauthProvider của CLI (claude+anthropic, codex+openai, antigravity+google)
  - `custom-gateway` — CLI `custom_provider: true` + gateway đã cấu hình trong vault
  - `unavailable` — CLI không hỗ trợ (antigravity: `custom_provider: false` → CHỈ native google)
- **`resolveWorker` tự skip** binding không khả thi (kèm lý do qua `onSkip`) → fallback ứng viên kế
- **Manifest antigravity** vào fleet: `oauthProvider: google`, `custom_provider: false` — thể hiện luật
- **Matrix hiển thị channel tag** xanh/đỏ từng binding + tooltip lý do

| Phân phối (đã test) | Kết quả |
|---|---|
| claude + opus-4.6 → native | ✓ |
| codex + worker-codex, vault 'openai' có gateway | ✓ custom-gateway |
| codex + worker-codex, vault trống | ✗ unavailable — đúng, escalate |
| **antigravity + opus-4.6 / worker-codex** | **✗ unavailable — luật của bạn được enforce** |
| antigravity + gemini-3-pro | ✓ native google |
| resolveWorker: binding antigravity+opus bị skip → fallback codex | ✓ kèm log lý do |

**orchestra-0.2.3.vsix** — 9/9 logic tests PASS.

## Orchestra Desktop — P-D1 + P-D2 (01/11/2026)

App độc lập Electron theo [desktop-plan.md](docs/desktop-plan.md) — **core tái dùng 100%**
(`prototype/src` + `extension/src/logic.ts` import trực tiếp, 0 rewrite logic).

```
desktop/
  src/main/    main.ts (window + tray + single-instance) · ipc.ts (20 channels)
               contract.ts (IPC thuần — unit test) · settingsStore.ts (userData JSON)
  src/preload.cjs    contextBridge (nodeIntegration OFF, contextIsolation ON)
  src/renderer/      6 page vanilla: Dashboard · Chat · Transcript · Matrix · Wizard · Settings
```

| Tính năng | Chi tiết |
|---|---|
| **Dashboard** | Fleet + dispatch form (worker/model) + pipeline + task records + **live stream** |
| **Chat** | cùng vòng lặp `chatExchange` với extension (tách ra dùng chung — hết 2 bản) |
| **Tray + Notification** | chạy nền; notify khi dispatch/pipeline xong, gate chờ duyệt |
| **Plan approval qua modal** | core thêm `askUser` injectable — Desktop dùng dialog modal thay stdin |
| **Multi-repo** | settings.repos + activeRepo, switch không restart |
| **Setup Wizard** | install worker (npm, stream log) · vault key/custom provider · conformance smoke · skill-sync |
| **Settings UI** | đọc/ghi cùng schema — repos, autoApprovePlan, hooksEnabled, skillSync, orchestratorWorker |

| Kiểm chứng | Kết quả |
|---|---|
| `tsc` strict cả 3 suite (prototype + extension + desktop, 1 compilation) | 0 lỗi |
| Contract test (20 IPC channels unique, validateSettings filter/defaults, settingsStore roundtrip + broken-file fallback, pages) | **PASS** |
| renderer/preload syntax check | PASS |
| `chatExchange` real turn qua đường dùng chung | ✓ (logic test 9 nhóm) |
| electron-builder NSIS | chạy packaging thật (kết quả ở release/) |
| GUI launch trong sandbox | ⚠ không chạy được (đã biết từ P5) — chạy thật trên máy: `cd Orchestra/desktop && npm start` |

Chạy dev: `cd Orchestra/desktop && npm install && npm run build && npm start`

| Packaging (electron-builder NSIS) | Kết quả |
|---|---|
| Build 1: winCodeSign symlink privilege | ✗ — **fix**: `signAndEditExecutable: false` (beta unsigned) |
| Build 2 | **✓ `Orchestra Desktop Setup 0.1.0.exe` (82 MB) + win-unpacked** |
| **Boot check exe đóng gói**: process sống 8s không crash (main+preload+renderer load đúng), kill sạch | **PASS** — GUI thật chờ bạn mở |
| Cài: chạy `release/Orchestra Desktop Setup 0.1.0.exe` (SmartScreen unsigned → More info → Run anyway) | — |

**Lưu ý trung thực**: GUI render từng page cần mắt người xem — process-level đã chứng minh app đóng gói
khởi động sạch; 6 page dùng đúng các hàm logic đã qua 9 nhóm test. node-pty terminal nhúng chưa làm
(dồn sang P-D3 — transcript stream đã thay thế tạm).

## Orchestra Desktop — P-D3 (01/11/2026): Terminal nhúng + Auto-update wiring

| Tính năng | Chi tiết |
|---|---|
| **Terminal nhúng** | `@lydell/node-pty` **prebuilt N-API** (không cần electron-rebuild/MSVC — đã test spawn cmd thật), powershell trong repo active, stream real-time, session mới/exit; IPC `terminal:create/input/resize/kill` + events `terminal:data/exit` |
| **Auto-update wiring** | electron-updater guarded (`app.isPackaged` + try/catch — kích hoạt khi publish GitHub Releases ở P7); `update:check` channel + nút trong Settings; `asarUnpack` cho `*.node` |
| **E2E Gate checklist** | [docs/desktop-e2e-gate.md](docs/desktop-e2e-gate.md) — 7 nhóm G1–G7, GUI items cần mắt người dùng |

| Kiểm chứng | Kết quả |
|---|---|
| node-pty smoke: spawn cmd thật qua prebuilt binary | ✓ (không cần MSVC) |
| Contract test 25 channels + 6 events | PASS |
| Repackage với native module: `conpty.node` unpacked đúng `app.asar.unpacked` | ✓ |
| **Boot check lần 2** (exe có native module): process sống 8s, kill sạch | **PASS** |
| electron-updater wiring | ✓ guarded — kích hoạt khi có GitHub Releases (P7); publish config tạm bỏ vì chưa có repo/token (lỗi `provider of null` đã gặp và xử lý) |
| Fix chính giữa chặng | `@lydell/node-pty` nạp binary qua platform package riêng (`node-pty-win32-x64`) — cài trực tiếp thay vì optionalDependencies bị npm chặn |

## Desktop E2E Gate — KẾT QUẢ (01/11/2026)

**[docs/desktop-e2e-gate.md](docs/desktop-e2e-gate.md)** — máy-verified:

- **Silent install `/S`** → `%LOCALAPPDATA%\Programs\Orchestra Desktop\` ✓ (fix: kill instance cũ giữ mutex)
- **Boot exe ĐÃ CÀI** ✓ — process sống 8s
- **G2 dispatch** qua đúng handler `IPC.DISPATCH`: events đầy đủ, scope OK, session lưu ✓
- **G3 pipeline + modal approval**: pipeline **dừng hỏi thật** (`approvalAsked=true` qua `askUser` injectable) → 5 node done, gates xanh → **merged vào main** ✓; transcript 12 dòng stream ✓
- **G4 chat brain** ✓ · **G5 pty smoke** ✓ · **G6 vault** ✓ (P6.4) · **G7 updater wired** (pending Release)

→ **Gate P-D1/P-D2 PASS ở mức máy-verified đầy đủ.** Còn lại: [EYES] xác nhận GUI + publish Release (P7). E2E rerun: `cd Orchestra/desktop && node test/e2e-headless.mjs`

## 🚀 GitHub + Release — LIVE (01/11/2026)

- **Repo**: [github.com/datnp1003/Orchestra](https://github.com/datnp1003/Orchestra) (private)
- **Release v0.1.0**: [releases/tag/v0.1.0](https://github.com/datnp1003/Orchestra/releases/tag/v0.1.0) — assets: `latest.yml` + Setup exe + blockmap
- **Auto-updater: LIVE** (electron-updater ↔ GitHub Releases) — repo private nên update-check cần token; **public repo = updater cho mọi user** (quyết định P7)
- Screenshot [EYES]: máy đang **locked** (chụp được lock screen — bằng chứng vật lý); unlock → chạy `desktop/test/screenshot.ps1` là có ảnh 6 page

Còn lại: unlock-máy [EYES] · macOS/Linux · code signing · repo public · beta — tất cả ngoài session.

Chạy prototype:
```bash
cd Orchestra/prototype
npm install && npm run build
node dist/cli.js list
node dist/cli.js smoke claude --save-fixture
node dist/cli.js dispatch demo-repo "Thêm MomoGateway..." --node implement --role coder --scope "src/payment/**"
node dist/cli.js tasks demo-repo
```
