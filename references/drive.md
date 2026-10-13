# Drive — what /devcycle:continue does with unattended execution

`commands/continue.md` § Execution resume reads this file one section at a time, at `stage:
execution` only. `scripts/wave-setup.mjs` decides the drive action and `scripts/drive-execution.mjs`
runs the driver; this file holds what the session does with each action, the two forms of the
state file's `drive:` row and who writes them. The authority rules are the decision log's
(`docs/decisions/README.md`, 2026-10-13 — Unattended execution: chosen at execution start, started
by /devcycle:continue).

An Other answer to any question in this file appends `user-correction-at-gate` to the cycle's run
record; `references/ledger.md` owns the rule.

## Drive actions

With `drive.action: "attach"`, `wave-setup.mjs` computed no other gate: append this session's row
as § Execution resume says and act on nothing else beside the running driver. With any other
action, answer the gates § Execution resume names first — knob drift, the branch verdict, the
depth band, `pendingDecision` — then act on `drive.action`:

| `drive.action` | What this session does |
| --- | --- |
| `attach` | A driver is running this cycle (`drive.lock` names its pid and log). Run steps 5–7 of the start path, with `--follow` given no `--since`, so it starts at the log's current end. |
| `ask` | One AskUserQuestion — how execution runs: **Unattended** · **Walk the waves manually**. Write the row from the answer with `via=answer`, then act as `start` or `manual`. |
| `start` | Write an `auto` row with `via=knob` when `drive.writeRow` is `auto`, then run the start path, asking nothing. |
| `gate` | The last run stopped for a person: ask the stopped run's question, then run the start path unless the answer left unattended. |
| `manual` | Write a `manual` row with `via=knob` when `drive.writeRow` is `manual`, then walk the waves in this session: the rest of § Execution resume, as without a driver. |
| `none` | A driven session (`--drive`): `commands/continue.md` § Drive mode governs, and nothing here applies. |

The start path is `node "${CLAUDE_PLUGIN_ROOT}/scripts/read-section.mjs" references/drive.md the-start-path`
and the stopped run's question
`node "${CLAUDE_PLUGIN_ROOT}/scripts/read-section.mjs" references/drive.md answering-a-stopped-run`;
load each only when its action needs it.

**The `drive:` row.** It takes exactly one of two forms:

- `- drive: auto model=<id> opted=<stamp> via=<answer|knob>` — the waves run unattended;
- `- drive: manual chosen=<stamp> via=<answer|knob>` — they are walked in an interactive session.

`<id>` is the `model` that `node "${CLAUDE_PLUGIN_ROOT}/scripts/depth-probe.mjs" --json` prints,
never self-report, and `<stamp>` is `node "${CLAUDE_PLUGIN_ROOT}/scripts/stamp.mjs" now`. `via=answer`
records the user's answer, `via=knob` the `executionMode` knob through `drive.writeRow`. Only the
actions above write the row — `ask`, `start` and `manual` — and **Walk the waves manually** at a
stopped run or a refused start, which rewrites an `auto` row to `manual`. Write it by rewriting the
state file in full with the row added; every other rewrite carries it forward
(`references/resume.md` § The state file). A row outranks the knob: once it exists, a changed
`executionMode` no longer decides.

## Answering a stopped run

`drive.gate` carries the stop's `reason`, `detail`, `task`, `settled` and `pendingDecision` (the
top-level one then null), and `drive.result` the run's classified end. Ask ONE AskUserQuestion, its options per reason below. Every option set also
offers **Walk the waves manually**, which rewrites the row to `manual` as § Drive actions says and
walks the waves in this session, and **Leave it stopped**, which ends the session with the result
left unhandled, so the next `/devcycle:continue` asks again. An Other answer is recorded like
any answer below.

| reason | The question, and how its answer is recorded |
| --- | --- |
| `drive.gate.settled` true: `knob-drift`, `foreign-state`, `resume-check`, `branch`, `depth-at-start`, `no-driver`, `not-opted-in` | No question of its own: this session's own gates have just been computed and answered, so the stop is settled. Run the start path. |
| `needs-user` with `drive.gate.pendingDecision` set | The `pendingDecision` question of § Execution resume, asked once; record `task=<n> event=user-decision outcome=task-<n>-review: <answer>`, the line `references/resume.md` § Resuming a wave's per-task position reads as settling it. |
| `needs-user` or `sweep-fallback`, `task` set otherwise — a blocked implementer, a retry cap, a refused commit, a human-required step, a sweep fallback | The stop's `detail` as the question; record `task=<n> event=user-decision outcome=<answer>`. |
| `needs-user` or `sweep-fallback` with no `task` | The stop's `detail` as the question; record `task=drive event=user-decision outcome=<answer>`. |
| `scope-change` | The stop's `detail` as the question: whether the cycle goes back to brainstorm or planning. The answer rewrites `stage:` to that stage, so no driver starts; continue there as § Resume says. |
| `stopped` | **Resume unattended** first. The user stopped the run with `--stop`; it never restarts unasked. |
| `stalled`, `no-progress`, `environment`, `max-usd` | The stop's `detail` — for `stalled` the last session's text, for `no-progress` that two restarts in a row added no ledger line beyond a dispatch — with **Restart unattended** first. |

Append each record as one ledger line, `- [<stamp>] <the record above> ref=.devcycle/state.md`, in
the shape `node "${CLAUDE_PLUGIN_ROOT}/scripts/read-section.mjs" references/ledger.md the-event-line`
prints. **Resume unattended**, **Restart unattended**, a settled stop and an answered `needs-user`
or `sweep-fallback` then run the start path, whose `--detach` marks the result handled. Every other
answer but **Leave it stopped** — **Walk the waves manually**, the `scope-change` answer — marks it
handled itself:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/drive-execution.mjs" --mark-handled --state .devcycle/state.md`.

## The start path

In this order, never dispatching a task from this session:

1. **Settle the branch.** On the default or an integration branch, cut the topic branch and
   record it on `branch:` as `references/branch.md` § Committing requires, so the driver's
   pre-flight finds it.
2. **Reset a stale ledger slot.** When `wave-setup.mjs` reported `ledgerSlot: "stale"`, run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger-slot.mjs" --state .devcycle/state.md --reset` and
   name the archive it prints.
3. **Start the driver.** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/drive-execution.mjs" --check-sandbox`
   first. When it prints `{"sandboxed":true}`, run the start below outside the sandbox through the
   Bash tool's sandbox override, which asks the user to approve it. The start:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/drive-execution.mjs" --state .devcycle/state.md --detach`.
   - It prints `{"pid":<n>,"log":".devcycle/drive.log","logOffset":<n>}` once the driver holds
     its lock: keep `logOffset`.
   - The approval is refused or the override unavailable: print
     `node "<plugin root>/scripts/drive-execution.mjs" --state "<absolute state path>" --detach`
     for a terminal that is not a Claude Code session, and offer **Walk the waves manually**; on
     that answer, run `--mark-handled` as § Answering a stopped run says before walking.
   - Exit 3 is a refusal: report its message, which names the remedy, and stop. The row stays, so
     the next `/devcycle:continue` retries. Any other non-zero exit: report its message and stop.
4. **Mark the previous result handled.** `--detach` has already renamed
   `.devcycle/drive-result.json` to `.devcycle/drive-result.handled.json`; run nothing.
5. **Print the overview** from `wave-setup.mjs`'s `overview`:
   `<W> waves · <T> tasks · <C> committed — next: wave <w>`, then one line per wave,
   `wave <w>: tasks <ids> (<c>/<n> committed)`.
6. **Arm the watches.** Progress:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/drive-execution.mjs" --follow --state .devcycle/state.md --since <logOffset>`
   under `Monitor` with its maximum timeout. Relay each line it prints to the user as one line,
   without its ` @<offset>` tail; a `wait:` line names when the run resumes, and is relayed once.
   On each expiry, re-arm it with `--since` set to the last line's `@<offset>`. The end:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/drive-execution.mjs" --wait --state .devcycle/state.md`
   as a background Bash task; when it returns, follow
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/read-section.mjs" references/drive.md when-the-run-ends`.
   Where neither tool exists, print `tail -f .devcycle/drive.log` and that Ctrl-C stops watching,
   never the driver.
7. **Stand down.** Edit no file, commit nothing, walk no wave. When the user asks to stop the run,
   run `node "${CLAUDE_PLUGIN_ROOT}/scripts/drive-execution.mjs" --stop --state .devcycle/state.md`:
   the run ends `stopped`, which no `/devcycle:continue` restarts unasked.

## When the run ends

When the `--wait` task returns, stop the follow monitor and act on the `next` its JSON carries:

- `branch-review` — the run is complete. Read `${CLAUDE_PLUGIN_ROOT}/references/handoff.md` and
  emit its execution → branch-review block.
- `resume-stage` — the run left execution: emit the handoff into the stage the state file names.
- any other — rerun `wave-setup.mjs` as § Execution resume runs it and act on its new
  `drive.action`: a resumable end restarts through the start path, asking nothing, and a stop for
  a person is a `gate`. After a `--stop` this session ran, report the stop and end instead; the
  next `/devcycle:continue` asks.

**The watcher shares the account's limits.** Every `Monitor` expiry and every relayed line is a
turn. A turn the usage limit rejects can leave the follow unarmed or the `--wait` notification
unhandled; the driver runs on unaffected, and the user's next `/devcycle:continue` — `attach`
while it runs, the end's action after — picks the run back up. A long wait for a usage-limit
reset is reported once, with its resume time, and never polled.
