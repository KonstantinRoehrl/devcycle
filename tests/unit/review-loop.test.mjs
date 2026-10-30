// The task review loop's shared pieces, now owned by scripts/review-loop.mjs: the round cap, the loop
// id, the exhausted-unresolved status file and the read that holds a task for the user's decision.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { parseLedgerLine } from "../../scripts/task-ledger.mjs";
import { ROUND_CAP, exhaustReviewLoop, pendingReviewLoop, reviewLoopId } from "../../scripts/review-loop.mjs";
import { writeInto } from "./helpers.mjs";

const STATUS = "status: exhausted-unresolved rounds: 3/3 residue: 2 carried-to: none\n";
const entry = (event, outcome, key) =>
  parseLedgerLine(`- [2026-10-25T10:00:00Z] task=4 event=${event} outcome=${outcome} ref=none key=${key}`);
const rejectedRound3 = entry("review-verdict", "rejected", "4/review-verdict/3/0");
const UNPARSEABLE = "rejected (unparseable findings file: no verdict line)";

test("the review loop's id and round cap", () => {
  assert.equal(ROUND_CAP, 3);
  assert.equal(reviewLoopId("4"), "task-4-review");
});

test("exhaustReviewLoop writes the exhausted-unresolved status and returns the loop id", () => {
  const root = makeTempDir("review-loop-");
  try {
    assert.equal(exhaustReviewLoop(root, "4", 3, 2), "task-4-review");
    assert.equal(readFileSync(join(root, ".devcycle/findings/task-4-review-status.md"), "utf8"), STATUS);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pendingReviewLoop holds the task only for an exhaustion this ledger holds and no decision follows", () => {
  const root = makeTempDir("review-loop-");
  try {
    assert.equal(pendingReviewLoop(root, "4", [rejectedRound3]), null, "no status file");
    writeInto(root, ".devcycle/findings/task-4-review-status.md", STATUS);
    assert.equal(pendingReviewLoop(root, "4", [rejectedRound3]), "task-4-review");
    assert.equal(pendingReviewLoop(root, "4", []), null, "an earlier cycle's status file with no exhaustion in this ledger");
    assert.equal(pendingReviewLoop(root, "4", [entry("review-verdict", "rejected (missing findings file)", "4/review-verdict/3/0")]), null,
      "a missing findings file exhausts nothing");
    assert.equal(pendingReviewLoop(root, "4", [entry("review-verdict", UNPARSEABLE, "4/review-verdict/3/0")]), null,
      "an unparseable findings file exhausts nothing");
    assert.equal(pendingReviewLoop(root, "4", [entry("review-verdict", "rejected (green gate: exit 1)", "4/review-verdict/3/1")]), "task-4-review",
      "the green gate's rejection at the cap exhausts the loop");
    assert.equal(pendingReviewLoop(root, "4", [rejectedRound3, entry("user-decision", "continue task-4-review", "4/user-decision/0/0")]), null,
      "a decision on the loop after the exhaustion releases it");
    writeInto(root, ".devcycle/findings/task-4-review-status.md", "status: converged rounds: 2/3\n");
    assert.equal(pendingReviewLoop(root, "4", [rejectedRound3]), null, "a status other than exhausted-unresolved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
