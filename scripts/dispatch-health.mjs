// A dispatched subagent's health, read from files only, so the coordinator, the driver's watchdog and
// the drive band can tell a dispatch that is working from one that ended without its report or
// findings file. This module is the one writer of the `dispatch-ended` ledger event and the owner
// of its cap (references/resume.md § Resuming a wave's per-task position, **Retry caps**).
import { appendLedgerLine, nextRetry, taskEntries } from "./task-ledger.mjs";

export const DISPATCH_ENDED = "dispatch-ended";
// One redispatch per role per task, counted across sessions: a second death of the same role on the
// same task is systematic, so it is the user's to decide.
export const DEATH_CAP = 1;
const ROLES = new Set(["implementer", "reviewer"]);

export const endedOutcome = (role) => `without output (${role})`;
export const endedRole = (outcome) => outcome.match(/^without output \((implementer|reviewer)\)$/)?.[1] ?? null;

// Counted by event and role, never by outcome prefix, so the missing-report and intake-bounce caps
// stay apart from this one.
export const deathsOf = (entries, role) =>
  entries.filter((e) => e.event === DISPATCH_ENDED && endedRole(e.outcome) === role).length;

export function deathRoute(entries, role) {
  if (!ROLES.has(role) || deathsOf(entries, role) > DEATH_CAP) return "needs-user";
  return `redispatch-${role}`;
}

// The line's ref is the dead dispatch's record, so a second writer — the driver's watchdog beside the
// session's own check — finds it and appends nothing; two racing writers compute the same retry, and
// appendLedgerLine keeps one line per key.
export function recordDeath({ ledgerPath, task, role, round, recordPath }) {
  if (!ROLES.has(role)) throw new Error(`a dispatch-ended role is implementer or reviewer, got "${role}"`);
  if (!taskEntries(ledgerPath, task).some((e) => e.event === DISPATCH_ENDED && e.ref === recordPath))
    appendLedgerLine(ledgerPath, {
      task, event: DISPATCH_ENDED, outcome: endedOutcome(role), ref: recordPath, round, retry: nextRetry(ledgerPath, task, DISPATCH_ENDED),
    });
  return { next: deathRoute(taskEntries(ledgerPath, task), role) };
}
