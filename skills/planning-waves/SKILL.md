---
name: planning-waves
description: Use when an approved spec or design needs an implementation plan for parallel subagent execution, before any implementation starts.
---

# Planning Waves

Produce an implementation plan that wave-based parallel execution can consume. Report per
`${CLAUDE_PLUGIN_ROOT}/references/output.md`.

**Announce at start:** "I'm using the planning-waves skill to create the implementation plan."

## Engine selection (keyed to `profile`)

Resolve `profile` per `${CLAUDE_PLUGIN_ROOT}/references/config.md`, then take one engine:

- **`lean` / `standard` — devcycle-native.** Do NOT load `superpowers:writing-plans`. The
  Plan mechanics section below carries the plan location, scope check, right-sizing, step
  granularity, templates, no-placeholders rule, and self-review inline.
- **`thorough` — upstream overlay. REQUIRED SUB-SKILL:** `superpowers:writing-plans` —
  follow it for plan location and naming, scope check, file-structure mapping, task
  right-sizing, step granularity, the header and task templates, no-placeholders rules, and
  self-review, with this skill's Overrides section on top. Where the two disagree, this
  skill wins.

The engine decides only where the plan-writing mechanics come from. Everything else here —
the feasibility gate, the twin execution-strategy goals, the dependency and evidence
declarations, the `Execution: sweep` marker, the Dispatch Map, reuse-before-rebuild, and the
output contract — is unconditional, so a finished plan has the same shape whichever engine
produced it.

## Feasibility gate — before any detailed planning

Run a short feasibility pass and record an explicit verdict before writing any task:

- Can this be built here, with what actually exists? Verify every API, module, and tool the spec names against real docs or code — never assume one exists.
- What are the real unknowns? Spike the riskiest bit if a quick spike can settle it.
- Verdict: **GO** (proceed to detailed planning) or **NO-GO** (stop: name each blocking unknown in plain language, report it for a user decision, and do not write a detailed plan).

Never plan in detail on an unvalidated assumption. Never silently substitute a different API or mechanism for one the spec names — that is a spec change and needs a user decision; offer it as an option in the NO-GO report instead.

| Rationalization | Reality |
| --- | --- |
| "The spec looks straightforward" | The gate takes minutes; a plan built on a phantom API wastes a whole execution wave. |
| "Deadline pressure — plan now, verify later" | Implementers inherit unvalidated assumptions as fact; the failure surfaces after dispatch, at the most expensive point. |
| "I'll note the risk inside the plan" | A risk note inside a detailed plan still gets dispatched. NO-GO is a stop, not a footnote. |

Red flags: you are writing Task 1 and have not verified the spec's named APIs; you caught yourself writing "assuming X exists".

## Quality constraints — derived, before any task is written

After the feasibility gate and before writing tasks, read
`${CLAUDE_PLUGIN_ROOT}/references/quality-criteria.md` filtered to the confirmed scope — its
`## Forward use` section owns the filtering rule and the cost rule, and neither is restated
here — and emit a `## Quality Constraints` section into the plan:

```markdown
## Quality Constraints

- QC1 — <one-line do or don't> (measured against: <repo convention or named source>)
- QC2 — <one-line do or don't> (measured against: <…>)
```

One line each, numbered `QC<n>`, each naming what it is measured against, and only
constraints that apply to the confirmed scope.

This section is **not** `## Global Constraints`. Those lines are copied verbatim from the
spec; these are derived from the criteria catalog. The precedence rule requires the
difference to stay visible, so the two never merge.

Each task then carries a `**Quality constraints:**` line beside `**Dependencies:**` and
`**Evidence:**`, listing the ids whose subject that task's own `**Files:**` touch, or
`none`:

- `**Quality constraints:** QC1, QC3`
- `**Quality constraints:** none`

The ids are what `devcycle:executing-waves` resolves back to verbatim lines when it slices
each brief, so an implementer is told up front what a later audit would flag it for.

## Execution strategy — twin goals

The plan IS the execution strategy: while drawing task boundaries, decide how the tasks will run, not just what they contain. Two goals govern every boundary decision, together:

- **Maximize parallelism.** Draw boundaries so parallel tracks are file-disjoint and interface-decoupled — the more dependency-free, file-disjoint tasks, the wider each wave.
- **Minimize each implementer's context.** Every task must be implementable from its own brief alone. Pin exact interfaces — signatures, names, values — in each task's `**Interfaces:**` block so concurrent implementers never need each other's context, the planning conversation, or the spec's history. A task whose brief cannot be made self-contained is drawn wrong: split it, or move the boundary until it can.

The goals reinforce each other — a task small enough to hold a self-contained brief is also small enough to schedule flexibly — but when they pull apart, prefer the smaller context: a slightly longer wave sequence beats a subagent working from an overstuffed brief.

Dependencies are then **derived, not decreed**: a task depends on exactly the tasks whose produced interfaces or files it consumes — nothing more, unless a real ordering constraint exists that consumption doesn't capture (a migration before schema users, a destructive step last), in which case declare it with its reason like any other dependency. The declarations below and the Dispatch Map turn those derived dependencies into the execution order; anything not forced into sequence by a real dependency stays parallel.

## Plan mechanics — the native engine (`lean` / `standard`)

Skip this section at `thorough`; the sub-skill supplies it there.

**Where the plan goes:** `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`. A user preference for plan location overrides this default.

**Scope check.** If the spec covers multiple independent subsystems, it should have been split into sub-project specs during brainstorming. If it wasn't, suggest one plan per subsystem — each plan must produce working, testable software on its own.

**Task right-sizing.** A task is the smallest unit that carries its own test cycle and is worth a fresh reviewer's gate. Fold setup, configuration, scaffolding, and documentation steps into the task whose deliverable needs them; split only where a reviewer could meaningfully reject one task while approving its neighbor. Each task ends with an independently testable deliverable.

**Step granularity.** Each step is one action, 2–5 minutes of work, written in the order the task's evidence class requires — for `red-green`: write the failing test / run it and confirm it fails / write the minimal code / run it and confirm it passes. No commit step (see Overrides).

**Plan header — every plan starts with it:**

```markdown
# <Feature Name> Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `devcycle:executing-waves` to implement
> this plan wave by wave. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** <one sentence describing what this builds>

**Architecture:** <2-3 sentences about the approach>

**Tech Stack:** <key technologies and libraries>

## Global Constraints

<the spec's project-wide requirements — version floors, dependency limits, naming and copy
rules, platform requirements — one line each, with exact values copied verbatim from the
spec. Every task's requirements implicitly include this section.>

## Quality Constraints

<the criteria-derived do's and don'ts that apply to the confirmed scope — one line each,
numbered QC<n>, each naming what it is measured against. Distinct from Global Constraints
above, whose lines come verbatim from the spec.>

---
```

**Task template:**

````markdown
### Task N: <Component Name>

**Files:**
- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py:123-145`
- Test: `tests/exact/path/to/test.py`

**Interfaces:**
- Consumes: <what this task uses from earlier tasks — exact signatures>
- Produces: <what later tasks rely on — exact function names, parameter and return types.
  An implementer sees only their own task; this block is how they learn the names and
  types neighboring tasks use.>

**Dependencies:** none (completely independent)

**Evidence:** red-green

**Quality constraints:** QC1, QC3

- [ ] **Step 1: Write the failing test**

```python
def test_specific_behavior():
    result = function(input)
    assert result == expected
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pytest tests/path/test.py::test_name -v`
Expected: FAIL with "function not defined"

- [ ] **Step 3: Write the minimal implementation**

```python
def function(input):
    return expected
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pytest tests/path/test.py::test_name -v`
Expected: PASS
````

**No placeholders.** Every step contains the actual content the implementer needs. These are **plan failures** — never write them:

- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases"
- "Write tests for the above" (without the actual test code)
- "Similar to Task N" (repeat the code — tasks are read out of order, and concurrently)
- Steps that describe what to do without showing how (code steps need code blocks)
- References to types, functions, or methods no task defines

**Self-review — once the plan is complete.** A checklist you run yourself, not a subagent dispatch:

1. **Spec coverage:** skim each spec requirement and point to the task that implements it. Add a task for any gap.
2. **Placeholder scan:** search the plan for the red flags above and fix them.
3. **Type consistency:** the signatures, method names, and property names later tasks use match what earlier tasks define — `clearLayers()` in Task 3 but `clearFullLayers()` in Task 7 is a bug.

Fix issues inline and move on; no re-review pass.

## Dependencies — one declaration per task

Every task carries a `**Dependencies:**` line in exactly one of these forms:

- `**Dependencies:** none (completely independent)`
- `**Dependencies:** Task 2 (consumes its X interface)`
- `**Dependencies:** Tasks 1+4 committed`

## Evidence class — one declaration per task

Every task carries an `**Evidence:**` line. Read
`${CLAUDE_PLUGIN_ROOT}/references/evidence.md` for the three classes and their exact
declaration forms, and use those forms verbatim.

## Execution route — optional, one declaration per task

A task MAY carry an `**Execution:** sweep` line beside `**Dependencies:**`
and `**Evidence:**` — declared only when the task is one uniform edit rule
applied identically across its whole file list, and only when the task body
pins all three sweep parameters verbatim: the instruction, the concrete
file list, and the verifyCommand. Executing-waves then runs the task
through `workflows/mechanical-sweep.js` (pilot-first, per-file verify)
instead of dispatching an implementer. The evidence class stays orthogonal
and is typically `green-green (behavior-preserving)` — the script's
baseline and per-file verify runs supply the before/after. Any per-file
judgment in the rule disqualifies the marker: leave the line off and let a
normal implementer take the task. Wave placement rules are unchanged — the
file-disjointness invariant already isolates a sweep task from its wave
neighbors.

## Dispatch Map — required section

The plan ends with a `## Dispatch Map` grouping tasks into waves:

```markdown
## Dispatch Map
- Wave 1: Task 1, Task 2 (file-disjoint, no dependencies)
- Wave 2: Task 3 (needs Tasks 1+2 committed)
```

A wave holds only dependency-ready, file-disjoint tasks: never place two tasks touching the same file in one wave, even if both declare `none`. Execution dispatches by readiness from this map, never by written order.

## Reuse before rebuild

The rule is owned by `${CLAUDE_PLUGIN_ROOT}/references/quality-criteria.md` (§Reuse before
rebuild) — read it there; it is not restated here. What planning does with it: each task
names the existing modules, helpers, or components it extends, found by searching the
codebase during planning, and a task that introduces a new abstraction states why no
existing one fits.

Before searching file-by-file, run the **repo-research procedure** exactly as
scoping-interview defines it (canonical there): an existing graphify graph in the target
repo first — `graphify-out/` / root `GRAPH_REPORT.md`, queried read-only for the
structural picture (modules, existing patterns, what already exists) and for
`document`-type doc nodes — falling back, when the graph is absent or too stale/thin,
to plain search plus the two-phase `*.md` index-then-fetch for docs; never trigger a
graphify build or `--update`, and stay silent about which path was used. The one
difference is the relevance filter: here it is the confirmed scope and affected areas
recorded in `.devcycle/scope.md` — the first point in the pipeline where scope is
concretely known — starting from implementation-scoped docs (a `frontend.md`,
`backend.md`, or equivalent).

## Output contract

The finished plan satisfies this contract, consumed by `devcycle:executing-waves`: plan header (Goal/Architecture/Global Constraints/Quality Constraints) + per task: `**Files:**` (Create/Modify/Test), `**Interfaces:**` (Consumes/Produces, exact signatures), `**Dependencies:**` (`none` | `Task N (reason)` | `Tasks N+M committed`), `**Evidence:**` (`red-green` | `green-green` | `convention`), `**Quality constraints:**` (the `QC<n>` ids that apply to the task's files, or `none`), optionally **Execution:** (`sweep`, with the instruction, file list, and verifyCommand pinned in the task body), checkbox steps ordered per the task's evidence class (test-first for `red-green`; baseline suite run first for `green-green`), and a `## Dispatch Map` section listing waves of file-disjoint, dependency-ready tasks.

## Overrides of upstream writing-plans

These bind the `thorough` overlay; the native templates above already carry them.

- The header's "For agentic workers" line names `devcycle:executing-waves` as the executor. Do not offer upstream's subagent-vs-inline execution choice.
- Do not give tasks an implementer-executed commit step: the Conventional Commit lands via the executing-waves review cycle, on review acceptance.

## Handoff — required final output

After saving the plan (or issuing a NO-GO report), update `.devcycle/state.md`
(`stage: execution` — the stage to resume at — and the `plan:` path; after a
NO-GO, keep `stage: planning`), then emit this stage's handoff block per
`${CLAUDE_PLUGIN_ROOT}/references/handoff.md`, with `Stage completed: planning` and the
plan path (or the NO-GO report) as its artifact. The plan file carries everything execution
needs, so the context action after planning is `Clear + /devcycle:continue`.
