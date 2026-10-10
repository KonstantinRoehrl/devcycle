#!/usr/bin/env node
// Called once per implementer or reviewer dispatch, immediately before it: writes the brief the
// coordinator composed (stdin), appends the dispatch's ledger line, and keeps its start time for the
// `dispatch` run-record row task-intake writes later. A session that dies mid-dispatch therefore
// still leaves the line that tells the resume table where the task stood. A reviewer dispatch takes
// the task's next review round only, and moves aside any findings file already at that round's path,
// so the verdict task-verdict reads back is this dispatch's reviewer's or none.
// Contract: references/ledger.md § Task scripts.
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./atomic-write.mjs";
import { isMain } from "./is-main.mjs";
import { now } from "./stamp.mjs";
import {
  UsageError, appendLedgerLine, checkIds, countFlag, ledgerKey, nextReviewRound, nextRetry, runTaskScript, taskEntries, taskFlags,
  workTreeRoot,
} from "./task-ledger.mjs";

const FLAGS = {
  "--run": "value", "--task": "value", "--role": "value", "--round": "value", "--ledger": "value", "--model-decision": "value",
};
const ROLES = new Set(["implementer", "reviewer"]);

// The round's findings path, as references/delegation.md names it: a file already there before its
// reviewer is dispatched is an earlier reviewer's, never this one's verdict.
function setAsideFindings(root, task, round, retry) {
  const stem = join(root, `.devcycle/findings/${task}-round-${round}`);
  if (existsSync(`${stem}.md`)) renameSync(`${stem}.md`, `${stem}.stale-${retry}.md`);
}

export function dispatch(argv, brief, cwd = process.cwd()) {
  const flags = taskFlags(argv, FLAGS, ["--run", "--task", "--role"]);
  const { "--run": run, "--task": task, "--role": role } = flags;
  checkIds({ run, task });
  if (!ROLES.has(role)) throw new UsageError(`--role must be implementer or reviewer, got "${role}"`);
  const roundFlag = countFlag(flags, "--round", role === "reviewer" ? 1 : 0);
  if (role === "reviewer" && roundFlag === undefined) throw new UsageError("--round is required for a reviewer dispatch");
  const round = roundFlag ?? 0;
  if (!brief.trim()) throw new UsageError("the brief text on stdin is empty");

  const root = workTreeRoot(cwd);
  const ledger = flags["--ledger"] ?? join(root, ".devcycle/ledger.md");
  const event = role === "implementer" ? "dispatched" : "review-round";
  if (role === "reviewer") {
    const expected = nextReviewRound(taskEntries(ledger, task));
    if (round !== expected) throw new UsageError(`task ${task}'s next review is round ${expected}, not ${round}`);
  }
  const retry = nextRetry(ledger, task, event);
  const briefPath = `.devcycle/briefs/${task}-${role}${round ? `-round-${round}` : ""}.md`;
  mkdirSync(join(root, ".devcycle/briefs"), { recursive: true });
  mkdirSync(join(root, ".devcycle/dispatch"), { recursive: true });
  atomicWrite(join(root, briefPath), brief);
  if (role === "reviewer") setAsideFindings(root, task, round, retry);
  atomicWrite(join(root, `.devcycle/dispatch/${task}-${role}-${round}-${retry}.json`), JSON.stringify({ startedAt: now() }) + "\n");
  // The routing decision is the audit shape references/model-routing.md records on `dispatched`.
  const decision = flags["--model-decision"];
  const outcome = role === "implementer" ? (decision ? `model ${decision}` : `implementer retry ${retry}`) : `round ${round}`;
  const { appended } = appendLedgerLine(ledger, { task, event, outcome, ref: briefPath, round, retry });
  return {
    action: "dispatch", task, role, round, retry, briefPath,
    appended: appended ? [ledgerKey({ task, event, round, retry })] : [],
  };
}

if (isMain(import.meta.url, process.argv[1]))
  runTaskScript("task-dispatch", () => dispatch(process.argv.slice(2), readFileSync(0, "utf8")));
