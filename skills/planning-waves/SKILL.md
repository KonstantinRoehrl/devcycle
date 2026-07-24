---
name: planning-waves
description: Use when an approved spec or design needs an implementation plan for parallel subagent execution, before any implementation starts.
---

# Planning Waves

Produce an implementation plan that wave-based parallel execution can consume. This skill is a delta on top of upstream plan-writing: it adds only the feasibility gate, dependency declarations, dispatch map, and reuse rules below.

**REQUIRED SUB-SKILL:** `superpowers:writing-plans` — follow it for plan location and naming, scope check, file-structure mapping, task right-sizing, step granularity, the header and task templates, no-placeholders rules, and self-review. Where this skill and upstream disagree, this skill wins (see Overrides).

**Announce at start:** "I'm using the planning-waves skill to create the implementation plan."

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

## Execution strategy — twin goals

The plan IS the execution strategy: while drawing task boundaries, decide how the tasks will run, not just what they contain. Two goals govern every boundary decision, together:

- **Maximize parallelism.** Draw boundaries so parallel tracks are file-disjoint and interface-decoupled — the more dependency-free, file-disjoint tasks, the wider each wave.
- **Minimize each implementer's context.** Every task must be implementable from its own brief alone. Pin exact interfaces — signatures, names, values — in each task's `**Interfaces:**` block so concurrent implementers never need each other's context, the planning conversation, or the spec's history. A task whose brief cannot be made self-contained is drawn wrong: split it, or move the boundary until it can.

The goals reinforce each other — a task small enough to hold a self-contained brief is also small enough to schedule flexibly — but when they pull apart, prefer the smaller context: a slightly longer wave sequence beats a subagent working from an overstuffed brief.

Dependencies are then **derived, not decreed**: a task depends on exactly the tasks whose produced interfaces or files it consumes — nothing more, unless a real ordering constraint exists that consumption doesn't capture (a migration before schema users, a destructive step last), in which case declare it with its reason like any other dependency. The declarations below and the Dispatch Map turn those derived dependencies into the execution order; anything not forced into sequence by a real dependency stays parallel.

## Dependencies — one declaration per task

Every task carries a `**Dependencies:**` line in exactly one of these forms:

- `**Dependencies:** none (completely independent)`
- `**Dependencies:** Task 2 (consumes its X interface)`
- `**Dependencies:** Tasks 1+4 committed`

## Dispatch Map — required section

The plan ends with a `## Dispatch Map` grouping tasks into waves:

```markdown
## Dispatch Map
- Wave 1: Task 1, Task 2 (file-disjoint, no dependencies)
- Wave 2: Task 3 (needs Tasks 1+2 committed)
```

A wave holds only dependency-ready, file-disjoint tasks: never place two tasks touching the same file in one wave, even if both declare `none`. Execution dispatches by readiness from this map, never by written order.

## Reuse before rebuild

Each task names the existing modules, helpers, or components it extends (found by searching the codebase during planning). A task that introduces a new abstraction must state why no existing one fits.

Before searching file-by-file, check the target repo (never this plugin's own repo)
for an existing graphify graph — `graphify-out/` and/or a root `GRAPH_REPORT.md` —
whenever a `graphify` skill is listed among this session's available skills: if
present, read the report and query the graph for the structural picture (modules,
existing patterns, what already exists) this step needs, before falling back to
plain search when the graph is absent, stale, or too thin for the area in question.
Read-only here too — never trigger a graphify build or `--update` — and silent
either way: no note to the user about whether a graph was used.

## Output contract

The finished plan satisfies this contract, consumed by `devcycle:executing-waves`: plan header (Goal/Architecture/Global Constraints) + per task: `**Files:**` (Create/Modify/Test), `**Interfaces:**` (Consumes/Produces, exact signatures), `**Dependencies:**` (`none` | `Task N (reason)` | `Tasks N+M committed`), checkbox steps with test-first ordering, and a `## Dispatch Map` section listing waves of file-disjoint, dependency-ready tasks.

## Overrides of upstream writing-plans

- The header's "For agentic workers" line names `devcycle:executing-waves` as the executor. Do not offer upstream's subagent-vs-inline execution choice.
- Do not give tasks an implementer-executed commit step: the Conventional Commit lands via the executing-waves review cycle, on review acceptance.

## Handoff — required final output

After saving the plan (or issuing a NO-GO report), update `.devcycle/state.md`
(`stage: execution` — the stage to resume at — and the `plan:` path; after a
NO-GO, keep `stage: planning`) before emitting:

```markdown
## Handoff
- Stage completed: planning
- Artifacts: <plan path, or NO-GO report>
- Carry-overs: <pinned interfaces / open decisions, or "none">
- Context action: <Continue | Compact with hint | Clear + /devcycle:continue | Fresh session>
- Compaction hint: Keep <plan path, pinned interfaces, dispatch map>. Drop <planning exploration and drafts>.
```

The plan file carries everything execution needs, so the default context action after planning is `Clear + /devcycle:continue`.
