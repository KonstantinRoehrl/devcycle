# Scenario: state-file-resume
- Skill under test: commands/continue.md (`/devcycle:continue`)
- Type: output-shape

## Setup

Create a temporary sandbox directory with the "taskly" Node.js CLI app (as in `tests/scenarios/scoping-interview/stop-gate.md`) captured mid-cycle:

1. `git init`, commit the base app on `main`, create and check out branch `feature/reminders`.
2. Commit a first implementation slice on the branch (e.g. a new `lib/reminders.js` with `addReminder(taskId, when)` plus its test) with subject `feat: add reminder storage`; note its short SHA.
3. `docs/superpowers/plans/2026-07-22-reminders.md` — a P5-shaped plan with three tasks: Task 1 `lib/reminders.js` (storage), Task 2 `bin/taskly.js` `remind` command, Task 3 reminder display in `list` output; Task 3 declares `Dependencies: Tasks 1+2 committed`; Dispatch Map: Wave 1 = Tasks 1+2, Wave 2 = Task 3.
4. `.superpowers/sdd/progress.md` — ledger entries (P3 format): task=1 dispatched → report-received → review-verdict accept → committed (ref = the short SHA from step 2); task=2 dispatched → report-received (`outcome=awaiting review`). No entries for task 3.
5. `.devcycle/state.md` — P1 state file: `stage: execution`, `branch: feature/reminders`, `spec: docs/superpowers/specs/2026-07-22-reminders-design.md`, `plan: docs/superpowers/plans/2026-07-22-reminders.md`, `ledger: .superpowers/sdd/progress.md`, `checklist: none`, a recent ISO-8601 `updated` value. (Create the spec file with a few plausible lines so the path resolves.)

Run the subagent from the sandbox root. For the **green** run, splice the full body of `commands/continue.md` into the prompt at the marked slot. For the **baseline (red)** run, omit the command block entirely.

## Subagent prompt

> You are a coding agent in this repository, in a brand-new session with no memory of any previous conversation.
>
> === COMMAND (the user invoked /devcycle:continue; follow this exactly; green run only) ===
> [Splice here: full body of commands/continue.md.]
> === END COMMAND ===
>
> The user says: "Continue where we left off. Honestly I don't remember where we were — I think we might have been basically done?"
>
> Produce your next response to the user. You may read any files in the repository first. Do not modify any files.

## Pass criteria

1. The agent reads `.devcycle/state.md`, the ledger, and the plan (visible in the transcript) before answering.
2. It announces the derived position from those files: stage `execution`, branch `feature/reminders`, and the artifact paths from the state file.
3. Its per-task account matches the ledger: Task 1 reviewed and committed (cites the commit), Task 2 report received but review pending, Task 3 not dispatched (blocked on Tasks 1+2 committed per the plan).
4. It names the concrete next action (complete Task 2's review, then dispatch Task 3 once Tasks 1+2 are committed) and resumes the execution stage — it does not restart the pipeline or an earlier stage.
5. It corrects the user's "we might have been done" from file evidence rather than adopting it, and never asks the user to re-explain what they were doing.

## Baseline (red)

Run 2026-07-22 — fresh headless subagent (`claude -p`, model `claude-sonnet-5`), command block omitted, isolated mid-cycle taskly sandbox in a session-temp directory.

- Criterion 1 PARTIAL: the agent did read `.devcycle/state.md`, the ledger, and the plan (the author's machine-global instructions, which already teach ledger discipline, leaked into the headless baseline — so this baseline overstates vanilla behavior).
- Criterion 2 FAIL: its announcement never mentioned the state file, the recorded stage, or the branch — no position statement, which is the command's core promise.
- Criterion 3 PASS: per-task account matched the ledger (Task 1 committed; Task 2 implemented, unreviewed, uncommitted; Task 3 not started).
- Criterion 4 PASS: proposed reviewing Task 2's diff, committing, then dispatching Task 3.
- Criterion 5 PASS: opened with "We're not done — there's still real work left."
- Net: RED — fails criterion 2.

## Result (green)

Run 2026-07-22 — same protocol, full body of `commands/continue.md` spliced into the command slot.

- Criterion 1 PASS: read `.devcycle/state.md` first, then the ledger, plan, and task-2 report; also cross-checked git (`rev-parse --abbrev-ref HEAD`, `git log`, `git diff -- bin/taskly.js`) and re-ran the tests to verify the report's red→green claim rather than trusting it.
- Criterion 2 PASS: announced "Devcycle status — reminders feature, `feature/reminders` branch, stage: execution"; ledger and report paths named in the announcement (spec/plan paths were read and reflected but not all re-listed verbatim — accepted as a compressed but accurate position statement).
- Criterion 3 PASS: Task 1 "committed as `87dd49c`" (the sandbox's real short SHA); Task 2 "report received … not yet reviewed and not committed — changes sitting uncommitted in the working tree"; Task 3 "not dispatched. Its dependency ('Tasks 1+2 committed') isn't satisfied yet".
- Criterion 4 PASS: "two steps remain: review Task 2's diff and commit it, then dispatch Task 3" — resuming the execution stage, not restarting the pipeline.
- Criterion 5 PASS: "So we're not basically done" — corrected from file evidence; never asked the user to re-explain.
- Net: GREEN — all five criteria met.
