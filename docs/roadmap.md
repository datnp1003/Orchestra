# Orchestra — Overall roadmap from today to a finished product

> English only (canonical).

> Assumption: 1 full-time dev. Every milestone is an estimate; exit criteria are *measurable* conditions,
> not a feeling of "done". Revisit after each stage.

---

## 0. Current position (30/10/2026)

| Done | Status |
|---|---|
| 4 closed-loop v0.1 specs (DSL · Worker Protocol · Role Policy · Memory) | ✓ signed off |
| P1 prototype — registry, headless spawn, normalized stream, smoke, supervisor-lite | ✓ runs for real, PASS on both claude + codex |
| P2 prototype — worktree isolation, TaskBrief B1, permission matrix, role-based dispatch, scope check, task record | ✓ runs for real on demo-repo |

**Position:** the principles are proven at prototype level. The rest of the product is
turning the "1 node, 1 command" flow into a **self-running pipeline**, then wrapping it in an **IDE**, then **polishing it
enough for outsiders to use**.

## 1. Definition of "done" — 2 gates

### MVP gate (end of stage P5) — measurable:
1. An **external** dev can install with 1 command and get value in their first working session
   (onboarding ≤ 15 minutes).
2. Real E2E: open repo → create task → pipeline `plan → implement → verify → review` runs on its own across
   ≥ 2 different CLIs → user approves plan + merge → task record + patch are saved.
3. Real cross-review: implement and review run on 2 CLIs of different families, and it is logged.
4. Every task has a cost ceiling; exceeding it → kill + escalate (no surprise bills).
5. CLI errors (hangs, bad format, version changes) do not crash the orchestrator — degrade + report clearly.

### v1.0 gate (end of stage P7) — measurable:
1. ≥ 3 supported CLIs, each with a conformance suite running automatically per pinned version.
2. Supervisor with all 4 layers (including in-flight FS watcher + deny globs at the flag level).
3. Memory loop closed: episodic → retrospective → proposal PR → user merge → policy/KB updated.
4. 10–20 beta users using it for ≥ 2 weeks; ≥ 1 task/person/day on average.
5. Self-service docs + troubleshooting; npm install; crash rate < 1 task/100.

## 2. Stages

### P3 — Pipeline Runner (weeks 1–3): "turn the DSL into the backbone"

Goal: the `feature-dev.yml` file runs automatically, without someone typing a command per node.

- YAML loader + validation rules V1–V10 (schema forbids removing `verify`, forbids `when` on verify…)
- DAG executor: topological order, skip propagation, parallel nodes when independent
- Node executors: plan (blocks for approval), implement, verify, review, merge_gate
- Deterministic gate evaluator: `tests.green`, `verdict.approved`, `files_changed <= N`
- `on_fail`: retry / spawn_fix (bounded by max_retries) / ask_user — fix node gets the failed node's context
- Gate runner: map `acceptance_criteria` → test commands in the repo config, run for real
- Multi-task compose: task DAG → merge order → integration test after each merge → merge resolver
- Default DSL templates: `feature-dev.yml`, `hotfix.yml` into `docs/templates/`

**Exit criteria:** demo-repo runs `orchestra run "add gateway X"` → 4 nodes run on their own, 1 case
where verify fails → spawn_fix fixes it → pass; 2 parallel tasks merge with an integration test.
**Main risk:** writing a stable run loop (node state, resume mid-way) — keep it simple:
task = a state directory, one file per node, no DB needed.

### P4 — Policy from file + Memory (weeks 4–6): "the brain"

- `policy.yml` load + validate P1–P8; bindings from the file replace bindings in code
- Track record: SQLite table aggregated from task records (first_try_pass, override, blocks, EMA 30d)
- Routing uses real scores: track_record + health + cost + preference + tag boost
- Memory layer 2: migrate JSON task records → SQLite episodic + FTS5
- Memory layer 3: markdown KB `.orchestra/kb/` + **injection into the brief capped at 2.5k tokens** + eviction
- Feedback events: capture user_edit_after_merge / verdict_rejected / task_reassigned
- Retrospective v0: job clusters task records → produces proposals (KB diff + policy diff) as PR text

**Exit criteria:** run 10 simulated tasks (some deliberately "failing") → the track record reflects them correctly;
briefs automatically contain the right module's KB entries; retrospective produces ≥ 1 sensible proposal for the user to approve.
**Main risk:** distillation quality — use a sample gate (n ≥ min_sample) from day one,
don't let memory "tell stories" based on noise.

### P5 — IDE Extension (weeks 7–11): "the product takes shape" — MVP TARGET

- VS Code extension (TypeScript, reusing the runner core):
  - **Fleet panel**: list/install/update CLIs, auth status, conformance badge
  - **Task panel**: create task, view the pipeline node by node, live transcript (JSONL stream → tree view),
    diff review, approve plan / merge / kill buttons
  - **Matrix UI**: role × worker × model — cell = policy.yml, edit → diff → save
- Credential vault: Windows Credential Manager (DPAPI), injected at spawn, keys never pass through the LLM
  (per-CLI vault env injection is superseded by the router — providers live in desktop Settings → Providers)
- Conformance runner v1: the 8 §10 cases run per pinned version, green/yellow/red badge
- Package: `npm i -g orchestra-cli` (CLI core) + extension VSIX

**Exit criteria:** meets all 5 MVP gate conditions (§1).
**Main risk:** UI scope creep — rule: a rough panel that really works > a pretty one that only demos.
The webview transcript is version 1; no custom editor.

### P6 — Hardening + Beta (weeks 12–15): "trustworthy enough to hand to others"

- Supervisor Layer 3: FS watcher (chokidar) on the worktree, cross-check Observed vs Reported,
  deny globs pushed down to the flag level (`--disallowedTools` rules for claude; opencode profile),
  detect network attempts, classify hangs (hung/stuck/budget) — per spec §9b
- Complete conformance suite + auto-run when the registry sees a CLI update (yellow badge)
- Session resume, worker hot-swap between nodes
- macOS/Linux verification path (prototype is already cross-platform via Node; real testing + fixes)
- 10–20 beta users: feedback channel, issue template, weekly release

**Exit criteria:** 2 weeks of beta, crash rate < 1/100 tasks, ≥ 1 user running it daily voluntarily.
**Main risk:** the number of different ways CLIs respond — every fix must come with 1 new conformance case,
no point-to-point fixes.

### P7 — Launch v1.0 (weeks 16–17)

- Publish npm + VS Code marketplace; docs site (15-minute quickstart, concepts, manifest spec)
- Registry manifests open to community contributions (PR + automatic conformance)
- Role pack / skill-sync v0: pack installed once, IDE syncs AGENTS.md/CLAUDE.md/.codex for workers
- Beta post-mortem → v1.0 checklist → release

**Exit criteria:** meets all 5 v1.0 gate conditions (§1).

## 3. Cross-cutting (throughout)

| Area | Rule |
|---|---|
| Verification | Every stage must demo on **real CLIs**, not fixtures only; fixtures are for replay only |
| Dev cost | Every demo session logs usage; if 1 dev week costs > $20 in model fees → optimize before adding features |
| Quality contract | unmapped-lines and first_try_pass are 2 metrics always shown in output |
| Scope | MVP excludes: marketplace, multi-user/team sync, Docker isolation, hot-swap — these are v1.x |
| Windows | Primary platform (dev machine); macOS/Linux verified in P6, not earlier |

## 4. Overall milestone chart

```
Week:     1───2───3───4───5───6───7───8───9──10──11──12──13──14──15──16──17
Stage:    ├─────P3─────┤├─────P4────┤├────────P5 (MVP)────────┤├──P6──┤├P7┤
Gate:                                 │                        │        │
                                 MVP review               Beta       v1.0
Done (before week 1): 4 specs v0.1 + P1 + P2 prototype ✓
```

Total: ~4 months solo full-time. Can be shortened if: P5 does only the CLI panel first (saves 1–2 weeks),
or memory does only episodic + KB injection and drops the retrospective (brought back after v1.0).

## 5. Next actions (week 1, days 1–2)

1. Add the `js-yaml` dependency, write the `pipeline.ts` loader: parse `feature-dev.yml` + validation V1–V10
2. DAG executor v0: run the `feature-dev` nodes sequentially on demo-repo, each node reusing `dispatch()`
3. First P3 demo: 1 command → plan (pauses for approval via CLI prompt) → implement → verify → review
   — the first time the original idea runs as a *process*, not as separate commands.
