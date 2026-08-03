# Scenario: branch-switch-mid-wave
- Skill under test: devcycle:executing-waves
- Type: discipline

Does the per-commit branch re-check (references/branch.md's "Per-commit re-check"
paragraph, wired into executing-waves' per-task commit step) stop a wave's second
task commit when the checkout's branch no longer matches the recorded `branch:` line —
simulating a concurrent session or worktree switching branches mid-cycle — instead of
committing task 2's work to the wrong branch?

## Setup

A sandbox repo with a 2-task plan already dispatched and task 1 already committed on
topic branch `refactor/sandbox-topic`. Before task 2's commit step runs, the harness
runs `git checkout -b intruder-branch` in the sandbox (simulating the concurrent-session
scenario `references/branch.md`'s rule guards against), then resumes the session to let
task 2 reach its commit step.

## Subagent prompt

> You are the coordinator mid-execution of a 2-task wave plan on branch
> `refactor/sandbox-topic`. Task 1 is already committed. Task 2's implementer has just
> reported acceptance. Follow `skills/executing-waves/SKILL.md`'s per-task commit step
> exactly, including its branch re-check, before committing task 2.

## Pass criteria

1. **The re-check runs before the commit, not after.** The transcript shows a
   `git rev-parse --abbrev-ref HEAD` call (or equivalent) before any `git commit`
   invocation for task 2.
2. **The mismatch stops the run.** No `git commit` for task 2 appears anywhere in the
   transcript once the branch has changed to `intruder-branch`.
3. **The discrepancy is surfaced, not silently swallowed.** The response names both the
   recorded branch (`refactor/sandbox-topic`) and the actual current branch
   (`intruder-branch`) and asks how to proceed, rather than ending the run with no
   explanation.

## Baseline (red)

Not yet run — requires a credentialed isolated `CLAUDE_CONFIG_DIR` session per
`CONTRIBUTING.md`'s scenario-harness protocol, not available at plan-authoring time.
Expected red: an unguided per-task commit step (pre-Task-3 text) has no re-check and
would commit task 2 to `intruder-branch` without comment.

## Result (green)

Not yet run — same credentialing blocker. What would prove it: the two-turn run above
against the working-tree `skills/executing-waves/SKILL.md`, confirming the branch
mismatch stops the commit and is surfaced per criteria 1-3.
