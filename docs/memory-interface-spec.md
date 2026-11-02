# Orchestra Memory Interface — Spec v0.1
> English only (canonical). Vietnamese UI strings live in prototype/src/i18n/vi.ts.

The last piece of the spec set: a unified contract for the 7 memory tiers — who writes, who reads, how it is
injected into briefs, and which backend holds it. Settles the principle discussed: **the retrospective job is the
primary writer; brains are only storage + query — switching brains loses no knowledge.**

---

## 1. Principles (invariant)

1. **Memory is an adapter, not a choice.** Tier 6 (semantic) has a pluggable backend
   (sqlite-vec | Mem0 | Zep/Graphiti | Cognee); tiers 2 and 7 default to SQLite; tier 3 is **hard-locked
   to markdown files in the repo** — never backend-ified, because project memory must be reviewable via
   git diff.
2. **Two read modes, never mixed**: *always inject* (tiers 3, 4, 5 — small, decide brief quality)
   and *look up on demand* (tiers 2, 6, 7 — large, queried per node need). Never pump raw episodic
   into a brief.
3. **Permissioned writes**: the runner writes episodic + fleet automatically; the KB is only written via
   proposal-merge or by the user's hand; workers and the orchestrator LLM **never write the KB directly**.
4. **Every recall hit must have provenance** (which tier, from which record) — no untraceable context.
5. **Episodic is append-only.** Edit = write a new event; delete = tombstone. Auditable at any time.
6. **No secrets in memory.** Keys live only in the vault (Worker Protocol §5).
7. **The brief budget has a ceiling.** Memory injected into a brief is token-limited; overflow → priority eviction,
   logging what was dropped.

## 2. Role table for the 7 tiers

| # | Tier | Backend | Written by | Read | Schema |
|---|---|---|---|---|---|
| 1 | Working | context window | — | inject | (transcript stored alongside episodic) |
| 2 | Episodic | SQLite `.orchestra/episodic.sqlite` + FTS5 | runner, automatic | on demand | §4.1 |
| 3 | Project KB | `.orchestra/kb/*.md` (git) | user-merged proposal / user by hand | **always inject** (capped) | §4.3 |
| 4 | Policy | `policy.yml` (Role Policy spec) | user-merged proposal | always inject | — see separate spec |
| 5 | User | `~/.zcode/memory/*.md` | user + proposal | always inject (500 tok) | §4.4 |
| 6 | Semantic | **adapter**: sqlite-vec (default) \| Mem0 \| Zep/Graphiti \| Cognee | runner (distilled facts) | on demand | §4.5 |
| 7 | Fleet | SQLite `fleet_stats` | runner aggregates | looked up when routing | Role Policy §5 |

## 3. Interface — 4 operations + 2 admin

```ts
interface MemoryBackend {
  // write — only the runner calls this; the KB backend errors if the caller isn't the proposal pipeline
  remember(entry: Entry): Promise<Id>;

  // lookup — returns scored hits with provenance (rule M4)
  recall(q: Query): Promise<Hit[]>;

  // soft delete — tombstone + audit, no physical deletion
  forget(id: Id, reason: string): Promise<void>;

  // distill — ONLY reads + returns proposals, never writes on its own (principle 3)
  consolidate(window: Window): Promise<Proposal[]>;

  // admin
  pin(id: Id, on: boolean): Promise<void>;     // KB entry always-injected, doesn't consume query quota
  audit(id: Id): Promise<History[]>;           // the entry's full lifecycle
}
```

A composite backend routes by tier: each tier binds one backend instance (§2); the Tier-6 adapter
is swapped via config, the other tiers stay the same → switching brains loses neither KB nor episodic.

```yaml
# .orchestra/memory.yml
semantic_backend: sqlite-vec          # | mem0 | zep | cognee
semantic:
  embedding: { model: local-bge-m3, dim: 1024 }   # local by default — code never leaves the machine
  hybrid: { fts: 0.5, vector: 0.5, recency_boost: 0.1 }
brief_budget:
  project_tokens: 2000                # tier 3 inject ceiling
  user_tokens: 500                    # tier 5 inject ceiling
```

## 4. Storage schemas

### 4.1 TaskRecord (episodic — 1 row per task, append-only)

```jsonc
{
  "id": "task-17",
  "pipeline": "feature-dev@1", "task_type": "feature",
  "params": { "target": "Add the Momo gateway to checkout" },
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

### 4.2 FeedbackEvent (episodic — golden signal, append-only)

| type | Trigger | Scores |
|---|---|---|
| `user_edit_after_merge` | user edits a file after merge | negative for the implement node's worker |
| `verdict_rejected` | user rejects a review verdict | negative for the reviewer, positive for the wrongly-flagged coder |
| `task_reassigned` | user reassigns the task to another CLI | negative for the dropped CLI, positive for the chosen CLI |
| `kill_misjudged` | user concludes the supervisor killed wrongly | negative for the rule that caused the kill |
| `kb_correction` | user edits a KB entry after it was injected | negative for the entry, positive for the correction |
| `pipeline_modified` | user edits the template after a task | signal for the retrospective |

### 4.3 KBEntry (tier 3 — markdown + frontmatter, in the repo)

```markdown
---
id: kb-payment-module
title: "Payment module"
scope: ["src/payment/**"]
tags: [payment, architecture]
source: consolidated          # consolidated | manual | worker-note(via review)
confidence: high
pinned: false
supersedes: null
updated: 2026-10-30
---
Checkout lives in `src/pages/checkout`; gateways follow the adapter pattern
(`PaymentGateway`, see `stripe.ts`). This module **requires e2e**
and may not add new dependencies without going through the user.
```

Convention: 1 entry, 1 topic, ≤ 40 lines; `pinned: true` = always injected, doesn't consume query quota.

### 4.4 User memory (tier 5) — markdown `~/.zcode/memory/`

Same frontmatter format, scope = "all-projects". Examples: "comments in Vietnamese", "no
class components", "always ask before bumping a major dependency".

### 4.5 SemanticFact (tier 6 — backend-agnostic record)

```jsonc
{
  "id": "sf-201", "text": "Momo gateway rate-limit 10 req/s in sandbox",
  "entities": ["momo", "payment"], "task_ref": "task-17",
  "valid_from": "2026-10-30", "valid_until": null,     // temporal — Zep-style when using a graph backend
  "ttl_days": 90
}
```

## 5. Brief injection policy (read mode 1)

Priority order on budget overflow — runner eviction, logging what was dropped:

```
1. user memory (tier 5)                    ≤ 500 tok
2. KB pinned (pinned: true)
3. KB matching the brief's files_in_scope  ≤ 2000 tok total for tier 3
4. KB matching the task's tags
5. recent lessons (consolidated, 30d)      → on overflow, cut from the bottom up
```

- Hits are recorded in `brief.memory_hits` → the worker can reference them; review compares
  worker behavior against the injected KB (KB violation = review fail, a feedback event).
- **Conflict rule**: KB `manual` > KB `consolidated` > model judgment. Old vs new entry:
  `supersedes` decides, the old one is tombstoned.
- Per-node retrieval (DSL `memory.retrieval`): the node declares sources + query — the plan node looks up
  `[episodic, semantic, fleet]`, other nodes don't look up by default (saves cost, avoids noise).

## 6. Consolidate — the retrospective job's engine

```
Trigger: after every N tasks (default 10) | nightly | manually by the user

Input : TaskRecords + FeedbackEvents within the window (default 30d)
Step 1. Cluster by module/theme (files_touched, tags)
Step 2. Extract lessons: what repeats, what fails and why, which entry points are used often,
        which patterns workers tend to violate
Step 3. Diff against the current KB: new entry? update (supersedes)? wrong entry (with evidence)?
Step 4. Proposals also point to the Role Policy (route, budget) — subject to n ≥ min_sample
Output: Proposal[] → PR [orchestra-proposal]:
        - diff .orchestra/kb/*.md          (KB addition/update/correction)
        - diff .orchestra/policy.yml       (if Role Policy §6 conditions are met)
```

Guardrails: every proposal comes with evidence (task count, repetition count); no proposals on small samples;
closed proposals are not raised again unless the evidence grows significantly.

## 7. Event → write tier (quick mapping)

| Event | Write tier |
|---|---|
| dispatch / kill / gate result / merge / cost | 2 (episodic) |
| user edit after merge, verdict rejection, reassignment | 2 (feedback event) |
| `files_touched` of a merged task | 2 → KB candidate at the next consolidate |
| repeated kill/block/override | 7 (fleet counters) |
| facts distilled from tasks ("rate-limit 10/s") | 6 (semantic) |
| approved lessons | 3 (KB, via PR) |
| approved route/budget proposals | 4 (policy.yml, via PR) |

## 8. Validation rules (hard rules)

| # | Rule |
|---|---|
| M1 | KB (tier 3) may only be written via proposal-merge or by the user's hand. Direct writes from worker/orchestrator → rejected, converted into a worker-note awaiting review |
| M2 | No secrets/credentials in any tier — scanned on write, detected → rejected + warning |
| M3 | Brief injection is capped; the runner evicts per §5 and logs the dropped list into the task record |
| M4 | Every recall hit must carry `{tier, source_ref, score}` — hits without provenance may not be used |
| M5 | Episodic is append-only; corrections are new events, never UPDATE |
| M6 | `forget` = tombstone + audit; physical deletion only via the admin tool, with two confirmation layers |
| M7 | KB entry with missing/invalid frontmatter or over 40 lines → warning; `manual` vs `consolidated` collision → manual wins + flag |
| M8 | An adapter must implement all 4 operations; backend swap is only valid for tier 6 — tier 3 may not point to another backend |
| M9 | SemanticFact past its TTL → hidden from default recall, shown when querying `include_expired` |

## 9. Open after v0.1

- Worker-note: workers propose KB entries via artifacts, a review node filters first → the pipeline needs less global consolidation
- Memory team-sync: the KB already travels with git — add a PR review convention like code review
- Memory quality evaluation: a "brief hit usefulness" metric (whether the worker actually uses injected KB — measured from tool_use behavior)
- Multi-project user memory with clear precedence (project > user on conflict)
