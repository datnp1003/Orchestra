# Orchestra Memory Interface — Spec v0.1

Mảnh cuối của bộ spec: hợp đồng thống nhất cho 7 tầng memory — ai ghi, ai đọc, inject vào
brief thế nào, và backend nào giữ. Chốt nguyên tắc đã bàn: **retrospective job là hệ ghi
chính, các brain chỉ là nơi lưu + truy vấn — đổi brain không mất kiến thức.**

---

## 1. Nguyên tắc (bất biến)

1. **Memory là adapter, không phải lựa chọn.** Tầng 6 (semantic) cắm backend được
   (sqlite-vec | Mem0 | Zep/Graphiti | Cognee); tầng 2, 7 mặc định SQLite; tầng 3 **khoá cứng
   là file markdown trong repo** — không backend hoá, vì memory của project phải review bằng
   git diff được.
2. **Hai chế độ đọc, không trộn**: *inject luôn* (tầng 3, 4, 5 — nhỏ, quyết định chất lượng brief)
   và *tra khi cần* (tầng 2, 6, 7 — lớn, tra theo nhu cầu node). Không bao giờ bơm episodic thô
   vào brief.
3. **Ghi phân quyền**: runner ghi episodic + fleet tự động; KB chỉ được ghi qua
   proposal-merge hoặc tay user; worker và orchestrator LLM **không bao giờ ghi thẳng KB**.
4. **Mọi recall hit phải có xuất xứ** (tầng nào, từ record nào) — không có context không thể truy vết.
5. **Episodic là append-only.** Sửa = ghi sự kiện mới; xoá = tombstone. Audit được mọi lúc.
6. **Không có secret trong memory.** Key chỉ sống trong vault (Worker Protocol §5).
7. **Budget brief có trần.** Memory inject vào brief bị giới hạn token; tràn → priority eviction,
   ghi log những gì bị bỏ.

## 2. Bảng phân vai 7 tầng

| # | Tầng | Backend | Ai ghi | Đọc | Schema |
|---|---|---|---|---|---|
| 1 | Working | context window | — | inject | (transcript lưu kèm episodic) |
| 2 | Episodic | SQLite `.orchestra/episodic.sqlite` + FTS5 | runner tự động | tra khi cần | §4.1 |
| 3 | Project KB | `.orchestra/kb/*.md` (git) | user merge proposal / user tay | **inject luôn** (có trần) | §4.3 |
| 4 | Policy | `policy.yml` (Role Policy spec) | user merge proposal | inject luôn | — xem spec riêng |
| 5 | User | `~/.zcode/memory/*.md` | user + proposal | inject luôn (500 tok) | §4.4 |
| 6 | Semantic | **adapter**: sqlite-vec (mặc định) \| Mem0 \| Zep/Graphiti \| Cognee | runner (facts chưng cất) | tra khi cần | §4.5 |
| 7 | Fleet | SQLite `fleet_stats` | runner tổng hợp | tra khi route | Role Policy §5 |

## 3. Interface — 4 operation + 2 admin

```ts
interface MemoryBackend {
  // ghi — chỉ runner gọi; KB backend trả lỗi nếu caller không phải proposal pipeline
  remember(entry: Entry): Promise<Id>;

  // tra — trả hit có điểm + xuất xứ (luật M4)
  recall(q: Query): Promise<Hit[]>;

  // xoá mềm — tombstone + audit, không xoá vật lý
  forget(id: Id, reason: string): Promise<void>;

  // chưng cất — CHỈ đọc + trả proposal, không tự ghi (nguyên tắc 3)
  consolidate(window: Window): Promise<Proposal[]>;

  // admin
  pin(id: Id, on: boolean): Promise<void>;     // KB entry luôn-inject, không tốn quota query
  audit(id: Id): Promise<History[]>;           // toàn bộ vòng đời entry
}
```

Composite backend route theo tầng: mỗi tier binding một backend instance (§2); Tier-6 adapter
swap bằng config, các tier còn lại không đổi → đổi brain không mất KB, không mất episodic.

```yaml
# .orchestra/memory.yml
semantic_backend: sqlite-vec          # | mem0 | zep | cognee
semantic:
  embedding: { model: local-bge-m3, dim: 1024 }   # local mặc định — code không rời máy
  hybrid: { fts: 0.5, vector: 0.5, recency_boost: 0.1 }
brief_budget:
  project_tokens: 2000                # trần inject tầng 3
  user_tokens: 500                    # trần inject tầng 5
```

## 4. Schema lưu trữ

### 4.1 TaskRecord (episodic — 1 dòng mỗi task, append-only)

```jsonc
{
  "id": "task-17",
  "pipeline": "feature-dev@1", "task_type": "feature",
  "params": { "target": "Thêm cổng Momo vào checkout" },
  "briefs": [{ "node": "implement", "brief_ref": "…", "memory_hits": ["kb:payment-module"] }],
  "routing": [{ "node": "implement", "pick": "codex/gpt-5.3-codex",
                "scores": { }, "reason": "tag=backend boost + ema 0.82" }],
  "artifacts": [{ "node": "implement", "type": "diff", "ref": "wt/task-17.patch" }],
  "gates": [{ "node": "verify", "result": "pass", "details_ref": "…" }],
  "incidents": [{ "type": "kill", "code": "overreach", "worker": "codex", "detail": "…" }],
  "user_actions": [{ "type": "edit_after_merge", "files": ["src/payment/momo.ts"] }],
  "merge": { "order": ["task-15", "task-17"], "integration": "pass" },
  "cost": { "usd": 4.1, "minutes": 38 },
  "started_at": "…", "merged_at": "…"
}
```

### 4.2 FeedbackEvent (episodic — tín hiệu vàng, append-only)

| type | Kích hoạt | Điểm cho |
|---|---|---|
| `user_edit_after_merge` | user sửa file sau khi merge | âm cho worker node implement |
| `verdict_rejected` | user bác review verdict | âm cho reviewer, dương cho coder bị oan |
| `task_reassigned` | user đổi gán task sang CLI khác | âm CLI bị bỏ, dương CLI được chọn |
| `kill_misjudged` | user kết luận supervisor kill nhầm | âm cho rule gây kill |
| `kb_correction` | user sửa KB entry sau khi nó đã inject | âm cho entry, dương cho bản sửa |
| `pipeline_modified` | user sửa template sau task | tín hiệu cho retrospective |

### 4.3 KBEntry (tầng 3 — markdown + frontmatter, trong repo)

```markdown
---
id: kb-payment-module
title: "Payment module"
scope: ["src/payment/**"]
tags: [payment, architecture]
source: consolidated          # consolidated | manual | worker-note(qua review)
confidence: high
pinned: false
supersedes: null
updated: 2026-10-30
---
Checkout nằm ở `src/pages/checkout`; gateway theo adapter pattern
(`PaymentGateway`, tham khảo `stripe.ts`). Module này **bắt buộc e2e**
và không được thêm dependency mới mà không qua user.
```

Quy ước: 1 entry 1 chủ đề, ≤ 40 dòng; `pinned: true` = luôn inject, không tốn quota query.

### 4.4 User memory (tầng 5) — markdown `~/.zcode/memory/`

Cùng format frontmatter, scope = "all-projects". Ví dụ: "comment tiếng Việt", "không dùng
class component", "luôn hỏi trước khi bump major dependency".

### 4.5 SemanticFact (tầng 6 — backend-agnostic record)

```jsonc
{
  "id": "sf-201", "text": "Momo gateway rate-limit 10 req/s ở sandbox",
  "entities": ["momo", "payment"], "task_ref": "task-17",
  "valid_from": "2026-10-30", "valid_until": null,     // temporal — Zep-style khi dùng backend graph
  "ttl_days": 90
}
```

## 5. Injection policy vào brief (chế độ đọc 1)

Thứ tự ưu tiên khi tràn budget — runner eviction, log những gì bị bỏ:

```
1. user memory (tầng 5)                    ≤ 500 tok
2. KB pinned (pinned: true)
3. KB khớp files_in_scope của brief        ≤ 2000 tok tổng tầng 3
4. KB khớp tags của task
5. lessons gần đây (consolidated, 30d)     → tràn thì cắt từ dưới lên
```

- Hits được ghi vào `brief.memory_hits` → worker có thể tham chiếu; review đối chiếu
  hành vi worker với KB đã inject (vi phạm KB = fail review, là feedback event).
- **Conflict rule**: KB `manual` > KB `consolidated` > phán đoán model. Entry cũ vs mới:
  `supersedes` chốt, bản cũ tombstone.
- Retrieval theo node (DSL `memory.retrieval`): node khai báo nguồn + query — plan node tra
  `[episodic, semantic, fleet]`, node khác mặc định không tra (tiết kiệm, tránh nhiễu).

## 6. Consolidate — động cơ của retrospective job

```
Kích hoạt: sau mỗi N task (mặc định 10) | hàng đêm | user gọi tay

Input : TaskRecords + FeedbackEvents trong window (mặc định 30d)
Bước 1. Cluster theo module/theme (files_touched, tags)
Bước 2. Trích lessons: cái gì lặp lại, fail vì gì, entry point nào hay dùng,
        pattern nào worker hay vi phạm
Bước 3. Diff với KB hiện tại: entry mới? bản cập nhật (supersedes)? entry sai (kèm bằng chứng)?
Bước 4. Đề xuất còn trỏ sang Role Policy (route, budget) — theo điều kiện n ≥ min_sample
Output: Proposal[] → PR [orchestra-proposal]:
        - diff .orchestra/kb/*.md          (KB addition/update/correction)
        - diff .orchestra/policy.yml       (nếu đủ điều kiện §6 Role Policy)
```

Guardrails: mỗi đề xuất kèm bằng chứng (số task, số lần lặp); không đề xuất khi sample nhỏ;
đề xuất bị đóng không nhắc lại trừ khi bằng chứng tăng đáng kể.

## 7. Sự kiện → tầng ghi (mapping tắt)

| Sự kiện | Tầng ghi |
|---|---|
| dispatch / kill / gate result / merge / cost | 2 (episodic) |
| user edit sau merge, bác verdict, đổi gán | 2 (feedback event) |
| `files_touched` của task merge xong | 2 → ứng viên KB ở lần consolidate kế |
| kill/block/s override lặp lại | 7 (fleet counters) |
| facts chưng cất từ task ("rate-limit 10/s") | 6 (semantic) |
| lessons được duyệt | 3 (KB, qua PR) |
| đề xuất route/budget được duyệt | 4 (policy.yml, qua PR) |

## 8. Validation rules (luật cứng)

| # | Luật |
|---|---|
| M1 | KB (tầng 3) chỉ được ghi qua proposal-merge hoặc tay user. Worker/orchestrator ghi thẳng → từ chối, chuyển thành worker-note đợi review |
| M2 | Không secret/credential trong mọi tầng — scan khi ghi, phát hiện → từ chối + cảnh báo |
| M3 | Brief inject có trần; runner eviction theo §5 và log danh sách bị bỏ vào task record |
| M4 | Mọi recall hit phải mang `{tier, source_ref, score}` — hit không xuất xứ không được dùng |
| M5 | Episodic append-only; corrections là sự kiện mới, không UPDATE |
| M6 | `forget` = tombstone + audit; xoá vật lý chỉ qua admin tool, hai lớp xác nhận |
| M7 | KB entry thiếu frontmatter hợp lệ / quá 40 dòng → warning; `manual` vs `consolidated` đụng độ → manual thắng + flag |
| M8 | Adapter phải hiện thực đủ 4 operation; swap backend chỉ hợp lệ ở tầng 6 — tầng 3 không được trỏ backend khác |
| M9 | SemanticFact hết TTL → ẩn khỏi recall mặc định, xuất hiện khi query `include_expired` |

## 9. Mở sau v0.1

- Worker-note: worker đề xuất KB entry qua artifact, review node sàng trước → pipeline ít cần consolidate toàn cục
- Memory team-sync: KB đã đi theo git — thêm convention PR review như code review
- Đánh giá chất lượng memory: metric "brief hit usefulness" (KB inject mà worker có dùng tới không — đo từ hành vi tool_use)
- Multi-project user memory với precedence rõ (project > user khi xung đột)
