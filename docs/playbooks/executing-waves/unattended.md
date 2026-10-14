# Running execution unattended

devcycle normally stops after every wave of the execution stage and waits for you to run `/clear`
and `/devcycle:continue`. Unattended execution hands those wave-to-wave stops — and nothing else —
to a driver, `scripts/drive-execution.mjs`: it gives each wave the same fresh session a manual
clear would, and it stops at the first thing that needs you. The decision behind it is recorded in
[`docs/decisions/`](../../decisions/README.md) (2026-10-13 — Unattended execution: chosen at
execution start, started by /devcycle:continue).

## Opting in, at execution start

Planning always ends with `Clear + /devcycle:continue`. When that `/devcycle:continue` resumes at
`stage: execution`, it asks one question — how execution should run:

- **Unattended** — the session records `- drive: auto model=<id> opted=<stamp> via=answer` in
  `.devcycle/state.md` (the model it runs on, as the depth probe reads it), starts the driver and
  watches it.
- **Walk the waves manually** — it records `- drive: manual chosen=<stamp> via=answer` and walks
  the waves in that session, as before.

The `executionMode` setting answers for you: `ask` (the default) asks, `unattended` opts every
cycle in and `manual` walks every cycle, each recorded with `via=knob`. Once a cycle has its
`drive:` row, the row decides and a changed setting does not. Only your answer or your setting opts
a cycle in; no agent opts in, answers a gate for you, or starts a driver outside
`/devcycle:continue`.

## What /devcycle:continue does

With a cycle opted in, every `/devcycle:continue` at execution start does one of these:

- **Start.** It settles the topic branch, archives a previous cycle's leftover ledger and per-task
  files (`.devcycle/archive-<date>-<branch>/`; a file already archived byte for byte is removed
  instead), starts the driver with `--detach`, and prints an overview — `<W> waves · <T> tasks ·
  <C> committed — next: wave <w>`, then each wave's tasks. Inside Claude Code's Bash sandbox the
  start runs outside it, through one permission prompt; refused, you get the command for a terminal
  that is not a Claude Code session, or the manual walk.
- **Watch.** It follows the run under `Monitor` and relays one line per session start, commit,
  review verdict, user decision, intake bounce, finished wave, wait and stop, and waits for the end
  in a background task. The session edits nothing while the driver runs. Ask it to stop the run and
  it runs `--stop`.
- **Attach.** Run `/devcycle:continue` while a driver is running and it attaches: overview and
  watch, nothing else — no other gate is acted on beside a running driver.
- **Restart.** A run that ended resumably — interrupted, crashed, a driver error, transient
  failures past `--max-backoff` — is restarted without a question. Two such ends in a row with no
  progress become a question instead, so a run that fails the same way never loops.
- **Ask.** A run that stopped for you — a gate, a stall, an environment failure, the dollar cap, or
  your own `--stop` — becomes one question, its first option the matching restart
  (**Restart unattended**, or **Resume unattended** after a `--stop`), and always **Walk the waves
  manually** and **Leave it stopped**.
- **Hand off.** When the run reaches branch review it emits the execution → branch-review handoff:
  `/clear`, then `/devcycle:continue`.

The watch costs turns on your account like any session. If a usage limit leaves it unarmed, the
driver runs on; your next `/devcycle:continue` attaches or picks up the end.

## What the driver does

1. **Pre-flight, fail closed** (exit 3 on any failure). It requires the `drive: auto` row, `stage: execution` and
   a run id; it refuses a start from a driven session (`DEVCYCLE_DRIVE_TOKEN` set); it requires the
   checkout to be on the state's recorded branch, a resolvable default branch, and the recorded
   branch to be neither the default branch nor an integration branch; it refuses a tracked change
   to a file a task neither in flight nor committed will write, listing every such path with its
   task (`commit, stash or revert it — task <n> writes this file`), and logs the tracked changes no
   remaining task writes as left alone (untracked files and `.devcycle/` are ignored, and a crashed
   session's edits in an in-flight task's files are admitted); it refuses a model whose context
   window is unknown or would put a fresh session (~55k tokens) in the over-budget band or past it;
   and it refuses to run inside a Claude Code Bash sandbox. Every refusal names its remedy. Only
   then does it take the lock `.devcycle/drive.lock` (pid, process start time, host, hashes of the
   machine's id and of its boot, on Linux the pid namespace and the start in clock ticks since boot,
   state path, and the hash of a token it makes for this run), reclaiming one whose process is gone
   or whose pid now belongs to a different process, and, holding it, rename an unhandled
   `.devcycle/drive-result.json` to `.devcycle/drive-result.handled.json` and remove a leftover stop
   request. A refused start, like `--dry-run`, leaves both where they are.
2. **One session per wave.** While the state is at `stage: execution` it starts
   `claude -p "/devcycle:continue --drive .devcycle/state.md"` with `--model <id>`,
   `--permission-mode auto`, `--output-format stream-json` and `--verbose` (plus
   `--max-budget-usd` when you set `--max-usd`), with `DEVCYCLE_NESTED_RUN` and `CLAUDECODE` removed
   from the session's environment so devcycle's hooks module stays active, and this run's token in
   `DEVCYCLE_DRIVE_TOKEN`. The session resumes from the files
   under `.devcycle/`, runs the wave, emits its handoff and ends — ending a print-mode session is the
   clear.
3. **One record per session.** As each session ends the driver appends a `drive` row to the cycle's
   run record: ledger and commit counts before and after, cost, last context depth, guard denials,
   and why the session ended. `/devcycle:doctor` reports driven and manual runs as separate cohorts.
   A session that ends without reporting its cost — killed, or crashed — records none; toward
   `--max-usd` it is charged an estimate: the requests it and its subagents made, read from the
   stream and from the transcripts Claude Code keeps under `~/.claude/projects/`
   (`$CLAUDE_CONFIG_DIR/projects/` when that is set), each request's output counted as no less than
   half the characters it streamed or wrote to its transcript — a subagent's transcript records its
   output count from before the request generated anything.
4. **The safety valve.** A driven session whose context reaches the hard-stop band — or whose
   depth probe loses the session for two task scripts in a row — finishes its in-flight tasks, dispatches nothing new, and ends with the handoff label
   `Session ended mid-wave: <k> of <n> tasks done (stage: execution)`; the driver starts the next
   session and the wave resumes where it stopped.
5. **One result per run.** Holding the lock, the driver writes `.devcycle/drive-result.json` as a
   crash (`crashed`) when the run starts and again once it makes progress, and replaces it before it
   releases the lock with its exit code, the outcome (`complete`, `left-execution`, `failed`,
   `environment`, `gate-stop`, `stalled`, `budget`, `stopped`, `interrupted`), the stop's reason,
   task and detail, whether the run made progress, and how many resumable ends in a row made none.
   `/devcycle:continue` decides from it whether to restart, ask, or hand off. A driver killed
   outright leaves its `crashed` result, and a lock naming a dead pid with no result reads the same:
   a crash counts toward the no-progress bound like any resumable end.

## Usage limits, failures and silent sessions

- **A usage limit with a known reset** (a rejected rate-limit event's reset time, or the reset in
  the result text) is waited out to that time plus a minute, however long. It is no stall and is
  not charged to `--max-backoff`.
- **A transient failure** — a usage limit with no reset time, an API error with a 5xx, 408 or 429
  status or none, an overload, connection or timeout error, or a session that ended with no result and no new ledger line — backs off 1, 2,
  4, 8 and 16 minutes, then 30 per further attempt. It is no stall, and its waiting is charged to
  `--max-backoff`; the charge resets once a session makes progress. Running out ends the run
  (exit 6), and `/devcycle:continue` restarts it.
- **An authentication failure** (a result asking you to log in, an invalid key) ends the run at
  once (exit 3).
- **An API error every session would hit** — a low credit balance, an unknown model, a key without
  access (a 401, 403 or 404) — ends the run at once (exit 3), naming the error; retrying would fail
  the same way.
- **An API error one session's own conversation caused** — any other 4xx, such as a 400 over its
  tool-use blocks or a 413 for a request grown too large — ends only that session. The next starts
  at once, fresh, and the ended one counts as a stall unless it made progress.
- **A silent session.** A session that prints nothing for 30 minutes is stopped. If it had already
  printed its result, that is only a slow exit and the session is judged like any other. If not,
  the driver waits 5 minutes, charged to `--max-backoff` like a transient failure, and judges its
  ledger lines as it would an ended session's — a subagent can work silently for longer than 30
  minutes: no line beyond a dispatch (an implementer's `dispatched`, a reviewer's `review-round`)
  counts as a stall, and such lines but no report, verdict or commit count as churn.
  `--max-stalls` or `--max-churn` such sessions in a row end the run (exit 5).

Every wait is a wall-clock deadline checked at least once a minute, so a machine that sleeps
through it starts the next session on waking. A spent `--max-usd` ends the run (exit 6) before any
wait.

## What it will not do

- **Answer anything for you.** Every question a session would ask becomes a stop: the session writes
  `.devcycle/drive-stop.json` (with the task, when one task is waiting on you) and the driver
  exits 4, printing the reason and a one-line detail.
  The reasons are `needs-user` (the catch-all: exhausted review rounds, a blocked implementer, a
  retry cap, any gate not named here), `knob-drift`, `foreign-state`, `resume-check`, `branch`,
  `depth-at-start`, `sweep-fallback`, `scope-change`, `no-driver` and `not-opted-in`.
- **Go past execution.** It ends at the branch-review handoff (exit 0); branch review, on-device
  verification and finish stay with you.
- **Start itself from a driven session.** A session the driver started never starts another
  driver; only `/devcycle:continue`'s start path does.
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
`checkout -- <paths>`, `reset --hard`, a `clean` that is not a dry run) on the main thread of every
Claude Code session in that checkout, including one sent back to it with `--git-dir`,
`--work-tree`, `GIT_DIR` or `GIT_WORK_TREE`, any git whose subcommand it cannot read (a
substitution, a variable or `xargs git` supplies it), and a `reset` or `clean` whose options it
cannot read (`git reset $OPTS`); a `/devcycle:continue` attaches to the running driver and
changes nothing.
Your own terminal is not guarded. To work on something else meanwhile, use another worktree.

## Watching and stopping it

- **Watch:** the `/devcycle:continue` session that started or attached to the driver relays its
  progress. From anywhere, `node <plugin root>/scripts/drive-execution.mjs --status --state
  .devcycle/state.md` prints whether it runs, how its last run ended and the log's last 40 lines;
  `--follow` streams the reported lines, and `tail -f .devcycle/drive.log` shows everything.
- **Stop:** ask the watching session to stop it, or run
  `node <plugin root>/scripts/drive-execution.mjs --stop --state .devcycle/state.md`. The driver
  stops the running session's whole process group, writes that session's record and its result
  (`stopped`), releases the lock and exits 130; `/devcycle:continue` asks before resuming it. A
  driver another user or a sandbox started may refuse the signal, and where `ps` cannot run to
  confirm the pid is still the driver's, `--stop` sends none: either way it leaves the request on
  disk and exits 1, and the driver stops before its next session or within a minute of a wait. A
  bare `kill <PID>` or Ctrl-C still works and records `interrupted`, which the next
  `/devcycle:continue` restarts without asking. A `kill -9`, crash or reboot leaves the lock
  behind; it reads as a crash and is restarted, and the next driver on the same machine reclaims
  the lock, even when the host's name changed meanwhile. A lock the driver cannot check is never
  reclaimed — one written on another machine, in another container (another pid namespace), or by
  a cloned machine sharing this one's id whose driver started after this machine last booted: the
  refusal names its pid and `.devcycle/drive.lock`, which you remove once you know that driver is
  gone ([`docs/known-issues.md`](../../known-issues.md) has the cases this misjudges).

## Options

| Flag | Default | What it does |
| --- | --- | --- |
| `--state <path>` | required | The cycle's `.devcycle/state.md`. |
| `--model <id>` | the `drive:` row's model | Runs every session on this model instead. |
| `--max-usd <n>` | none | Total dollar cap across sessions; each session gets the remainder as `--max-budget-usd`. On a subscription plan the cost is an estimate; a session that reports no cost is charged one priced from its streamed usage and its transcripts. |
| `--max-stalls <n>` | 2 | Consecutive sessions that add no ledger line beyond a dispatch before the driver gives up (exit 5). |
| `--max-churn <n>` | 3 | Consecutive sessions that add ledger lines beyond a dispatch but no report, verdict or commit before the driver gives up (exit 5). |
| `--max-backoff <minutes>` | 360 | Total time it backs off from transient failures and silent sessions before giving up (exit 6). A usage limit with a known reset is not charged. |
| `--detach` | off | Runs the pre-flight, starts the driver as a new session's leader writing to `.devcycle/drive.log`, and returns once the driver holds its lock — however long that takes — printing `{"pid":<n>,"log":".devcycle/drive.log","logOffset":<n>}`; a driver that refuses instead has its message relayed and its exit code returned. Closing the terminal does not stop it. |
| `--stop` | off | With `--state`: asks the running driver to stop (exit 130, result `stopped`) and prints `{"stopped":true,"pid":<n>}`; exits 3 when no driver runs for that state, and 1 when the driver cannot be signalled, leaving the request for it to find. |
| `--status` | off | With `--state`: prints the run's state as JSON — running, the last run's outcome and its next step — with the log's last 40 lines. |
| `--follow` | off | With `--state`: prints one line per reported event (session start, commit, review verdict, user decision, intake bounce, finished wave, wait, stop), each ending ` @<offset>`, and a `drive ended: …` line when the driver stops. `--since <bytes>` resumes from an offset. |
| `--wait` | off | With `--state`: blocks until no driver runs, then prints `--status`. |
| `--mark-handled` | off | With `--state`: renames `.devcycle/drive-result.json` to `.devcycle/drive-result.handled.json` and prints `{"handled":<true|false>}` — `/devcycle:continue` runs it once it has acted on a run's end without starting a driver. |
| `--dry-run` | off | Runs the pre-flight and prints the session command; starts nothing, takes no lock, and leaves the last run's result and any stop request as they are. |
| `--check-sandbox` | off | Prints `{"sandboxed":<true|false>}` and exits — `/devcycle:continue` asks this before starting the driver. |
| `--claude <bin>` | `claude` | The CLI to run; tests point it at a stub. |

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Done: the state reached `branch-review`. `/devcycle:continue` emits the branch-review handoff. |
| 1 | Unexpected driver error, or the state left execution for a stage other than branch review. `--stop` exits 1 when the driver cannot be signalled, or `ps` cannot confirm the pid is still the driver's. |
| 2 | Usage error: an unknown flag, a missing `--state`, a malformed number. |
| 3 | Environment: a pre-flight check failed — among them no `drive: auto` row, a start from a driven session, the Bash sandbox, or tracked changes a remaining task would overwrite —, another driver holds the lock, devcycle did not load in a session (another plugin's load errors do not count), authentication failed, or the API refused a request every session would make (a low credit balance, an unknown model, a key without access). The message names the check and its remedy. `--stop` exits 3 when no driver runs. |
| 4 | Stopped for you: a session reached a gate. The reason and its detail are printed. |
| 5 | Stalled: `--max-stalls` sessions in a row added no ledger line beyond a dispatch, or `--max-churn` sessions in a row added such lines but no report, verdict or commit — whether each ended or went silent. The last session's final text is printed — usually the question it could not ask. |
| 6 | Budget: `--max-usd` is spent, or transient failures or silent sessions outlasted `--max-backoff`. |
| 130 | Stopped (`--stop`) or interrupted (a signal): the running session was stopped, its record and the result written and the lock released. |
