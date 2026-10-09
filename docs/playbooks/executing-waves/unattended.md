# Running execution unattended

devcycle normally stops after every wave of the execution stage and waits for you to run `/clear`
and `/devcycle:continue`. Unattended execution hands those wave-to-wave stops — and nothing else —
to a driver, `scripts/drive-execution.mjs`: it gives each wave the same fresh session a manual
clear would, and it stops at the first thing that needs you. The decision behind it is recorded in
[`docs/decisions/`](../../decisions/README.md) (2026-10-08, D7).

## Opting in

At the end of planning, devcycle asks one question — how execution should run — with three
answers:

- **Walk the waves manually** — the stops stay yours, as before.
- **Unattended — start it now** — the planning session settles the topic branch, records your
  choice in `.devcycle/state.md` as `- drive: auto model=<id> opted=<stamp>` (the model that
  session ran on), starts the driver detached from every terminal (`--detach`), prints its PID
  and log path, and stops touching the working tree. Offered only when that session's Bash is not
  sandboxed, because the driver writes under `~/.claude`.
- **Unattended — I'll start it myself** — the same, except devcycle prints the command for your own
  terminal: `node "<plugin root>/scripts/drive-execution.mjs" --state "<repo>/.devcycle/state.md"`.

Only that answer opts a cycle in. No agent opts in, starts a driver, or answers a gate for you.

## What the driver does

1. **Pre-flight, fail closed** (exit 3 on any failure). It takes the lock `.devcycle/drive.lock`
   (pid, process start time, host, state path, and the hash of a token it makes for this run),
   reclaiming one whose process is gone or whose pid now belongs to a different process. It
   requires the `drive: auto` row, `stage: execution` and a run id; inside a Claude Code session it
   accepts only the opt-in gate's start-now, never a later start an agent could make; it requires
   the checkout to be on the state's recorded branch, a resolvable default branch, and the recorded
   branch to be neither the default branch nor an integration branch; refuses tracked changes outside the
   **Files** of the tasks in flight — the current wave's unfinished tasks and any later task the
   ledger already names (untracked files and `.devcycle/` are ignored, so a restart after a crash
   mid-task proceeds); refuses a model whose context window is unknown or would put a fresh session
   (~55k tokens) in the over-budget band or past it; and refuses to run inside a Claude Code Bash
   sandbox.
2. **One session per wave.** While the state is at `stage: execution` it starts
   `claude -p "/devcycle:continue --drive .devcycle/state.md"` with `--model <id>`,
   `--permission-mode auto`, `--output-format stream-json` and `--verbose` (plus
   `--max-budget-usd` when you set `--max-usd`), with `DEVCYCLE_NESTED_RUN` removed from the
   session's environment so devcycle's hooks module stays active, and this run's token in
   `DEVCYCLE_DRIVE_TOKEN`. The session resumes from the files
   under `.devcycle/`, runs the wave, emits its handoff and ends — ending a print-mode session is the
   clear.
3. **One record per session.** As each session ends the driver appends a `drive` row to the cycle's
   run record: ledger and commit counts before and after, cost, last context depth, guard denials,
   and why the session ended. `/devcycle:doctor` reports driven and manual runs as separate cohorts.
4. **The safety valve.** A driven session whose context reaches the hard-stop band — or whose
   depth probe loses the session for two task scripts in a row — finishes its in-flight tasks, dispatches nothing new, and ends with the handoff label
   `Session ended mid-wave: <k> of <n> tasks done (stage: execution)`; the driver starts the next
   session and the wave resumes where it stopped.

## What it will not do

- **Answer anything for you.** Every question a session would ask becomes a stop: the session writes
  `.devcycle/drive-stop.json` and the driver exits 4, printing the reason and a one-line detail.
  The reasons are `needs-user` (the catch-all: exhausted review rounds, a blocked implementer, a
  retry cap, any gate not named here), `knob-drift`, `foreign-state`, `resume-check`, `branch`,
  `depth-at-start`, `sweep-fallback`, `scope-change`, `no-driver` and `not-opted-in`.
- **Go past execution.** It ends at the branch-review handoff (exit 0); branch review, on-device
  verification and finish stay with you.
- **Answer to a hand-typed `--drive`.** `/devcycle:continue --drive` acts only in a session that
  carries the running driver's token. Typed by hand it stops `no-driver` and changes nothing, even
  while a driver runs.
- **Share the checkout** — see the next section.
- **Run on Windows**, or on a model whose window cannot hold a session start —
  [`docs/known-issues.md`](../../known-issues.md) has both.

## Hands off the working tree while it runs

The driver commits as it goes, on the recorded topic branch. Do not switch branches, edit tracked
files or commit in that checkout until it exits. While its lock is live, devcycle's git guard
denies branch-moving and tree-destroying git (`switch`, `checkout` other than
`checkout -- <paths>`, `reset --hard`, `clean -f`) on the main thread of every Claude Code session
in that checkout, and a manual `/devcycle:continue` refuses to resume and names the running driver.
Your own terminal is not guarded. To work on something else meanwhile, use another worktree.

## Watching and stopping it

- **Watch:** `tail -f .devcycle/drive.log` — a line when each session starts and ends, and one per
  ledger event (dispatches, reviews, commits) as it lands.
- **Stop:** `kill <PID>` (the PID the planning session printed; it is also in
  `.devcycle/drive.lock`), or Ctrl-C when it runs in your terminal. The driver stops the running
  session's whole process group, writes that session's record, releases the lock and exits 130. A
  `kill -9` leaves the lock behind; the next driver reclaims it.
- **Pick it up yourself** after any stop: run `/devcycle:continue` in a fresh session, which asks
  you the question the driver could not, or start the driver again once the cause is cleared.

## Options

| Flag | Default | What it does |
| --- | --- | --- |
| `--state <path>` | required | The cycle's `.devcycle/state.md`. |
| `--model <id>` | the `drive:` row's model | Runs every session on this model instead. |
| `--max-usd <n>` | none | Total dollar cap across sessions; each session gets the remainder as `--max-budget-usd`. On a subscription plan the cost is an estimate. |
| `--max-stalls <n>` | 2 | Consecutive sessions that add no ledger line before the driver gives up (exit 5). |
| `--max-churn <n>` | 3 | Consecutive sessions that add ledger lines but no report, verdict or commit before the driver gives up (exit 5). |
| `--max-backoff <minutes>` | 360 | Total time it waits out usage limits before giving up (exit 6). |
| `--detach` | off | Runs the pre-flight, then restarts the driver as a new session's leader writing to `.devcycle/drive.log`, prints `{"pid":<n>,"log":".devcycle/drive.log"}` and returns; closing the terminal does not stop it. |
| `--dry-run` | off | Runs the pre-flight and prints the session command; starts nothing and takes no lock. |
| `--check-sandbox` | off | Prints `{"sandboxed":false}` (or `true`) and exits — the planning gate asks this before offering to start it. |
| `--claude <bin>` | `claude` | The CLI to run; tests point it at a stub. |

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Done: the state reached `branch-review`. Run `/clear`, then `/devcycle:continue` for branch review. |
| 1 | Unexpected driver error, or the state left execution for a stage other than branch review. |
| 2 | Usage error: an unknown flag, a missing `--state`, a malformed number. |
| 3 | Environment: a pre-flight check failed — among them no resolvable default branch, or a start from inside a Claude Code session after the opt-in was used —, another driver holds the lock, or devcycle did not load in a session. The message names the check. |
| 4 | Stopped for you: a session reached a gate. The reason and its detail are printed. |
| 5 | Stalled: `--max-stalls` sessions in a row added no ledger line, or `--max-churn` sessions in a row added lines but no report, verdict or commit. The last session's final text is printed — usually the question it could not ask. |
| 6 | Budget: `--max-usd` is spent, or a usage limit would outlast `--max-backoff`. |
| 130 | Interrupted: the running session was stopped, its record written and the lock released. |
