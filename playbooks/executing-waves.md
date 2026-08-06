# Executing Waves

## Engine

Resolve `profile` first — read `${CLAUDE_PLUGIN_ROOT}/references/config.md` and follow it; it also
owns model routing for this stage's two knobs, `${user_config.implementerModel}` and
`${user_config.taskReviewerModel}` (`walkthroughModel` and `branchReviewModel` belong to later
stages). Every agent this skill dispatches reports per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.
What the coordinator does itself and what it delegates — including the stage budget, which binds this
skill hardest — is owned by `${CLAUDE_PLUGIN_ROOT}/references/delegation.md`: read it and follow it.

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
   (create/modify/test); `**Interfaces:**` (consumes/produces, exact signatures); `**Dependencies:**`;
   the `**Evidence:**` class from the plan; an `**Evidence tail:** <N>` line, `<N>` from the profile;
   the task's steps; the global constraints and pinned interfaces that apply; the task's quality
   constraints resolved; and one named reference,
   `${CLAUDE_PLUGIN_ROOT}/references/delegation.md` § Read discipline. Nothing else, and nothing
   restated that a named reference owns — `${CLAUDE_PLUGIN_ROOT}/references/evidence.md` owns the
   evidence classes, the evidence file paths (keyed on the task id, which is why every brief carries
   it), and the report shape the implementer must produce.
   - **Resolve the quality constraints:** look each id on the task's `**Quality constraints:**` line
     up in the plan's `## Quality Constraints` section and splice those lines in verbatim, ids
     included, since a bare `QC3` is unreadable to an implementer. **Never the whole criteria
     catalog, and never the plan's whole constraints section** — only the lines this task's ids name;
     `references/quality-criteria.md`'s cost rule owns why. A task declaring `none`, or a plan with
     no such section, adds nothing here.
   - **Preload what the evidence class needs:** `red-green` at `thorough`, the relevant
     **superpowers:test-driven-development** content (REQUIRED); `red-green` at `lean`/`standard`, an
     excerpt carrying exactly three things and nothing beyond them — write the failing test first,
     run it and capture the red output before writing implementation code, then write only enough
     code to pass and capture the green output; `green-green` and `convention`, no TDD splice but the
     exact suite or convention command their before/after evidence must run. Plus any convention-skill
     content the task needs — never an instruction for the subagent to fetch a skill itself, which it
     can silently skip where injected content cannot. Evidence is never profile-conditional; only
     `<N>` varies.
3. **Dispatch devcycle:implementer** with that brief only, never accumulated session history or other
   tasks' reports, on the model `references/config.md` resolves. The dispatch prompt must NEVER
   instruct the implementer to commit, stage, or push. Ledger `event=dispatched`. It returns the
   implementer envelope `references/delegation.md` defines — never the report body — and that
   envelope's on-device count is what triggers the checklist below.
4. **Confirm the report file exists** at the envelope's named path before logging
   `event=report-received` with `ref=` that path: the envelope's `report:` field is the implementer's
   claim, not proof. A missing file is treated the way step 6 treats a failed green gate — ledger
   `event=report-received outcome=rejected (missing report file)` with `ref=` the named path, then
   back to the implementer, no reviewer dispatch. The coordinator neither produces nor reads the task
   diff; step 5 does both.
5. **Dispatch devcycle:task-reviewer** (read-only) with the brief, the report path, the task's file
   list, the two evidence-file paths the report names, and the task's constraints block, instructing
   it to produce the diff itself: `git add -N <new files>` first, or they are invisible to diff, then
   `git diff -U10 HEAD -- <files>`. It returns the task-reviewer envelope `references/delegation.md`
   defines; it has no write tool, so the coordinator writes what that envelope returns to
   `.devcycle/findings/<task-id>-round-<n>.md`. Ledger one `event=review-round` per reviewer dispatch
   (round n) and `event=review-verdict` for its outcome; a non-zero blocking count sends the findings
   path back to the implementer, and re-review after fixes logs the next `review-round`.

   Cap: 3 rounds per task; one round is one reviewer dispatch plus the implementer's fix pass.
   Statuses and their reporting are owned by `${CLAUDE_PLUGIN_ROOT}/references/loops.md` — a task
   that reaches round 3 without acceptance exits `exhausted-unresolved` and is surfaced to the user
   as a decision, never committed as if it had passed.
6. **Green gate (REQUIRED, deterministic).** Before accepting, re-run the task's test command
   yourself and read the exit status — the implementer's claimed output and the reviewer's accept
   verdict both judge a report, not the repo, and neither is sufficient. A repo with no test suite
   but a documented verification convention runs that convention's command instead; never bolt a new
   test framework onto the repo to create one. On failure, acceptance is blocked: no commit, ledger
   `event=review-verdict outcome=rejected (green gate: <symptom>)`, back to the implementer.
7. **Branch re-check, then commit.** Immediately before the commit, re-run
   `git rev-parse --abbrev-ref HEAD` against the recorded `branch:` line, per
   `${CLAUDE_PLUGIN_ROOT}/references/branch.md`'s per-commit re-check; a mismatch stops the run
   rather than committing to the wrong branch. Then, on acceptance: a local commit with a
   Conventional Commit subject, scoped per
   `${CLAUDE_PLUGIN_ROOT}/references/commit-convention.md`'s "Scoping the commit". Ledger
   `event=committed` with the sha.

**Trigger: this commit closes the wave.** When no task in the current wave remains undispatched, in
review, or uncommitted, stop here — before forming the next wave — and follow ## Wave boundaries and
handoff below.

### Sweep-executed tasks

A task whose plan entry carries `**Execution:** sweep` replaces steps 2–3 with one run of the
mechanical-sweep workflow; steps 4–7 then apply with the deltas below. The invocation contract —
args-JSON shape, the `$(cat …)` invocation, `DEVCYCLE_SWEEP_MODEL` resolution, the clean-targets
precondition, the exit-code taxonomy, and the re-run rule — is owned by
**${CLAUDE_PLUGIN_ROOT}/playbooks/sweeping-mechanical-changes.md** (REQUIRED, its steps 2–4).

- **Run it.** Take files, instruction, and verifyCommand verbatim from the task body into
  `.devcycle/sweep-args-<task-id>.json` and save the stdout report to
  `.devcycle/sweep-report-<task-id>.json` — per task, since the triage path's single names would
  collide across concurrent sweeps. Ledger IMMEDIATELY before the invocation, in
  `references/config.md`'s audit shape: `event=dispatched outcome=sweep model <decision>`, so a crash
  mid-sweep still shows the task dispatched.
- **Clean targets** apply before a task's FIRST invocation, and a dirty target means the sweep does
  not run for that task: ledger `event=user-decision outcome=sweep dirty-targets` naming the files,
  then the fallback below. On a re-run of a task already logged `dispatched outcome=sweep`, dirty
  targets are the interrupted run's own edits and take the sweep playbook's Resume confirmation
  instead.
- **Exit 0, `applied` non-empty.** The saved report IS the implementer report: ledger
  `event=report-received` with it as `ref=`, then the task-reviewer dispatch (report included, skips
  and all), the green gate, and the acceptance commit exactly as steps 4–7 define. No implementer
  exists to write the evidence files, so the coordinator writes them itself per
  `references/evidence.md`, with one binding substitution: `<task-id>` is the plan's task number, not
  the literal `sweep` id that reference names for the standalone triage route.
- **Exit 0, `applied` empty.** Nothing was swept: no diff to review, nothing to commit, steps 4–7 do
  not apply. Ledger `event=report-received outcome=sweep applied-none` with the report as `ref=`,
  relay its per-file reasons verbatim, then the fallback — that line already marks the pending
  decision, so log nothing further.
- **Hard stop** (exit 1 with a stdout report): ledger `event=review-verdict outcome=rejected (sweep
  hard stop: <reason>)`, then the fallback. A fatal exit 1 without a report logs no verdict.
- **The fallback**, in each case above, is a user decision: corrected parameters and a re-run, or a
  normal `devcycle:implementer` dispatch for the task. A **rejection** of a swept diff (reviewer
  findings or green gate) goes straight to that implementer dispatch, never a sweep re-run of the
  rejected instruction. Any such brief must disclose the files the sweep already applied, or instruct
  reverting them first; it never assumes a clean slate.

## Ledger

Single source of truth for progress, at `.devcycle/ledger.md` — one ledger, never a second. This
skill creates the file, before any per-event line, with these three records at the top, each written
once, in this order:

```
Plan: `<the plan path this stage was handed>`
Branch: `<topic branch>` (cut from `<integration or default branch>`)
Profile: `<resolved profile>` (evidence tail <N> lines)
```

`Branch:` is recorded once pre-flight step 1 has the topic branch, `Profile:` from this skill's own
resolved profile, and pre-flight step 2 appends a fourth line, `Commit-convention:`, after these
three once its derivation runs — `references/commit-convention.md` owns that line's format. Then one
appended line per event, all four fields REQUIRED, exactly this shape:

```
- [<ISO-8601 UTC>] task=<id> event=<dispatched|report-received|review-round|review-verdict|committed|user-decision> outcome=<short> ref=<commit-sha|file|none>
```

After any compaction or resume, trust the ledger and `git log` over conversation memory.

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

Read `${CLAUDE_PLUGIN_ROOT}/references/resume.md` and follow it — it settles the branch and re-derives
position from git evidence. Then read `.devcycle/state.md`, the plan's Dispatch Map, and the ledger,
and resume each task from its last ledger event, most specific row winning. Sweep rows key on the
event's logged `outcome=` (a `sweep` token in it), never on the task's `**Execution:** sweep` marker:
a bare `dispatched` on a sweep-marked task is a post-rejection implementer fix and takes the generic
rows.

| ledger last event for a task | resume action |
| --- | --- |
| `dispatched` | re-dispatch the same brief (the run may have died) |
| `report-received` | dispatch the reviewer (it produces the diff itself) |
| `review-round` (no verdict after it) | the reviewer's run may have died: re-dispatch it for that round |
| `review-verdict outcome=accepted` | run the green gate, commit |
| `review-verdict outcome=rejected` | re-dispatch the implementer with the findings — on a sweep-marked task, a fresh dispatch briefed per the rejection bullet (findings, task body, applied-edits disclosure), never a sweep re-run |
| `committed` | task done — move to the next task |
| `dispatched outcome=sweep …` | no brief to re-dispatch: re-run the sweep bullets from the clean-targets check |
| any other sweep-token outcome (`applied-none`, `dirty-targets`, `sweep hard stop: …`) | a decision was pending when the run died: re-present the fallback, never an automatic dispatch. Reasons come from the saved report, or for `dirty-targets` from the files the event names (no sweep ran, so no report exists); a hard stop also carries its applied-files disclosure |
