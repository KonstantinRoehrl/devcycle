# Bounded loops — cap, exhaustion, and how each outcome is reported

The single owner of what every bounded loop in devcycle does when it runs out of rounds. A
playbook, command, or agent that runs a loop names this file and does not restate it.

## Every loop declares three things

1. **Cap** — the maximum number of rounds, as a number, in the loop's own text.
2. **What one round is** — the unit that is counted.
3. **Exit status** — one of the three below, written to a file, never held in context only.

## The three exit statuses

- `resolved` — the loop's goal was met inside the cap. The only status that may be reported
  as a pass.
- `exhausted-with-residue` — the cap was reached and the remaining items were **deliberately
  carried over** to a named destination (an issue, a register row, a follow-up cycle). Not a
  failure. The report names the destination and the count carried.
- `exhausted-unresolved` — the cap was reached with nothing carrying the residue. Always
  surfaced to the user as a decision point, never rendered as a pass.

**Exhaustion is never rendered as a pass, and never as a failure when residue was deliberately
carried over.** A report that says "cap reached" without one of the three statuses is
malformed.

## Where the status lives

`.devcycle/findings/<loop-id>-status.md`, one line:

    status: <resolved|exhausted-with-residue|exhausted-unresolved> rounds: <n>/<cap> residue: <count or none> carried-to: <destination or none>

File-based, so a `/clear` between the loop and the reader cannot erase it.

## Stale statuses are archived, never left in place

When a loop re-runs and reaches a new status, the previous status file moves to
`.devcycle/archive-<date>-<loop-id>/` before the new one is written. A directory holding two
contradicting verdicts for the same loop is the defect this rule exists to prevent.
