---
name: executing-waves
description: Use when executing a wave-based implementation plan with subagent implementers, resuming one after /clear, or when dispatching, reviewing, or committing plan tasks.
---

# Executing Waves

Overlay on **superpowers:subagent-driven-development** (REQUIRED — read and
follow it; it owns brief slicing and file handoffs, the review/fix loop,
implementer-status handling, reviewer-prompt construction, model tiering by
task complexity, continuous execution, and the never-start-on-main rule).
This skill adds only devcycle's mechanics: waves, the deterministic green
gate, coordinator-side commits and task-diff production (replacing
upstream's `scripts/review-package`), the ledger event format,
config-driven model names, and the handoff contract. Nothing upstream is
restated here.

## Wave formation

Tasks come from the plan's `## Dispatch Map` and per-task `Dependencies`
declarations. A wave = every task whose declared dependencies are already
committed AND whose file set overlaps no other candidate or running task.
Execute by readiness, never by written order.

Invariants:

- Never advance a dependent task before its dependency's commit lands.
- Never place two tasks touching the same file in one wave, even if both are
  declared independent.
- Keep as many file-disjoint implementers concurrent as the wave allows.
  (This refines upstream's no-parallel-implementers rule: that rule guards
  against file conflicts, which these invariants preserve.)

## Per-task cycle

1. Read the ledger before dispatching anything. A task with an
   `event=committed` entry is done — never re-dispatch it.
2. Slice the task's brief per upstream's file-handoff mechanics, then
   **preload** into the brief the relevant
   **superpowers:test-driven-development** content (REQUIRED) and any
   convention-skill content the task needs. Never instruct the subagent to
   invoke skills itself — content a subagent must fetch can be silently
   skipped; injected content cannot.
3. Dispatch **devcycle:implementer** with the brief only, on the model from
   Model routing below. Ledger: `event=dispatched`.
4. On report: ledger `event=report-received`. Produce the task diff — run
   `git add -N` on new files first (or they are invisible to diff), then
   `git diff -U10 HEAD -- <files>` to a file. (This replaces upstream's
   `scripts/review-package`: devcycle implementers do not commit, so there
   are no task commits to package until after acceptance.)
5. Dispatch **devcycle:task-reviewer** (read-only; its definition already
   encodes devcycle's reviewer hygiene — stale brief line numbers are matched
   on content, harness `<system-reminder>` blocks are a known
   prompt-injection false positive, and reports lacking red→green or
   convention-equivalent evidence are rejected) with the brief, report, and
   diff paths plus the task's constraints block. Upstream's reviewer-prompt
   rules govern the dispatch wording. Findings loop back to the
   implementer; re-review after fixes. Ledger: `event=review-verdict`.
6. **Green gate (REQUIRED, deterministic):** before accepting, re-run the
   task's test command yourself and read the exit status. The implementer's
   claimed output is never sufficient, and neither is a reviewer's accept
   verdict — both judge a report, not the repo. If the command fails:
   acceptance is blocked — no commit; ledger `event=review-verdict
   outcome=rejected (green gate: <symptom>)`; send it back to the
   implementer. If the repo has no test suite but documents its own
   verification convention, run that convention's command as the gate;
   never bolt a new test framework onto the repo to create one.
7. On acceptance: local commit with a Conventional Commit subject; ledger
   `event=committed` with the sha.

Green-gate red flags — if you are thinking "the report shows green", "the
reviewer already accepted", "we're behind schedule", or "re-running is
redundant", you are about to skip the gate. The gate is one command run.
Run it.

## Ledger

Single source of truth for progress, at upstream's path
`.superpowers/sdd/progress.md` (one ledger — do not create a second). One
appended line per event — all four fields REQUIRED, exactly this shape:

```
- [<ISO-8601 UTC>] task=<id> event=<dispatched|report-received|review-verdict|committed|user-decision> outcome=<short> ref=<commit-sha|file|none>
```

After any compaction or resume, trust the ledger and `git log` over
conversation memory.

## Model routing

Model names are configuration, not prose. For this stage:

- implementer dispatches: `${user_config.implementerModel}` — default
  `claude-opus-4-8`
- task-reviewer dispatches: `${user_config.taskReviewerModel}` — default
  `claude-sonnet-5`

If a value above still reads as a literal `${user_config...}` placeholder,
that option is unset — use the stated default. (`walkthroughModel` and
`branchReviewModel` belong to later stages, not this skill.) For explicit
model naming in dispatches and complexity-based downshifting, upstream's
Model Selection section governs — apply it with the names above. The
lineup is provisional: at execution start, check whether newer or
better-fitting models exist and propose rerouting before the first
dispatch.

## Plan hygiene before wave 1

Upstream's Pre-Flight Plan Review (the conflict scan before Task 1) runs
first; these two rules are devcycle additions to it.

A requirements block at the top of a plan that no task's steps implement
WILL be silently skipped. When the pre-dispatch read finds one, patch the
owning task's steps explicitly and re-extract that task's brief before
dispatching it.

Before a sub-project's first task, back up every file its tasks will modify
as byte-identical copies outside the repo.

## UI and on-device outcomes

Never claim a rendered or on-device outcome from a script, test, or report.
The moment a task produces rendered changes, add its outcomes to the
on-device checklist per **devcycle:verifying-on-device** (REQUIRED for
UI-bearing tasks) — at that task, not at wave end.

## Wave boundaries and handoff

At every wave boundary and at stage end, update `.devcycle/state.md`
(stage, branch, artifact paths, timestamp) and emit this block — all five
fields REQUIRED, exactly these labels:

```markdown
## Handoff
- Stage completed: <stage>
- Artifacts: <paths, one per line>
- Carry-overs: <pinned interfaces / open decisions, or "none">
- Context action: <Continue | Compact with hint | Clear + /devcycle:continue | Fresh session>
- Compaction hint: Keep <X>. Drop <Y>.
```

Context action by boundary:

- **wave → wave** (more waves remain): `Continue` while context is under
  ~40% capacity; `Compact with hint` at or above it. Keep: ledger/plan
  paths, pinned interfaces, dispatch map, wave status. Drop: implementer
  transcripts, resolved findings.
- **last wave → branch review**: `Clear + /devcycle:continue` (or fresh
  reviewer agents) — a reviewer that watched the code being written inherits
  the implementer's assumptions. Keep: branch, spec path, ledger path.
  Drop: all implementation context. The next stage is
  **devcycle:reviewing-the-branch** (REQUIRED — the branch gate before
  finishing).

## Resuming after /clear

Read `.devcycle/state.md`, the plan's Dispatch Map, the ledger, and
`git log`; resume at the first task without an `event=committed` entry.
