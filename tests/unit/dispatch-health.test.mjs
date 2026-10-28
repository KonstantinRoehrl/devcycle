// scripts/dispatch-health.mjs owns the dispatch-ended ledger event: one line per dead dispatch, a cap
// of one redispatch per role per task, and the round a reviewer death leaves open.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { nextReviewRound, parseLedgerLine, taskEntries } from "../../scripts/task-ledger.mjs";
import { DEATH_CAP, DISPATCH_ENDED, deathRoute, deathsOf, endedOutcome, endedRole, recordDeath } from "../../scripts/dispatch-health.mjs";
import { writeInto } from "./helpers.mjs";

const PREAMBLE = "Plan: `docs/plan.md`\n\n";
const line = (text) => `- [2026-10-28T08:00:00Z] ${text}\n`;
function ledger(lines = []) {
  const root = makeTempDir("dispatch-health-ledger-");
  writeInto(root, ".devcycle/ledger.md", PREAMBLE + lines.map(line).join(""));
  return join(root, ".devcycle/ledger.md");
}
const ended = (path) => readFileSync(path, "utf8").split("\n").filter((l) => l.includes(`event=${DISPATCH_ENDED}`));

test("the outcome names the role, and only a dispatch-ended outcome reads back as one", () => {
  assert.equal(endedOutcome("implementer"), "without output (implementer)");
  assert.equal(endedRole("without output (reviewer)"), "reviewer");
  assert.equal(endedRole("rejected (missing report file)"), null);
});

test("a death is one line keyed to the dead dispatch's round, and recording it again appends nothing", () => {
  const path = ledger(["task=5 event=dispatched outcome=model x ref=.devcycle/briefs/5-implementer.md key=5/dispatched/0/0"]);
  const first = recordDeath({ ledgerPath: path, task: "5", role: "implementer", round: 0, recordPath: ".devcycle/dispatch/5-implementer-0-0.json" });
  assert.equal(first.next, "redispatch-implementer");
  const again = recordDeath({ ledgerPath: path, task: "5", role: "implementer", round: 0, recordPath: ".devcycle/dispatch/5-implementer-0-0.json" });
  assert.equal(again.next, "redispatch-implementer");
  const lines = ended(path);
  assert.equal(lines.length, 1);
  assert.match(lines[0], / task=5 event=dispatch-ended outcome=without output \(implementer\) ref=\.devcycle\/dispatch\/5-implementer-0-0\.json key=5\/dispatch-ended\/0\/0$/);
});

test("a second death of the same role is the user's; a death of the other role is counted apart", () => {
  const path = ledger();
  recordDeath({ ledgerPath: path, task: "5", role: "implementer", round: 0, recordPath: ".devcycle/dispatch/5-implementer-0-0.json" });
  assert.equal(recordDeath({ ledgerPath: path, task: "5", role: "reviewer", round: 1, recordPath: ".devcycle/dispatch/5-reviewer-1-0.json" }).next, "redispatch-reviewer");
  assert.equal(recordDeath({ ledgerPath: path, task: "5", role: "implementer", round: 0, recordPath: ".devcycle/dispatch/5-implementer-0-1.json" }).next, "needs-user");
  const entries = taskEntries(path, "5");
  assert.deepEqual([deathsOf(entries, "implementer"), deathsOf(entries, "reviewer"), DEATH_CAP], [2, 1, 1]);
  assert.equal(deathRoute(entries, "nobody"), "needs-user");
});

test("a reviewer death leaves its round open, so the redispatch reviews the same round", () => {
  const entries = [
    "task=5 event=review-round outcome=round 2 ref=.devcycle/briefs/5-reviewer-round-2.md key=5/review-round/2/1",
    "task=5 event=dispatch-ended outcome=without output (reviewer) ref=.devcycle/dispatch/5-reviewer-2-1.json key=5/dispatch-ended/2/0",
  ].map((l) => parseLedgerLine(line(l).trim()));
  assert.equal(nextReviewRound(entries), 2);
});
