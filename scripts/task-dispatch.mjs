#!/usr/bin/env node
// Called once per implementer or reviewer dispatch, immediately before it: writes the brief the
// coordinator composed (stdin), appends the dispatch's ledger line, and keeps its start time for the
// `dispatch` run-record row task-intake writes later. A session that dies mid-dispatch therefore
// still leaves the line that tells the resume table where the task stood.
// Contract: references/ledger.md § Task scripts.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./atomic-write.mjs";
import { isMain } from "./is-main.mjs";
import { now } from "./stamp.mjs";
import {
  UsageError, appendLedgerLine, checkIds, countFlag, ledgerKey, nextRetry, runTaskScript, taskFlags, workTreeRoot,
} from "./task-ledger.mjs";

const FLAGS = {
  "--run": "value", "--task": "value", "--role": "value", "--round": "value", "--ledger": "value", "--model-decision": "value",
};
const ROLES = new Set(["implementer", "reviewer"]);

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
  const retry = nextRetry(ledger, task, event);
  const briefPath = `.devcycle/briefs/${task}-${role}${round ? `-round-${round}` : ""}.md`;
  mkdirSync(join(root, ".devcycle/briefs"), { recursive: true });
  mkdirSync(join(root, ".devcycle/dispatch"), { recursive: true });
  atomicWrite(join(root, briefPath), brief);
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
