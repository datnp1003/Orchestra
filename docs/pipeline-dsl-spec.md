# Orchestra Pipeline DSL — Spec v0.1
> English only (canonical). Vietnamese UI strings live in prototype/src/i18n/vi.ts.

A declarative workflow language for an orchestrator-style IDE agent that coordinates agent CLIs
(Claude Code, Codex, OpenCode, ...) as workers.

---

## 1. Design principles (invariant)

1. **Nodes declare roles, not commands.** The DSL doesn't say "run claude with prompt X" —
   it says "I need a `coder`". Choosing the CLI/model is the job of the Router + Role Policy.
2. **`verify` is a mandatory node.** Every pipeline must have exactly one `type: verify` node,
   which cannot be conditional (`when`) and cannot be deleted. Users may only *add* checks, never remove them.
3. **Cross-review.** Checking nodes (verify/review) must run on a different CLI than the implement node
   (declared via `distinct_worker_from`). If the fleet doesn't have enough CLIs → escalate to the user.
4. **The runner is deterministic, the Orchestrator is an LLM.** Router/gate/merge are plain code — the pipeline
   still runs even when the LLM orchestrator fails or is offline (reduced mode: use the default pipeline).
5. **The agent proposes, the user decides.** Every pipeline change (including those proposed by the retrospective)
   is a git diff on the template file — approve = merge.
6. **Fix loops are always bounded.** Every fix loop has a retry limit; when exhausted → ask the user.

## 2. File locations & precedence

```
.orchestra/
  config.yml              # project-level policy: integration, default budget
  pipelines/
    feature-dev.yml       # pipeline template (project scope, tracked in git)
    hotfix.yml
    refactor.yml
  episodic.sqlite         # memory tier 2 (task records)
  kb/                     # memory tier 3 — project memory, markdown, reviewed via git
~/.zcode/
  pipelines/              # global pipeline templates (all projects)
  policy.yml              # Role Policy + User memory pointer (tiers 4, 5)
```

Precedence when resolving a pipeline id: **project > global**. Templates in the repo → versioned,
diff-reviewable, shared with the whole team.

## 3. Core concepts

| Concept | Meaning |
|---|---|
| **Pipeline** | 1 YAML file = 1 workflow for 1 task. `applies_to` decides which task types use this pipeline automatically. |
| **Node** | One step in the DAG. Has a `type` (built-in semantics), `role` (who does it), `needs` (dependencies), input/output artifacts, `gate`, `on_fail`. |
| **Role** | Semantic label: `planner`, `coder`, `verifier`, `reviewer`, ... The Router maps role → CLI/model via the Role Policy. |
| **Worker** | A specific agent CLI + specific model, chosen by the Router at dispatch. |
| **Artifact** | A node's typed product: `plan`, `diff`, `test_report`, `verdict`, ... A node receives artifacts from the nodes it `needs`. |
| **Gate** | A pass condition — evaluated by deterministic code, not by an LLM. |
| **Brief** | The input package for a worker: params + upstream artifacts + memory inject. The brief is the only interface between orchestrator and worker. |

## 4. Standard node types

| Type | Built-in semantics | Default outputs |
|---|---|---|
| `plan` | Reads code + brief, produces a plan & acceptance criteria. Usually `approval: required`. | `plan` |
| `implement` | Codes in its own worktree. `self_test: true` → the coder runs tests itself before reporting done (result is advisory only). | `diff`, `self_test_report` |
| `verify` | **Mandatory.** Runs the test suite independently on the worktree's merge-rehearsal state. Does not trust `self_test_report`. | `test_report` |
| `review` | Evaluates the diff against a checklist + `test_report`. Produces a verdict. | `verdict`, `review_comments` |
| `check` | Targeted LLM analysis (performance, a11y, ...) producing a report. | `report` |
| `run` | Deterministic command, NO LLM (lint, benchmark, scanner). | `report` |
| `merge_gate` | Run only by the orchestrator: aggregates gates, decides auto-merge or ask the user. | `merge_result` |

## 5. Syntax

### 5.1 Full — `feature-dev.yml`

```yaml
id: feature-dev
version: 1
name: "Feature development"
applies_to:
  task_type: [feature, chore]        # which task types automatically match this pipeline

params:                              # passed at dispatch
  - name: target                     # feature description
    required: true
  - name: e2e
    default: true
  - name: max_files_changed
    default: 30

memory:                              # hooks into the memory interface
  brief_inject:                      # always injected into every brief
    - project_memory                 # tier 3 (kb/)
    - user_memory                    # tier 5
  retrieval:                         # looked up on demand, per node
    - node: plan
      sources: [episodic, semantic, fleet]
      query: "{{ params.target }}"

nodes:
  - id: plan
    type: plan
    role: planner
    approval: required               # stop; continue only after the user approves the plan
    outputs: [plan]

  - id: implement
    type: implement
    needs: [plan]
    role: coder
    isolation: worktree              # 1 worktree per task (default)
    self_test: true                  # first test pass run by the coder itself
    budget: { usd: 2.00, minutes: 30 }
    outputs: [diff, self_test_report]
    on_fail: { action: retry, max_retries: 1, then: ask_user }

  - id: verify
    type: verify                     # mandatory — schema forbids deletion & forbids when
    needs: [implement]
    role: verifier
    distinct_worker_from: [implement] # must be a different CLI than the coder
    inputs: [diff]
    outputs: [test_report]
    gate:
      - tests.green
      - if: params.e2e
        then: e2e.green
    on_fail:
      action: spawn_fix              # spawn a fix node with the failed node's context
      max_retries: 2
      then: ask_user

  - id: security                     # conditional node — runs only when sensitive paths are touched
    when:
      paths: ["src/payment/**", "src/auth/**"]
    type: run                        # deterministic, costs no LLM tokens
    command: "semgrep scan --config auto --error src/"
    needs: [verify]
    outputs: [scan_report]

  - id: review
    type: review
    needs: [verify, security]        # security skipped → this edge is treated as satisfied
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
    policy: auto_if                  # auto-merge when conditions hold, otherwise ask the user
    conditions:
      - all_gates_passed
      - files_changed <= {{ params.max_files_changed }}
    else: ask_user
```

### 5.2 Minimal — `hotfix.yml`

```yaml
id: hotfix
version: 1
name: "Quick hotfix"
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
    policy: ask_always               # hotfix: always approved by hand
```

## 6. Execution semantics

### 6.1 Skip propagation
A node whose `when:` doesn't match → is **skipped**, not failed. Nodes depending on it treat that edge
as satisfied. (Simple, predictable — no dependency-optional syntax needed.)

### 6.2 `on_fail` — bounded fix loop

| action | Meaning |
|---|---|
| `retry` | Rerun the same node (spawn a new worker, same brief). |
| `spawn_fix` | Spawn a new `fix` node with the failed node's artifacts (diff, test_report, review_comments) as context. Counts toward the original node's `max_retries`. |
| `ask_user` | Stop the pipeline, show status + suggestions, wait for the user. |
| `abort` | Cancel the task, keep the worktree for debugging. |

Fix nodes are dynamic (not in the static YAML) — the static DAG must always be acyclic;
loops only exist at runtime and are bounded by `max_retries`.

### 6.3 Gate expressions — closed set, no shell

```
tests.green            e2e.green            verdict.approved
verdict.changes_requested                   files_changed <= N
coverage >= 0.8        scan.critical == 0   budget.spent_usd <= X
if: <param/expr>  then: <expr>
```
May only reference declared artifacts and params. No command calls, no reading
files outside artifacts — gates must be reproducible from the task record.

### 6.4 Routing at dispatch — 3 decision layers

```
Node declares role ──► Role Policy (matrix role → CLI/model, with tier-7 track record)
                   ──► worker_hint in the node (light override: prefer/avoid)
                   ──► pin: {cli, model}    (hard pin — debugging only)
```

The Router then checks the `distinct_worker_from` constraint: if the fleet has only 1 available CLI left
→ **never silently skip it**, escalate `ask_user` with a loss-of-cross-review warning.

### 6.5 Each node's brief is assembled from

1. `params` (goal, constraints)
2. Artifacts from the `needs` nodes
3. `memory.brief_inject` (project + user memory) + the node's own retrieval
4. Node contract: which artifacts it must return, which gates will grade it
   → the worker knows its "exam" from the start.

## 7. Schema validation — hard rules (checked on load)

| # | Rule |
|---|---|
| V1 | Exactly one `type: verify` node. None → pipeline rejected. |
| V2 | The `verify` node may not have `when` and may not sit behind any condition that could skip it. |
| V3 | The static DAG is acyclic. |
| V4 | Every artifact used as input must be produced by a node in `needs`. |
| V5 | `distinct_worker_from` may only point to nodes in the same pipeline. |
| V6 | `on_fail.spawn_fix` requires `max_retries` and `then`. |
| V7 | `merge_gate` requires `policy` (`auto_if` needs `conditions`, `ask_always`/`ask_never` don't). |
| V8 | A `run` node must have `command` and may not be the only node deciding the pipeline's verdict. |
| V9 | Missing `budget` → take the default from the Role Policy for the role; no default → rejected (never run a node with no known cost ceiling). |
| V10 | Template missing `version` → rejected. Template changed without a version bump → warning, not blocked. |

## 8. Combining multiple pipelines (compose layer) — `.orchestra/config.yml`

This part is NOT in the pipeline (pipeline = 1 task). Coordinating multiple parallel tasks
is project-level policy:

```yaml
integration:
  merge_order: dag             # follow the task dependency DAG; parallel across branches
  after_each_merge:
    run: verify                # integration test after EVERY merge — catches semantic conflicts
    role: verifier
    distinct_worker_from: true # different CLI from the involved coders if possible
  on_conflict:
    action: spawn_resolver     # merge-resolver node, context = diffs of the colliding tasks
    max_loops: 2
    then: ask_user
  on_integration_fail:
    action: spawn_fix          # feed back to the originating task + integration report
    max_loops: 2
    then: ask_user
final:
  changelog: true
  summary: true                # whole-session summary → episodic + displayed
  cleanup_worktrees: on_green
```

## 9. Artifact schemas (normalized so gate code can read them)

```yaml
Plan:         { goal, steps[], files_touched[], acceptance_criteria[], risks[] }
Diff:         { worktree, branch, files[], patch_ref, lines_added, lines_removed }
TestReport:   { suite, passed, failed, skipped, duration_s, failures[] }
Verdict:      { result: approved|changes_requested|blocked, comments[], checklist{} }
ScanReport:   { tool, findings[{severity, file, line, rule}], error_count }
MergeResult:  { merged, order[], conflicts_resolved[], integration_reports[] }
```

Standard node types produce exactly their schema; `check`/`run` nodes produce a free-form `report`
but gates can only read fields declared in the schemas above.

## 10. Versioning & agent proposals

- Templates are files in the repo → every change goes through git.
- The retrospective job proposes template edits → produces a PR/diff labeled `[orchestra-proposal]`
  → user merge = decision. Never overwrites on its own.
- `version` follows semver: patch = text/gate number tweaks, minor = new node, major = flow
  change. A running task keeps the template version loaded at start (snapshotted into the task record).

## 11. JSON Schema (abridged skeleton, used for validation on load)

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
    contains: { const: { type: verify } }     # V1 — checked precisely in logic, schema is only a hint
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

*(Rules V1–V10 are checked in logic after JSON Schema parsing — the schema only blocks raw structure.)*

## 12. Unlocked after v0.1 (not in this version)

- Sub-pipelines / `pipeline_ref` node (call another pipeline as a node)
- Internal parallel nodes (one node spawns several competing workers, takes the first result through the gate — race mode)
- Template marketplace + ratings by fleet track record
- Extended `when`: repo metrics (complexity, hot paths from git history)
