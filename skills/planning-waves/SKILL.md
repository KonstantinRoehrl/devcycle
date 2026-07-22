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

## Concurrency is a first-class goal

Draw task boundaries so parallel tracks are file-disjoint and interface-decoupled. Pin exact interfaces — signatures, names, values — in each task's `**Interfaces:**` block so concurrent implementers never need each other's context and every task brief is self-contained.

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

## Output contract

The finished plan satisfies this contract, consumed by `devcycle:executing-waves`: plan header (Goal/Architecture/Global Constraints) + per task: `**Files:**` (Create/Modify/Test), `**Interfaces:**` (Consumes/Produces, exact signatures), `**Dependencies:**` (`none` | `Task N (reason)` | `Tasks N+M committed`), checkbox steps with test-first ordering, and a `## Dispatch Map` section listing waves of file-disjoint, dependency-ready tasks.

## Overrides of upstream writing-plans

- The header's "For agentic workers" line names `devcycle:executing-waves` as the executor. Do not offer upstream's subagent-vs-inline execution choice.
- Do not give tasks an implementer-executed commit step: the Conventional Commit lands via the executing-waves review cycle, on review acceptance.

## Handoff — required final output

After saving the plan (or issuing a NO-GO report), end the stage with:

```markdown
## Handoff
- Stage completed: planning
- Artifacts: <plan path, or NO-GO report>
- Carry-overs: <pinned interfaces / open decisions, or "none">
- Context action: <Continue | Compact with hint | Clear + /devcycle:continue | Fresh session>
- Compaction hint: Keep <plan path, pinned interfaces, dispatch map>. Drop <planning exploration and drafts>.
```

The plan file carries everything execution needs, so the default context action after planning is `Clear + /devcycle:continue`.
