#!/usr/bin/env node
// Called once per implementer or reviewer dispatch, immediately before it: writes the brief the
// coordinator composed (stdin) — an implementer's with its matched lessons and gate command filled
// in — appends the dispatch's ledger line, and keeps its start time and session for the
// `dispatch` run-record row task-intake writes later and for dispatch-health.mjs, which binds the
// agent to it. A session that dies mid-dispatch therefore still leaves the line that tells the
// resume table where the task stood. A reviewer dispatch takes the task's next review round only,
// and moves aside any findings file already at that round's path, so the verdict task-verdict
// reads back is this dispatch's reviewer's or none.
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
  "--capture-cmd": "value",
};
const ROLES = new Set(["implementer", "reviewer"]);
const LESSONS_LINE_RE = /^\*\*Lessons:\*\*.*$/m;
const LESSONS_HEADER = "**Lessons:** (pull a full record with its --lesson hint only if you are about to work in the area it names)";

// The brief's path for a dispatch: dispatch-health.mjs binds a subagent's transcript to its dispatch by
// finding this path in the dispatch prompt.
export const briefPathFor = (task, role, round) => `.devcycle/briefs/${task}-${role}${round ? `-round-${round}` : ""}.md`;

// Where the before/after capture rule lives: every gated brief cites it rather than restating it.
const BEFORE_AFTER_OWNER = "references/evidence.md § File-backed evidence owns the before/after rule";

// A gated brief's tail: both captures run the gate. A test-class task whose after a sibling's
// uncommitted red forces narrower keeps the before on the gate and declares the narrowing; a
// convention report keeps identical headers, so its brief offers no narrowing.
const gateLine = (cmd, evidenceClass) =>
  `**Gate command:** \`${cmd}\` — capture both the before and the after with it` +
  (evidenceClass === "convention"
    ? `, byte for byte the same command (${BEFORE_AFTER_OWNER}).\n`
    : `; if a sibling's uncommitted red forces a narrower after, keep the before on this command ` +
      `and declare the narrowing with a \`- Narrowing:\` line (${BEFORE_AFTER_OWNER}).\n`);

// A concurrent wave's implementer captures its own test command: a sibling's uncommitted red tests
// share the checkout, and the whole gate still runs at commit in an isolated worktree.
const captureLines = (cmd) =>
  `**Capture command:** \`${cmd}\` — pass it as \`capture-evidence.mjs --cmd\` for both the before and the after capture (${BEFORE_AFTER_OWNER}), and copy this line into your report:\n` +
  `- Narrowing: ${cmd} — concurrent wave: siblings' uncommitted edits share the checkout; the whole gate runs at commit in an isolated worktree\n`;

function briefTail(gate, captureCmd) {
  const gateTail = gate ? (captureCmd ? `**Gate command:** \`${gate.cmd}\`\n` : gateLine(gate.cmd, gate.evidenceClass)) : "";
  return gateTail || captureCmd ? `\n${gateTail}${captureCmd ? captureLines(captureCmd) : ""}` : "";
}

// The round's findings path, as references/delegation.md names it: the reviewer writes its verdict
// there, and task-verdict reads it back.
export const roundFindingsPath = (task, round) => `.devcycle/findings/${task}-round-${round}.md`;

// A file already at the round's findings path before its reviewer is dispatched is an earlier
// reviewer's, never this one's verdict.
function setAsideFindings(root, task, round, retry) {
  const path = join(root, roundFindingsPath(task, round));
  if (existsSync(path)) renameSync(path, path.replace(/\.md$/, `.stale-${retry}.md`));
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
  const captureCmd = flags["--capture-cmd"];
  if (captureCmd !== undefined && (role !== "implementer" || /\n/.test(captureCmd) || !captureCmd.trim()))
    throw new UsageError("--capture-cmd takes one line, on an implementer dispatch only");
  if (!brief.trim()) throw new UsageError("the brief text on stdin is empty");

  const root = workTreeRoot(cwd);
  const ledger = flags["--ledger"] ?? join(root, ".devcycle/ledger.md");
  const event = role === "implementer" ? "dispatched" : "review-round";
  if (role === "reviewer") {
    const expected = nextReviewRound(taskEntries(ledger, task));
    if (round !== expected) throw new UsageError(`task ${task}'s next review is round ${expected}, not ${round}`);
  }
  const retry = nextRetry(ledger, task, event);
  const briefPath = briefPathFor(task, role, round);
  mkdirSync(join(root, ".devcycle/briefs"), { recursive: true });
  mkdirSync(join(root, ".devcycle/dispatch"), { recursive: true });
  // An implementer brief ends with the task's resolved gate, so the brief, the capture helper's cmd:
  // and the evidence check agree with no hand slicing (references/evidence.md § File-backed evidence).
  const gate = role === "implementer" ? taskGate(ledger, task) : null;
  const filled = role === "implementer" ? withLessons(brief, root, ledger, task) : { text: brief };
  const tail = briefTail(gate, captureCmd);
  atomicWrite(join(root, briefPath), tail ? `${filled.text.replace(/\n*$/, "\n")}${tail}` : filled.text);
  if (role === "reviewer") setAsideFindings(root, task, round, retry);
  atomicWrite(join(root, `.devcycle/dispatch/${task}-${role}-${round}-${retry}.json`), JSON.stringify({ startedAt: now(), sessionId: process.env.CLAUDE_CODE_SESSION_ID || null }) + "\n");
  // The routing decision is the audit shape references/model-routing.md records on `dispatched`.
  const decision = flags["--model-decision"];
  const outcome = role === "implementer" ? (decision ? `model ${decision}` : `implementer retry ${retry}`) : `round ${round}`;
  const { appended } = appendLedgerLine(ledger, { task, event, outcome, ref: briefPath, round, retry });
  return {
    action: "dispatch", task, role, round, retry, briefPath, ...("lessons" in filled ? { lessons: filled.lessons } : {}),
    appended: appended ? [ledgerKey({ task, event, round, retry })] : [],
  };
}

// --help is answered before stdin is read, so an interactive call never waits on a brief.
function dispatchMain(argv) {
  runTaskScript("task-dispatch", () => dispatch(argv, argv.includes("--help") ? "" : readFileSync(0, "utf8")));
}

if (isMain(import.meta.url, process.argv[1])) dispatchMain(process.argv.slice(2));
