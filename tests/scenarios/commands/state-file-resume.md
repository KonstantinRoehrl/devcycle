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
6. *(Pipeline-start variant — setup and prompt in `## Regression (dry-run fixes)` below; exercises `commands/cycle.md` step 0 plus the scoping-interview entry check, the creation half of the resume contract.)* When `/devcycle:cycle` is invoked with a rough one-liner in a repo that has no `.devcycle/state.md`, the agent creates the state file as its opening action — on disk before the triage verdict is announced and before any scoping questions are asked (reading the current branch to fill the file's `branch:` line is part of creating it) — with `stage: scoping`, the current git branch, and `none` on the spec/plan/checklist lines, so a cycle interrupted mid-scoping still leaves a state file for `/devcycle:continue` to resume from.

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

## Regression (Task 12)

Run 2026-07-22 — full-pass regression against the committed text: fresh headless subagent (`claude -p`, model `claude-sonnet-5`), isolated config per the baseline-hygiene protocol (fresh CLAUDE_CONFIG_DIR holding only auth — no installed plugins, no machine-global instructions; the init event confirmed `plugins: []`), sandbox rebuilt per Setup in a session-temp directory.

- Criterion 1 PASS: read `.devcycle/state.md` and the ledger first, then plan/spec, `git log`, `git status`; also re-ran the task-2 test itself (`PASS remind`, exit 0) to verify the report's claim rather than trusting it.
- Criterion 2 PASS: announced stage `execution`, branch `feature/reminders` ("matches current branch — no mismatch"), and the plan/ledger/report paths.
- Criterion 3 PASS: Task 1 committed (cited the sandbox's real short SHA), Task 2 "report received … not yet reviewed, not yet committed" with the uncommitted working-tree changes named, Task 3 "not yet dispatched — gated on Tasks 1+2 being committed".
- Criterion 4 PASS: next action = review Task 2's report, commit on accept, then dispatch Task 3 — resuming the execution stage, not restarting.
- Criterion 5 PASS: "So this is **not done**" — corrected from file evidence; never asked the user to re-explain.
- Net: GREEN — no regression.

## Regression (dry-run fixes)

Criterion 6 added 2026-07-23 after the v0.2.1 end-to-end dry run found `.devcycle/state.md` first written at the scoping→brainstorm transition, not at pipeline start (dry-run report, rough edge #2). Both runs: fresh headless subagents (`claude -p`, model `claude-sonnet-5`), isolated config (fresh CLAUDE_CONFIG_DIR holding only auth; init event confirmed `plugins: []`), run from the sandbox root.

**Variant setup:** the minimal Node sandbox from the dry run (a `package.json` with `"test": "node --test"`, `src/greet.js`, its passing test, one commit on `main`; no `.devcycle/` directory). Prompt: the full body of `commands/cycle.md` spliced as the invoked command plus the full `skills/scoping-interview/SKILL.md` (the stage the command enters), then: the user invoked `/devcycle:cycle add a slugify helper with tests`; produce your first response; no human is available mid-response, so ask and stop — the session may be interrupted at any time.

**Baseline (red) — scripted run 2026-07-23 against the previous committed text** (which said only "Create it when the pipeline starts" with no step-0 imperative):

- Criterion 6 FAIL, reproducing the dry-run behavior exactly: the agent announced triage, researched the repo, ran the scoping fallback batch, and hard-stopped — with NO `.devcycle/state.md` on disk at session end. A cycle interrupted at that stop would leave nothing for `/devcycle:continue`.
- Net: RED.

**Result (green) — run 2026-07-23 against the fixed text** (cycle.md step 0 + scoping-interview stage-entry backstop):

- Criterion 6 PASS: the agent's opening line was "I'll start by creating the pipeline state file"; it read the current branch, wrote `.devcycle/state.md` with exactly the step-0 content (`stage: scoping`, `branch: main`, `spec: none`, `plan: none`, `ledger: .superpowers/sdd/progress.md`, `checklist: none`, ISO-8601 `updated`), and only then announced the triage verdict and ran the scoping batch to its hard stop. Minor variance, accepted: one repo-orientation `cat` was bundled with the branch-discovery command before the Write, but the file was on disk before any triage or interview output. The interrupted-mid-scoping guarantee now holds.
- Net: GREEN.
