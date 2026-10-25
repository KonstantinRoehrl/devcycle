#!/usr/bin/env node
// Called once per implementer or reviewer dispatch, immediately before it: writes the brief the
// coordinator composed (stdin) — an implementer's with its matched lessons and gate command filled
// in — appends the dispatch's ledger line, and keeps its start time for the
// `dispatch` run-record row task-intake writes later. A session that dies mid-dispatch therefore
// still leaves the line that tells the resume table where the task stood. A reviewer dispatch takes
// the task's next review round only, and moves aside any findings file already at that round's path,
// so the verdict task-verdict reads back is this dispatch's reviewer's or none.
// Contract: references/ledger.md § Task scripts.
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./atomic-write.mjs";
import { isMain } from "./is-main.mjs";
import { matchedLessons } from "./lesson-match.mjs";
import { now } from "./stamp.mjs";
import {
  UsageError, appendLedgerLine, checkIds, countFlag, ledgerKey, nextReviewRound, nextRetry, runTaskScript, taskEntries, taskFiles,
  taskFlags, taskGate, workTreeRoot,
} from "./task-ledger.mjs";

const FLAGS = {
  "--run": "value", "--task": "value", "--role": "value", "--round": "value", "--ledger": "value", "--model-decision": "value",
};
const ROLES = new Set(["implementer", "reviewer"]);
const LESSONS_LINE_RE = /^\*\*Lessons:\*\*.*$/m;
const LESSONS_HEADER = "**Lessons:** (pull a full record with its --lesson hint only if you are about to work in the area it names)";

// The round's findings path, as references/delegation.md names it: a file already there before its
// reviewer is dispatched is an earlier reviewer's, never this one's verdict.
function setAsideFindings(root, task, round, retry) {
  const stem = join(root, `.devcycle/findings/${task}-round-${round}`);
  if (existsSync(`${stem}.md`)) renameSync(`${stem}.md`, `${stem}.stale-${retry}.md`);
}

// An implementer brief's `**Lessons:**` line, filled in place with the execution lessons its task's
// **Files:** match, or the block added last when the brief carries no such line. `lessons` is the
// matched line count, null when no plan or Files set resolves and the brief stays as composed.
function withLessons(brief, root, ledger, task) {
  const files = taskFiles(ledger, task);
  if (!files) return { text: brief, lessons: null };
  const matched = matchedLessons({ root, stage: "execution", files: [...files] });
  const block = matched ? `${LESSONS_HEADER}\n${matched}` : "**Lessons:** none";
  const text = LESSONS_LINE_RE.test(brief) ? brief.replace(LESSONS_LINE_RE, () => block) : `${brief.replace(/\n*$/, "\n")}\n${block}\n`;
  return { text, lessons: matched ? matched.split("\n").length : 0 };
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
  // An implementer brief ends with the task's resolved gate, so the brief, the capture helper's cmd:
  // and the evidence check agree with no hand slicing (references/evidence.md § File-backed evidence).
  const gate = role === "implementer" ? taskGate(ledger, task) : null;
  const filled = role === "implementer" ? withLessons(brief, root, ledger, task) : { text: brief };
  atomicWrite(join(root, briefPath), gate ? `${filled.text.replace(/\n*$/, "\n")}\n**Gate command:** \`${gate.cmd}\`\n` : filled.text);
  if (role === "reviewer") setAsideFindings(root, task, round, retry);
  atomicWrite(join(root, `.devcycle/dispatch/${task}-${role}-${round}-${retry}.json`), JSON.stringify({ startedAt: now() }) + "\n");
  // The routing decision is the audit shape references/model-routing.md records on `dispatched`.
  const decision = flags["--model-decision"];
  const outcome = role === "implementer" ? (decision ? `model ${decision}` : `implementer retry ${retry}`) : `round ${round}`;
  const { appended } = appendLedgerLine(ledger, { task, event, outcome, ref: briefPath, round, retry });
  return {
    action: "dispatch", task, role, round, retry, briefPath, ...("lessons" in filled ? { lessons: filled.lessons } : {}),
    appended: appended ? [ledgerKey({ task, event, round, retry })] : [],
  };
}

if (isMain(import.meta.url, process.argv[1]))
  runTaskScript("task-dispatch", () => dispatch(process.argv.slice(2), readFileSync(0, "utf8")));
