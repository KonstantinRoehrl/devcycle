---
name: executing-waves
description: Use when executing a wave-based implementation plan with subagent implementers, resuming one after /clear, or when dispatching, reviewing, or committing plan tasks.
---

# Executing Waves

## Engine

Resolve `profile` first — read `${CLAUDE_PLUGIN_ROOT}/references/config.md` and
follow it.

- **`thorough`** — load **superpowers:subagent-driven-development** (REQUIRED)
  and overlay it exactly as before: it owns brief slicing and file handoffs, the
  review/fix loop, implementer-status handling, reviewer-prompt construction, and
  continuous execution. Upstream's tail does NOT apply: its final-code-reviewer
  dispatch and its finishing-a-development-branch step are replaced by devcycle's
  reviewing-the-branch and finish stages. Nothing upstream is restated here.
- **`lean` / `standard`** — do not load it. The mechanics below are
  self-contained.

**One behavioral contract across both engines:** the same wave-formation
invariants, the same ledger events, the same green gate, the same review cycle.
Only the *source* of the brief-slicing and review-loop mechanics differs.

Model routing for this stage's two knobs — `${user_config.implementerModel}` and
`${user_config.taskReviewerModel}` (`walkthroughModel` and `branchReviewModel`
belong to later stages, not this skill) — and every other knob or profile
question: read `${CLAUDE_PLUGIN_ROOT}/references/config.md` and follow it. Every
agent this skill dispatches reports per
`${CLAUDE_PLUGIN_ROOT}/references/output.md`.

## Pre-flight, before wave 1

1. **Branch discipline.** Read `${CLAUDE_PLUGIN_ROOT}/references/branch.md` and
   follow it before dispatching anything — the coordinator commits from wave 1
   onward, so the topic branch must exist and be recorded first. At `thorough`
   this replaces upstream's never-start-on-main rule, which covers only
   `main`/`master`; devcycle's rule also forbids the integration branches that
   file names.
2. **Plan hygiene.** A requirements block at the top of a plan that no task's
   steps implement WILL be silently skipped. When the pre-dispatch read finds
   one, patch the owning task's steps explicitly and re-extract that task's brief
   before dispatching it. At `thorough`, upstream's Pre-Flight Plan Review (the
   conflict scan before Task 1) runs first and this rule is an addition to it.

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
2. **Slice the brief.** At `thorough`, per upstream's file-handoff mechanics. At
   `lean`/`standard`, the brief is assembled here and carries exactly: the
   task's id (the plan's task number), its `**Files:**` (create/modify/test),
   `**Interfaces:**` (consumes/produces, with exact signatures),
   `**Dependencies:**`, the task's `**Evidence:**` class from the plan, the
   task's steps, and the global constraints and pinned interfaces that apply —
   nothing else.

   **Every brief, at every profile, carries the task's id and an
   `**Evidence tail:** <N>` line.** The id because `references/evidence.md` keys
   the evidence paths on it — `.devcycle/evidence/<task-id>-before.txt` and
   `-after.txt` — so an implementer never handed it invents one, and the
   reviewer and the acceptance step cannot predict where to look. `<N>` comes
   from the profile. Upstream's file-handoff mechanics know of neither, so at
   `thorough` add both to the sliced brief. Evidence is never
   profile-conditional; only the value of `<N>` varies.

   Then **preload** into the brief the content the evidence class needs:
   - `red-green` at `thorough`: the relevant
     **superpowers:test-driven-development** content (REQUIRED).
   - `red-green` at `lean`/`standard`: an excerpt carrying exactly three things —
     write the failing test first; run it and capture the red output before
     writing implementation code; then write only enough code to pass and capture
     the green output. Splice nothing beyond those three.
   - `green-green` and `convention`: no TDD splice; the brief instead names the
     exact suite or convention command their before/after evidence must run.

   Plus any convention-skill content the task needs. Never instruct the subagent
   to invoke skills itself — content a subagent must fetch can be silently
   skipped; injected content cannot. Evidence classes, evidence file paths, and
   the report shape the implementer must produce are owned by
   `${CLAUDE_PLUGIN_ROOT}/references/evidence.md`; name it in the brief rather
   than restating it.
3. Dispatch **devcycle:implementer** with the brief only, on the model
   `references/config.md` resolves. A dispatch carries that task's brief and
   pinned interfaces — never accumulated session history or other tasks' reports:
   the plan drew task boundaries so each brief is self-contained, and dispatch
   must preserve that so every subagent's context stays small. The dispatch
   prompt must NEVER instruct the implementer to commit, stage, or push — in
   devcycle the coordinator owns commits (step 7, after review and the green
   gate); upstream's implementers-commit convention does not apply here. Ledger:
   `event=dispatched`.
4. On report: ledger `event=report-received`. Produce the task diff — run
   `git add -N` on new files first (or they are invisible to diff), then
   `git diff -U10 HEAD -- <files>` to a file. (This replaces upstream's
   `scripts/review-package`: devcycle implementers do not commit, so there
   are no task commits to package until after acceptance.)
5. Dispatch **devcycle:task-reviewer** (read-only; its definition encodes
   devcycle's reviewer hygiene) with the brief, the report, the diff path, the
   two evidence-file paths the report names, and the task's constraints block.
   At `thorough`, upstream's reviewer-prompt rules govern the dispatch wording.
   Ledger one `event=review-round` per reviewer dispatch (round n), and
   `event=review-verdict` for its outcome. Findings loop back to the implementer;
   re-review after fixes, logging the next `review-round`.
6. **Green gate (REQUIRED, deterministic):** before accepting, re-run the
   task's test command yourself and read the exit status. The implementer's
   claimed output — including the evidence files and the tail in its report — is
   never sufficient, and neither is a reviewer's accept verdict: both judge a
   report, not the repo. If the command fails: acceptance is blocked — no commit;
   ledger `event=review-verdict outcome=rejected (green gate: <symptom>)`; send
   it back to the implementer. If the repo has no test suite but documents its
   own verification convention, run that convention's command as the gate;
   never bolt a new test framework onto the repo to create one.
7. On acceptance: local commit with a Conventional Commit subject, scoped by an
   explicit pathspec covering the task's own source files — `git commit --
   <the task's file list>`, never `git add -A` and never a bare `git commit`.
   Concurrent implementers have in-flight edits elsewhere in the tree and the
   index picks up entries from their `git add -N` calls, so an unscoped commit
   sweeps another task's work into this one's. The pathspec names the task's
   files and nothing else: the evidence files under `.devcycle/evidence/` stay
   out of it — target repos are told to gitignore `.devcycle/` (README), so
   naming an ignored, untracked path in a pathspec aborts the whole commit with
   "pathspec did not match any file known to git". Evidence files are
   working-tree artifacts the reviewer reads from the checkout, not history.
   Ledger `event=committed` with the sha.

Green-gate red flags — if you are thinking "the report shows green", "the
reviewer already accepted", "we're behind schedule", or "re-running is
redundant", you are about to skip the gate. The gate is one command run.
Run it.

Dispatch-prompt red flags — if a dispatch prompt you are drafting contains
"commit your work", "commit with a Conventional Commit subject", or any
git commit/stage/push instruction, delete it before dispatching.
Implementers report completion and list files; the coordinator commits
(step 7).

### Sweep-executed tasks

A task whose plan entry carries `**Execution:** sweep` replaces steps 2–3
(brief slicing, implementer dispatch) with one run of the mechanical-sweep
workflow; steps 4–7 then apply with the deltas below. The invocation
contract — args-JSON shape, the `$(cat …)` invocation, `DEVCYCLE_SWEEP_MODEL`
resolution, the clean-targets precondition, the exit-code taxonomy, and the
re-run rule — is owned by **devcycle:sweeping-mechanical-changes**
(REQUIRED, its steps 2–4). Only the task-level deltas live here:

- **Run it.** Take files, instruction, and verifyCommand verbatim from the
  task body (the plan declared the marker only because it pinned them) into
  `.devcycle/sweep-args-<task-id>.json`, and save the stdout report to
  `.devcycle/sweep-report-<task-id>.json` — per task, since the triage
  path's single names would collide across concurrent sweeps. Ledger
  IMMEDIATELY before the invocation: `event=dispatched outcome=sweep model
  <decision>` in `references/config.md`'s audit shape, logged pre-run so a crash
  mid-sweep still shows the task dispatched and resume routes its leftover
  edits to the re-run rule rather than the clean-targets ban.
- **Clean targets** apply before a task's FIRST invocation. There is no
  gate 2 to stop at here, so a dirty target means the sweep does not run for
  that task: ledger `event=user-decision outcome=sweep dirty-targets` naming
  the files, then the fallback below. On a re-run of a task already logged
  `dispatched outcome=sweep`, dirty targets are the interrupted run's own
  edits and take the sweep skill's Resume confirmation instead.
- **Exit 0, `applied` non-empty.** The saved report IS the implementer
  report: ledger `event=report-received` with it as `ref=`, then diff
  production, the task-reviewer dispatch (report included, skips and all),
  the green gate, and the acceptance commit exactly as steps 4–7 define,
  step 7's pathspec included. There is no
  implementer to write the evidence files, so the coordinator writes them itself
  per the file-backed contract in `references/evidence.md` — with one binding
  substitution: a sweep-executed task is a plan task inside a wave, so its
  `<task-id>` is the plan's task number, giving
  `.devcycle/evidence/<task-id>-before.txt` and `-after.txt`. The literal
  `sweep` id that reference names belongs to the standalone triage route, where
  exactly one sweep runs; here it would collide across concurrent sweeps for the
  same reason the per-task report name does.
- **Exit 0, `applied` empty.** Nothing was swept: no diff to review, nothing
  to commit, steps 4–7 do not apply. Ledger `event=report-received
  outcome=sweep applied-none` with the report as `ref=`, relay its per-file
  reasons verbatim, then the fallback below — that line already marks the
  pending decision, so log nothing further.
- **Hard stop** (exit 1 with a stdout report): ledger `event=review-verdict
  outcome=rejected (sweep hard stop: <reason>)`, then the fallback. A fatal
  exit 1 without a report logs no verdict — there is nothing to review.
- **The fallback**, in each case above, is a user decision: corrected
  parameters and a re-run, or a normal `devcycle:implementer` dispatch for
  the task. A **rejection** of a swept diff (reviewer findings or green
  gate) goes straight to that implementer dispatch — there is no implementer
  to send back to, and re-running would re-apply the very instruction that
  was rejected. Any such brief must disclose the files the sweep already
  applied, or instruct reverting them first; it never assumes a clean slate.

## Ledger

Single source of truth for progress, at `.devcycle/ledger.md` (one ledger — do
not create a second). At `thorough`, where upstream is loaded, this path
overrides upstream's own progress-file path: devcycle writes only
`.devcycle/ledger.md`, never both. One appended line per event — all four fields
REQUIRED, exactly this shape:

```
- [<ISO-8601 UTC>] task=<id> event=<dispatched|report-received|review-round|review-verdict|committed|user-decision> outcome=<short> ref=<commit-sha|file|none>
```

After any compaction or resume, trust the ledger and `git log` over
conversation memory.

## UI and on-device outcomes

Never claim a rendered or on-device outcome from a script, test, or report.
Generating the on-device checklist is a mid-wave coordinator duty and lives here;
the later walkthrough of that checklist is **devcycle:verifying-on-device**'s
stage.

**Trigger: the moment a task produces rendered changes** — generate or update the checklist in
that same wave. Never defer it to the end of the wave or the branch. That trigger is this
skill's own; everything else about the checklist is not.

What a checklist is — its path and state-file record, its item shape, the dimensions it
covers, and the `(auto)` boundary that decides what may ever be checked off without a human —
is `${CLAUDE_PLUGIN_ROOT}/references/checklist.md`. Read it and follow it; it is not restated
here, and `devcycle:verifying-on-device` follows the same file.

## Wave boundaries and handoff

At every wave boundary and at stage end, update `.devcycle/state.md` (`stage:` =
the stage the next session should resume at — `execution` while waves remain,
`branch-review` at stage end — plus branch, artifact paths, timestamp), then emit
the handoff block per `${CLAUDE_PLUGIN_ROOT}/references/handoff.md`: read it and
follow it, including which first-field label the boundary takes, the context
action, and the gate that stops the run until the user acts. After the last
wave's handoff this skill ends; the next stage is
**devcycle:reviewing-the-branch** (REQUIRED — the branch gate before finishing).

## Resuming after /clear

Read `${CLAUDE_PLUGIN_ROOT}/references/resume.md` and follow it — it settles the
branch and re-derives position from git evidence. Then read `.devcycle/state.md`,
the plan's Dispatch Map, and the ledger, and resume each task from its last
ledger event — most specific row wins. Sweep rows key on the event's logged
`outcome=` (a `sweep` token in it), never on the task's `**Execution:** sweep`
marker: a bare `dispatched` on a sweep-marked task is a post-rejection
implementer fix and takes the generic rows.

| ledger last event for a task | resume action |
| --- | --- |
| `dispatched` | re-dispatch the same brief (the run may have died) |
| `report-received` | produce the diff, dispatch the reviewer |
| `review-round` (no verdict after it) | the reviewer's run may have died: re-dispatch the reviewer for that round |
| `review-verdict outcome=accepted` | run the green gate, commit |
| `review-verdict outcome=rejected` | re-dispatch the implementer with the findings — on a sweep-marked task, a fresh dispatch briefed per the rejection bullet (findings, task body, applied-edits disclosure), never a sweep re-run |
| `committed` | task done — move to the next task |
| `dispatched outcome=sweep …` | no brief to re-dispatch: re-run the sweep bullets from the clean-targets check |
| any other sweep-token outcome (`applied-none`, `dirty-targets`, `sweep hard stop: …`) | a decision was pending when the run died: re-present the fallback, never an automatic dispatch. Reasons come from the saved report, or for `dirty-targets` from the files the event names (no sweep ran, so no report exists); a hard stop also carries its applied-files disclosure |
