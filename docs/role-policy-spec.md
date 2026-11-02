# Orchestra Role Policy — Spec v0.1

> English only (canonical).

The link between the Pipeline DSL (nodes declare a `role`) and the Worker Protocol (manifests declare capabilities).
Role Policy answers: **this node needs role X → which worker (CLI + model), with what permissions, what cost ceiling,
and who is the fallback.** Resolution is deterministic code — the LLM only suggests, it never makes the final call.

---

## 1. Principles (invariants)

1. **The router decides in code, the Orchestrator suggests semantically.** The Orchestrator tags the task
   (`ui`, `payment`, `refactor`...); the router uses the tags to boost scores — but the final choice is deterministic
   and is logged together with its reason. Re-run under the same conditions → same worker.
2. **Policy is a file in git, not hidden state.** Every policy change is a reviewable diff.
   Retrospectives propose via PR; the user merging = sign-off. No silent overwrites, no auto-apply.
3. **Every role must have a cost ceiling** (DSL spec rule V9) and a **permission profile** — no implicit defaults.
4. **Cross-review is a system constraint, not a model's taste.** The router excludes the worker already used
   for the node referenced by `distinct_worker_from` — before any scoring.
5. **Controlled degradation (graceful degradation).** Never silently drop a constraint: if the fleet lacks
   an option → escalate `ask_user` with a clear warning (e.g. losing cross-review).

## 2. File location & precedence

```
~/.zcode/policy.yml          # global — personal taste, default matrix
.orchestra/policy.yml        # project — per-repo override (lives in git, shared with the team)
```

Merge by key: project overrides global item by item (role → bindings replaced as a whole block, no deep merge).

## 3. Full schema — `policy.yml`

```yaml
version: 1

roles:                                 # role definitions + defaults
  planner:
    description: "Read code, produce plan + acceptance criteria"
    permission_profile: readonly
    budget: { usd: 1.00, minutes: 20 }
  coder:
    description: "Implement in the worktree"
    permission_profile: worktree-write
    budget: { usd: 2.00, minutes: 30 }
  verifier:
    description: "Run the test suite independently"
    permission_profile: verify-only
    budget: { usd: 0.50, minutes: 15 }
  reviewer:
    description: "Cross-CLI diff review"
    permission_profile: readonly
    budget: { usd: 1.00, minutes: 20 }
  researcher:
    description: "Investigate requirements, libraries, compare options"
    permission_profile: readonly
    budget: { usd: 0.80, minutes: 25 }
  fixer:                               # dynamic fix node (spawn_fix) inherits the original node's role
    description: "Fix based on verify/review feedback"
    permission_profile: worktree-write
    budget: { usd: 1.00, minutes: 20 }
  resolver:                            # merge conflict resolver (compose layer)
    description: "Resolve conflicts when merging multiple tasks"
    permission_profile: worktree-write
    budget: { usd: 1.50, minutes: 30 }

# Matrix: role → candidate list in priority order (scored at dispatch time)
bindings:
  coder:
    - worker: { cli: codex,    model: gpt-5.3-codex }
      boost_when: { tags: [refactor, backend, performance] }
    - worker: { cli: claude,   model: opus-4.6 }
      boost_when: { tags: [ui, architecture, payment] }
    - worker: { cli: opencode, model: kimi-k2.5 }
      when: { budget_tier: low }          # only considered when the user picks economy mode
  verifier:
    - worker: { cli: claude, model: sonnet-4.6 }
    - worker: { cli: opencode, model: deepseek-v4 }
  reviewer:
    - worker: { cli: claude, model: opus-4.6 }
    - worker: { cli: gemini, model: gemini-3-pro }
  planner:
    - worker: { cli: claude, model: opus-4.6 }
    - worker: { cli: gemini, model: gemini-3-pro }      # 1M context for large repos
  researcher:
    - worker: { cli: gemini, model: gemini-3-pro }      # big-context
    - worker: { cli: opencode, model: deepseek-v4 }

# Permission profiles — translated into flags at spawn by Worker Protocol §9 Layer 1
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
    net: false                          # only a node declaring net: true opens it — the profile never does
  verify-only:
    sandbox: worktree_only
    allow: [Read, "Bash(test)"]
    deny:  [Write, Edit]
    net: false

routing:                                # candidate scoring weights
  weights: { track_record: 0.4, health: 0.2, cost: 0.2, preference: 0.1, speed: 0.1 }
  min_sample: 10                        # below N runs, the track record is not yet trustworthy
  decay: 30d                            # track record decays over time
  budget_mode: balanced                 # balanced | performance | low  (user toggles in one click)

fleet_constraints:
  cross_review: required                # requires ≥2 CLIs of different families in the fleet for verifier/reviewer
  max_parallel_tasks: 3                 # global parallelism ceiling (quota/budget)
  reserved_for_review: []              # may reserve 1 CLI for review only
```

## 4. Resolve algorithm (runner, deterministic)

```
resolve(role, node, task):
  1. candidates = bindings[role]
       filter: CLI installed ∧ auth_ok ∧ conformance ≠ fail
            model available (manifest.custom_provider ∨ native model)
            model_slots support the slot the node requires (if the node uses a slot)
            permission profile satisfiable by the CLI's `guarantee`
            NOT the same worker already assigned to the node in distinct_worker_from (same task)
  2. score(c) = w·track_record(c, role, task_type)      # layer 7 fleet memory
             + w·health(c)                              # conformance + smoke badge
             + w·(1 − cost_norm(c))                     # per budget_mode
             + w·preference(c)                          # boost_when tags match, user_overrides
             + w·speed(c)
  3. pick = argmax; log: {pick, candidates, scores, tags, reason}
  4. empty → escalate: never relax a constraint on its own — ask the user:
       "No second CLI for cross-review of node 'verify'.
        Continue with the same CLI (lose cross-checking)? / Stop the task."
```

Design notes:

- **Overrides from the DSL node**: `worker.hint.prefer/avoid` add/subtract score; `worker.hint.pin` forces
  (debug only — the router still logs "pinned" for audit).
- **budget_mode**: `low` automatically leans toward cheap workers + allows candidates with `when: budget_tier: low`;
  `performance` ignores the cost weight. One dropdown choice in the UI, no YAML editing.
- **The decision log is an artifact**: every dispatch writes `{pick, scores, reason}` into the task record —
  retrospectives can read *why* worker X was chosen that day.

## 5. Track record (fleet memory — layer 7)

The runner aggregates from episodic records, **without an LLM** — this is a table of numbers, not a memory:

```jsonc
{
  "worker": "codex", "role": "coder", "task_type": "feature",   // lookup key
  "window": "30d",
  "dispatched": 14, "gate_passed": 11, "first_try_pass": 9,
  "retries_avg": 0.4, "overreach_blocks": 1,
  "avg_cost_usd": 1.7, "avg_minutes": 22,
  "user_override_to": 2,      // user switched to another worker after seeing the result — negative signal
  "user_override_from": 0,    // user switched to this worker — positive signal
  "ema_score": 0.78           # 30d decay, updated after every task
}
```

Signal sources (arise naturally from the workflow, nobody has to rate by hand):

| Signal | Perceived weight |
|---|---|
| `first_try_pass` (passed the gate without retry/fix) | strongest positive |
| `user_override_from` → this worker | positive |
| `user_override_to` (dropped this worker) | negative |
| `overreach_blocks` | negative — worker tends to exceed its permissions |
| cost/minutes above the role average | slightly negative |

`min_sample: 10`: below 10 runs, `ema_score` does not enter routing — the manifest's `strengths`
+ `boost_when` serve as the initial priority. New fleet = configured taste; mature fleet = self-proven numbers.

## 6. Learning loop — from track record to policy

```
episodic + feedback events ─► runner aggregates track record (nightly / after N tasks)
        │
        └─► retrospective job (LLM) reads track record + routing log
              → produces a PROPOSAL (PR tagged [orchestra-proposal]):
                  - suggest reordering bindings ("codex fails 40% of UI tasks, n=12
                    → suggest promoting claude to #1 for coder when tag=ui")
                  - suggest adding/changing permission profiles, budgets
              → user reviews the diff → merge = sign-off | close = skip (recorded so it is not proposed again)
```

Proposal conditions: `n ≥ min_sample` and a meaningful difference (e.g. ≥ 20 percentage points of first_try_pass).
Every proposal must come with numeric evidence — no proposals based on "feel".

## 7. Validation rules (hard rules when loading the policy)

| # | Rule |
|---|---|
| P1 | Every role referenced by a DSL template must be defined in `roles` (warn if `bindings` is missing — dispatch will escalate) |
| P2 | Every binding must point to a manifest that exists in the registry |
| P3 | `fleet_constraints.cross_review: required` → the fleet must have ≥2 CLIs of different *families* (not 2 versions of 1 CLI) available for verifier/reviewer, otherwise a red warning on the matrix |
| P4 | `permission_profiles` forbid `sandbox: danger_full_access` and forbid default `net: true` for writing roles (Worker Protocol rule) |
| P5 | Every role must have a `budget` (V9) |
| P6 | The model in a binding must satisfy the manifest's `custom_provider` and the required slot's `model_slots` |
| P7 | `weights` in `routing` must sum to 1.0 |
| P8 | Policy change without a `version` bump → warning (like DSL V10) |

## 8. Matrix UI (concept)

```
              codex/gpt-5.3-c  claude/opus-4.6  opencode/kimi  gemini-3-pro
coder         ● #1 (0.82)      ○ #2 (0.79)      ○ low          —
verifier      —                ● #1 (0.91)      ○ #2 (0.74)    —
reviewer      —                ● #1             —              ○ #2
planner       —                ● #1             —              ○ #2 (1M ctx)
researcher    —                —                ○ #2           ● #1
              ● selected  ○ fallback  badge: ✓ conformance  ⚠ untested  ✗ auth/quota
```

- The cell is the **single source of truth**: click → edit `policy.yml` → diff → save. No hidden state in the UI.
- Badges come from registry health; a cell is dimmed when the CLI fails conformance/smoke.
- The `budget_mode` toggle + per-role `$` ceiling sit right on the matrix.

## 9. JSON Schema (condensed skeleton)

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
        permission_profile: { type: string }      # must exist in permission_profiles
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

## 10. Open after v0.1

- A/B routing: run 2 workers in parallel on the same node, keep the better result via the gate (costs 2× — only for critical roles)
- Per-directory/module policy (different `coder` for `src/ui/**` and `src/core/**`)
- Import ratings from marketplace role-packs (combined with the local track record)
- Per-role skill-sync: which role gets which skill pack (link to idea #3 of the original concept)
