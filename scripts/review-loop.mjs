// The task review loop's shared pieces: its round cap, its loop id, and the exhausted-unresolved
// status file references/loops.md § Where the status lives places. task-verdict.mjs writes the status
// for a rejected round 3 and task-commit.mjs for a red gate after round 3's accept; task-commit.mjs
// and wave-setup.mjs read it through pendingReviewLoop.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./atomic-write.mjs";
import { isNoVerdict } from "./task-ledger.mjs";

export const ROUND_CAP = 3;

export const reviewLoopId = (task) => `task-${task}-review`;

// references/loops.md § Where the status lives: the task's review loop ran out of rounds with
// `residue` blocking items unresolved. Returns the loop id the user's decision names.
export function exhaustReviewLoop(root, task, round, residue) {
  const loopId = reviewLoopId(task);
  mkdirSync(join(root, ".devcycle/findings"), { recursive: true });
  atomicWrite(join(root, `.devcycle/findings/${loopId}-status.md`),
    `status: exhausted-unresolved rounds: ${round}/${ROUND_CAP} residue: ${residue} carried-to: none\n`);
  return loopId;
}

// A rejection — the reviewer's or the green gate's, never a findings file with no verdict — at or past the
// round cap: the line each exhaustion of the loop writes right after its status file.
const exhausts = (e) => e.event === "review-verdict" && e.outcome.startsWith("rejected") &&
  !isNoVerdict(e.outcome) && Number(e.key?.split("/")[2]) >= ROUND_CAP;

// references/resume.md § Exhausted-unresolved: the loop id while the task's review loop waits on the
// user, else null. `entries` are the task's ledger lines of this cycle, in file order. The status file
// is keyed by a task id every cycle reuses and carries no time, so it counts only for an exhaustion
// this ledger holds, and only while no decision on the loop follows the latest one.
export function pendingReviewLoop(root, task, entries) {
  const loopId = reviewLoopId(task);
  let status;
  try {
    status = readFileSync(join(root, `.devcycle/findings/${loopId}-status.md`), "utf8");
  } catch {
    return null;
  }
  if (!/^status:\s*exhausted-unresolved\b/m.test(status)) return null;
  const decided = entries.findLastIndex((e) => e.event === "user-decision" && e.outcome.includes(loopId));
  return entries.findLastIndex(exhausts) > decided ? loopId : null;
}
