# Executing Waves

## Engine

Resolve `profile` first — read `${CLAUDE_PLUGIN_ROOT}/references/config.md` and follow it; it also
owns model routing for this stage's two knobs, `${user_config.implementerModel}` and
`${user_config.taskReviewerModel}` (`walkthroughModel` and `branchReviewModel` belong to later
stages). Every agent this skill dispatches reports per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.
What the coordinator does itself and what it delegates — including the stage budget, which binds this
skill hardest — is owned by `${CLAUDE_PLUGIN_ROOT}/references/delegation.md`: read it and follow it.

Read this stage's lessons: `node "${CLAUDE_PLUGIN_ROOT}/scripts/dream.mjs" --lessons execution`. No store, no output.

At **`lean` / `standard`**, do not load **superpowers:subagent-driven-development** — the mechanics
below are self-contained. At **`thorough`**, load it (REQUIRED): it owns brief slicing and file
handoffs, the review/fix loop, implementer-status handling, reviewer-prompt construction, and
continuous execution, and these deltas are the only places devcycle differs from it.

- Its tail does NOT apply: its final-code-reviewer dispatch and its finishing-a-development-branch
  step are replaced by devcycle's reviewing-the-branch and finish stages.
- Its Pre-Flight Plan Review (the conflict scan before Task 1) runs ahead of the pre-flight below.
- Its never-start-on-main rule is replaced by `references/branch.md`, which also forbids the
  integration branches that file names.
- Its file-handoff mechanics know of neither the quality-constraint ids, the task id, nor the
  `**Evidence tail:** <N>` line: add all three to the sliced brief exactly as step 2 defines them.
- Its reviewer-prompt rules govern the wording of the step 5 dispatch.
- Its `scripts/review-package` does not apply: devcycle implementers do not commit, so there is
  nothing to package; step 5's reviewer produces the diff itself.
- Its implementers-commit convention does not apply — the coordinator commits, at step 7.
- Its progress-file path is replaced by `.devcycle/ledger.md`; devcycle writes only that file.

## Pre-flight, before wave 1

1. **Branch discipline.** Read `${CLAUDE_PLUGIN_ROOT}/references/branch.md` and follow it before
   dispatching anything — the coordinator commits from wave 1 onward, so the topic branch must exist
   and be recorded first.
2. **Commit convention.** Read `${CLAUDE_PLUGIN_ROOT}/references/commit-convention.md` and follow its
   derivation before wave 1's first commit, recording the result as the ledger's `Commit-convention:`
   preamble line.
3. **Plan hygiene.** A requirements block at the top of a plan that no task's steps implement WILL be
   silently skipped. When the pre-dispatch read finds one, patch the owning task's steps explicitly
   and re-extract that task's brief before dispatching it.

## Wave formation

Tasks come from the plan's `## Dispatch Map` and per-task `Dependencies` declarations. A wave = every
task whose declared dependencies are already committed AND whose file set overlaps no other candidate
or running task. Execute by readiness, never by written order. Invariants: never advance a dependent
task before its dependency's commit lands; never place two tasks touching the same file in one wave,
even if both are declared independent; and keep as many file-disjoint implementers concurrent as the
wave allows. (That last one refines upstream's no-parallel-implementers rule, which guards against
file conflicts these invariants already preserve.)

## Per-task cycle

1. **Read the ledger first.** A task with an `event=committed` entry is done — never re-dispatch it.
2. **Slice the brief**, carrying exactly: the task's id (the plan's task number); `**Files:**`
   (create/modify/test); `**Interfaces:**` (consumes/produces, exact signatures); `**Dependencies:**`; the
   `**Evidence:**` class from the plan; an `**Evidence tail:** <N>` line, `<N>` from the profile; the
   task's steps; the global constraints and pinned interfaces that apply; the task's quality constraints
   resolved; and one named reference, `${CLAUDE_PLUGIN_ROOT}/references/delegation.md` § Read discipline.
   Nothing else, and nothing restated that a named reference owns —
   `${CLAUDE_PLUGIN_ROOT}/references/evidence.md` owns the evidence classes, the evidence file paths (keyed
   on the task id, which is why every brief carries it), and the report shape the implementer must produce.
   - **Resolve the quality constraints:** look each id on the task's `**Quality constraints:**` line up in
     the plan's `## Quality Constraints` section and splice those lines in verbatim, ids included, since a
     bare `QC3` is unreadable to an implementer. **Never the whole criteria catalog, and never the plan's
     whole constraints section** — only the lines this task's ids name; `references/quality-criteria.md`'s
     cost rule owns why. A task declaring `none`, or a plan with no such section, adds nothing here.
   - **Preload what the evidence class needs:** splice exactly what
     `${CLAUDE_PLUGIN_ROOT}/references/evidence.md` § Preloading a class into a brief names.
3. **Dispatch devcycle:implementer** with that brief only, never accumulated session history or other
   tasks' reports, on the model `references/config.md` resolves. The dispatch prompt must NEVER
   instruct the implementer to commit, stage, or push. Ledger `event=dispatched`. It returns the
   implementer envelope `references/delegation.md` defines — never the report body — and that
   envelope's on-device count is what triggers the checklist below.
4. **Confirm the report file exists** at the envelope's named path, **and that it carries the fields
   its declared evidence class requires** (`${CLAUDE_PLUGIN_ROOT}/references/evidence.md` owns the
   classes), before logging `event=report-received` with `ref=` that path — the envelope's `report:`
   field is a claim, not proof. Missing or mismatched: ledger `event=report-received
   outcome=rejected (missing report file)`, `ref=` the named path, back to the implementer, no
   reviewer dispatch. Otherwise write the `dispatch` line now — `run-record.mjs append --kind
   dispatch` — using step 3's own `startedAt`, this step's time as `endedAt`, the envelope's
   outcome, and the current round/retry index: every field this line needs is only known from
   here on. The coordinator neither produces nor reads the task diff; step 5 does both.
5. **Dispatch devcycle:task-reviewer** (read-only) with the brief, the report path, the task's file
   list, the two evidence-file paths the report names, and the task's constraints block, instructing
   it to produce the diff itself: `git add -N <new files>` first, or they are invisible to diff, then
   `git diff -U10 HEAD -- <files>`. It returns the task-reviewer envelope `references/delegation.md`
   defines; it has no write tool, so the coordinator writes what that envelope returns to
   `.devcycle/findings/<task-id>-round-<n>.md`. Ledger `event=review-round` per reviewer dispatch
   (round n), `event=review-verdict` for its outcome, then the `verdict` line — `run-record.mjs
   append --kind verdict` — this round's number, blocking count, the task's declared evidence
   class, `conformance` = `pass` on acceptance else `fail`. Non-zero blocking sends the findings
   path back to the implementer; re-review after fixes logs the next `review-round` (and, once the
   fix pass's envelope returns, another step-4 `dispatch` line).

   Cap: 3 rounds per task; one round is one reviewer dispatch plus the implementer's fix pass.
   Statuses and their reporting are owned by `${CLAUDE_PLUGIN_ROOT}/references/loops.md` — a task
   that reaches round 3 without acceptance exits `exhausted-unresolved` and is surfaced to the user
   as a decision, never committed as if it had passed.
6. **Green gate (REQUIRED, deterministic).** Before accepting, re-run the task's test command
   yourself and read the exit status. A repo with no test suite runs its documented convention instead.
   On failure, acceptance is blocked: no commit, ledger
   `event=review-verdict outcome=rejected (green gate: <symptom>)`, back to the implementer; if this
   round's own reviewer wrote `conformance=pass`, also append a `verdict` line with `conformance=fail` for
   this round — a reviewer-rejected round never wrote `conformance=pass`. Journal the outcome either way:
   `run-record.mjs append --run <id> --kind event --event gate-fail --stage execution --task <task-id>` on
   a failure, `--event gate-pass-clean` on a clean pass. Enums and ids only — never the failure text.
7. **Branch re-check, then commit.** Immediately before the commit, re-run
   `git rev-parse --abbrev-ref HEAD` against the recorded `branch:` line, per
   `${CLAUDE_PLUGIN_ROOT}/references/branch.md`'s per-commit re-check; a mismatch stops the run rather than
   committing to the wrong branch. Then, on acceptance: a local commit with a Conventional Commit subject,
   scoped per `${CLAUDE_PLUGIN_ROOT}/references/commit-convention.md`'s "Scoping the commit". Ledger
   `event=committed` with the sha, then `run-record.mjs append --kind commit` with the task id and sha.

**Trigger: this commit closes the wave.** When no task in the current wave remains undispatched, in
review, or uncommitted, stop here — before forming the next wave — and follow ## Wave boundaries and
handoff below.

### Sweep-executed tasks

A task whose plan entry carries `**Execution:** sweep` replaces steps 2–3 with one mechanical-sweep
run; steps 4–7 apply with six deltas: `${CLAUDE_PLUGIN_ROOT}/references/sweep-execution.md` owns them.

## Ledger

Progress is written to `.devcycle/ledger.md`; pre-flight steps 1–2 supply its `Branch:` and
`Commit-convention:` lines, and `${CLAUDE_PLUGIN_ROOT}/references/ledger.md` owns its write format.

## UI and on-device outcomes

Never claim a rendered or on-device outcome from a script, test, or report. **Trigger: the moment a
task produces rendered changes** — generate or update the on-device checklist in that same wave, never
deferred to the end of the wave or the branch. That trigger is this skill's own; everything else about
a checklist — its path and state-file record, its item shape, the dimensions it covers, and the
`(auto)` boundary that decides what may ever be checked off without a human — is
`${CLAUDE_PLUGIN_ROOT}/references/checklist.md`: read it and follow it. The later walkthrough of that
checklist is `${CLAUDE_PLUGIN_ROOT}/playbooks/verifying-on-device.md`'s stage, on the same file.

## Wave boundaries and handoff

At every wave boundary and at stage end, update `.devcycle/state.md` (`stage:` = the stage the next
session should resume at — `execution` while waves remain, `branch-review` at stage end — plus branch,
artifact paths, timestamp), then emit the handoff block per
`${CLAUDE_PLUGIN_ROOT}/references/handoff.md`: read it and follow it, including which first-field
label the boundary takes, the context action, and the gate that stops the run until the user acts.
After the last wave's handoff this skill ends; the next stage is
**${CLAUDE_PLUGIN_ROOT}/playbooks/reviewing-the-branch.md** (REQUIRED — the branch gate before
finishing).

## Resuming after /clear

Read `${CLAUDE_PLUGIN_ROOT}/references/resume.md` and follow it: it settles the branch, re-derives
position from git evidence, and owns the ledger-event → resume-action table, sweep rows included.
