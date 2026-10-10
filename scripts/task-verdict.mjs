#!/usr/bin/env node
// Called once the reviewer's envelope returns: confirms the findings file exists and parses its
// verdict block (references/evidence.md § Reviewer verdicts), then writes the `review-verdict`
// ledger line, the `verdict` run-record row and, on needs-changes, the `review-reject` event row —
// all against the round's `review-round` line, so a re-run after a crash adds nothing twice.
// A rejected round 3 is the review loop's exhaustion: its status file is written per
// references/loops.md and the task becomes a user decision (references/resume.md). task-commit.mjs
// writes the same status when the green gate rejects round 3's acceptance.
// Contract: references/ledger.md § Task scripts.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { atomicWrite } from "./atomic-write.mjs";
import { gitToplevel } from "./git-identity.mjs";
import { isMain } from "./is-main.mjs";
import { validateCulprit } from "./run-record.mjs";
import {
  MISSING_FINDINGS, UsageError, appendLedgerLine, appendRunRecordOnce, checkIds, countFlag, latestKeyed, ledgerKey,
  nextRetry, parseLedgerLine, retryCount, runTaskScript, taskFlags, workTreeRoot,
} from "./task-ledger.mjs";

const FLAGS = {
  "--run": "value", "--task": "value", "--round": "value", "--findings": "value", "--evidence-class": "value",
  "--ledger": "value",
};
const REQUIRED = ["--run", "--task", "--round", "--findings", "--evidence-class"];
const EVIDENCE_CLASSES = new Set(["red-green", "green-green", "convention"]);
const RETRY_CAP = 2;
export const ROUND_CAP = 3;
// The review-verdict outcomes this script writes; task-commit.mjs's green-gate lines share the event.
const OWN_OUTCOMES = new Set(["accepted", "rejected", MISSING_FINDINGS]);
// Blocking-ness is derived from severity (references/findings.md § Severity): critical and high block.
const BLOCKING_RE = /^\s*\d+\.\s*\[(critical|high)\]/i;

// The lines outside fenced code blocks: inside one, a reviewer quotes a verdict or a finding without
// giving it.
function unfencedLines(text) {
  let fence = null;
  return text.split("\n").filter((line) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) {
      fence = fence ? null : marker;
      return false;
    }
    return !fence;
  });
}

// The verdict block's two header lines, tolerating the emphasis and code spans a markdown author
// wraps them in, either case, and the `approved` / `accepted` a reviewer writes for accept; null when
// the file carries no usable verdict — none, two that disagree, a needs-changes without a valid
// culprit, or an accept that lists a blocking finding.
function parseVerdict(text) {
  const lines = unfencedLines(text);
  const plain = lines.map((line) => line.replace(/[*`]/g, ""));
  const verdicts = new Set(plain.flatMap((line) => {
    const word = line.match(/^\s*Verdict:\s*(accept|accepted|approved|needs-changes)\s*$/i)?.[1].toLowerCase();
    return word ? [word === "needs-changes" ? word : "accept"] : [];
  }));
  if (verdicts.size !== 1) return null;
  const [verdict] = verdicts;
  const blocking = lines.filter((line) => BLOCKING_RE.test(line)).length;
  if (verdict === "accept") return blocking ? null : { verdict, culprit: null, blocking };
  const culprit = plain.map((line) => line.match(/^\s*Culprit:\s*(\S+)\s*$/i)?.[1]).find(Boolean);
  if (!culprit || validateCulprit(culprit).length) return null;
  return { verdict, culprit, blocking };
}

// The task's ledger lines after the round's review-round line, in file order.
function linesSince(ledger, task, reviewRound) {
  const entries = (existsSync(ledger) ? readFileSync(ledger, "utf8") : "").split("\n").map(parseLedgerLine).filter(Boolean);
  const at = entries.findLastIndex((e) => e.key === reviewRound.key);
  return entries.slice(at + 1).filter((e) => e.task === task);
}

// task-commit.mjs's green-gate lines share the `review-verdict` key space, so a reviewer's verdict
// takes the task's next review-verdict retry rather than its review-round's. A crash re-run finds
// the verdict line already written after its own review-round line and reuses that key.
function verdictRetry(ledger, task, later) {
  const written = later.find((e) => e.event === "review-verdict" && e.key);
  return written ? Number(written.key.split("/")[3]) : nextRetry(ledger, task, "review-verdict");
}

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

const exhausts = (e) => e.event === "review-verdict" && e.outcome.startsWith("rejected") && !e.outcome.startsWith(MISSING_FINDINGS);

// references/resume.md § Exhausted-unresolved: the loop id while the task's review loop waits on the
// user, else null. `entries` are the task's ledger lines in file order. The status file carries no
// time, but a decision on the loop comes past the round cap, so any rejection after the latest one is
// an exhaustion that decision never saw.
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
  return decided < 0 || entries.slice(decided + 1).some(exhausts) ? loopId : null;
}

export function verdict(argv, cwd = process.cwd()) {
  const flags = taskFlags(argv, FLAGS, REQUIRED);
  const { "--run": run, "--task": task } = flags;
  checkIds({ run, task });
  // A plan's **Evidence:** field may carry a gloss after the class ("green-green (behavior-preserving)").
  const evidenceClass = flags["--evidence-class"].trim().split(/\s+/)[0];
  const round = countFlag(flags, "--round", 1);
  if (!EVIDENCE_CLASSES.has(evidenceClass))
    throw new UsageError(`--evidence-class must be red-green, green-green or convention, got "${evidenceClass}"`);

  const root = workTreeRoot(cwd);
  const ledger = flags["--ledger"] ?? join(root, ".devcycle/ledger.md");
  const reviewRound = latestKeyed(ledger, task, "review-round", { round });
  if (!reviewRound)
    throw new Error(`no review-round line for task ${task} round ${round} in ${ledger} — dispatch the reviewer through task-dispatch.mjs first`);
  const later = linesSince(ledger, task, reviewRound);
  // Once the coordinator acted on the round's verdict — any later line of the task but this script's
  // own: the green gate's rejection of it, the fix's dispatch — the round is closed, and reading it
  // again would hand what followed it, an unreviewed fix among them, that round's accept.
  const closing = later.find((e) => !(e.event === "review-verdict" && OWN_OUTCOMES.has(e.outcome)));
  if (closing)
    throw new UsageError(`round ${round} of task ${task} is closed: its verdict was acted on (${closing.event} ${closing.outcome})`);
  const retry = verdictRetry(ledger, task, later);
  const findingsRel = relative(root, resolve(cwd, flags["--findings"]));
  const findingsAbs = join(root, findingsRel);
  const parsed = existsSync(findingsAbs) ? parseVerdict(readFileSync(findingsAbs, "utf8")) : null;

  const appended = [];
  const key = ledgerKey({ task, event: "review-verdict", round, retry });
  const ledgerLine = (outcome) => {
    const r = appendLedgerLine(ledger, { task, event: "review-verdict", outcome, ref: findingsRel, round, retry });
    if (r.appended) appended.push(key);
    return parseLedgerLine(r.line);
  };
  const base = { task, round, retry, findingsPath: findingsRel };

  if (!parsed) {
    ledgerLine(MISSING_FINDINGS);
    return retryCount(ledger, task, MISSING_FINDINGS) > RETRY_CAP
      ? { ...base, action: "needs-user", reason: "retry cap: a third missing findings file", verdict: null, culprit: null, blocking: null, appended }
      : { ...base, action: "missing-findings", verdict: null, culprit: null, blocking: null, appended };
  }

  const accepted = parsed.verdict === "accept";
  // The status goes first, so a crash before the rejection's line leaves the user's decision pending,
  // never a rejected round 3 that reads as one more fix to make.
  const loopId = !accepted && round >= ROUND_CAP ? exhaustReviewLoop(root, task, round, parsed.blocking) : null;
  const line = ledgerLine(accepted ? "accepted" : "rejected");
  const toplevel = gitToplevel(root);
  const row = (kind, fields, matchKeys) => {
    if (appendRunRecordOnce({ toplevel, run, kind, fields, matchKeys }).appended) appended.push(`rr:${kind}`);
  };
  row("verdict", { taskId: task, round, blockingCount: parsed.blocking, evidenceClass, conformance: accepted ? "pass" : "fail" },
    ["taskId", "round", "conformance"]);
  const result = { ...base, verdict: parsed.verdict, culprit: parsed.culprit, blocking: parsed.blocking, appended };
  if (accepted) return { ...result, action: "accepted" };

  // The ledger line's own stamp is the event's time, so a re-run that finds that line writes the
  // same row and is skipped, while a later round's rejection — a new line, a review round later and
  // so never within the same second — is not.
  row("event", { event: "review-reject", stage: "execution", task, culprit: parsed.culprit, attributedBy: "coordinator", ts: line.stamp },
    ["event", "task", "ts"]);
  if (!loopId) return { ...result, action: "rejected" };
  return { ...result, action: "needs-user", reason: "review loop exhausted-unresolved", loopId };
}

if (isMain(import.meta.url, process.argv[1])) runTaskScript("task-verdict", () => verdict(process.argv.slice(2)));
