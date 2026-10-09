#!/usr/bin/env node
// Called once the reviewer's envelope returns: confirms the findings file exists and parses its
// verdict block (references/evidence.md § Reviewer verdicts), then writes the `review-verdict`
// ledger line, the `verdict` run-record row and, on needs-changes, the `review-reject` event row —
// all against the round's `review-round` line, so a re-run after a crash adds nothing twice.
// A rejected round 3 is the review loop's exhaustion: its status file is written per
// references/loops.md and the task becomes a user decision (references/resume.md).
// Contract: references/ledger.md § Task scripts.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { atomicWrite } from "./atomic-write.mjs";
import { gitToplevel } from "./git-identity.mjs";
import { isMain } from "./is-main.mjs";
import { validateCulprit } from "./run-record.mjs";
import {
  UsageError, appendLedgerLine, appendRunRecordOnce, checkIds, countFlag, latestKeyed, ledgerKey, nextRetry,
  parseLedgerLine, retryCount, runTaskScript, taskFlags, workTreeRoot,
} from "./task-ledger.mjs";

const FLAGS = {
  "--run": "value", "--task": "value", "--round": "value", "--findings": "value", "--evidence-class": "value",
  "--ledger": "value",
};
const REQUIRED = ["--run", "--task", "--round", "--findings", "--evidence-class"];
const EVIDENCE_CLASSES = new Set(["red-green", "green-green", "convention"]);
const MISSING = "rejected (missing findings file)";
const RETRY_CAP = 2;
const ROUND_CAP = 3;
// Blocking-ness is derived from severity (references/findings.md § Severity): critical and high block.
const BLOCKING_RE = /^\s*\d+\.\s*\[(critical|high)\]/gim;

// The verdict block's two header lines, tolerating the emphasis and code spans a markdown author
// wraps them in; null when the file carries no usable verdict.
function parseVerdict(text) {
  const plain = text.replace(/[*`]/g, "");
  const verdict = plain.match(/^\s*Verdict:\s*(accept|needs-changes)\s*$/m)?.[1];
  if (!verdict) return null;
  const culprit = plain.match(/^\s*Culprit:\s*(\S+)\s*$/m)?.[1] ?? null;
  if (verdict === "needs-changes" && (!culprit || validateCulprit(culprit).length)) return null;
  return { verdict, culprit: verdict === "accept" ? null : culprit, blocking: (text.match(BLOCKING_RE) ?? []).length };
}

// task-commit.mjs's green-gate lines share the `review-verdict` key space, so a reviewer's verdict
// takes the task's next review-verdict retry rather than its review-round's. A crash re-run finds
// the verdict line already written after its own review-round line and reuses that key.
function verdictRetry(ledger, task, reviewRound) {
  const entries = (existsSync(ledger) ? readFileSync(ledger, "utf8") : "").split("\n").map(parseLedgerLine).filter(Boolean);
  const at = entries.findLastIndex((e) => e.key === reviewRound.key);
  const written = entries.slice(at + 1).find((e) => e.task === task && e.event === "review-verdict" && e.key);
  return written ? Number(written.key.split("/")[3]) : nextRetry(ledger, task, "review-verdict");
}

export const reviewLoopId = (task) => `task-${task}-review`;

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
  const retry = verdictRetry(ledger, task, reviewRound);
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
    ledgerLine(MISSING);
    return retryCount(ledger, task, MISSING) > RETRY_CAP
      ? { ...base, action: "needs-user", reason: "retry cap: a third missing findings file", verdict: null, culprit: null, blocking: null, appended }
      : { ...base, action: "missing-findings", verdict: null, culprit: null, blocking: null, appended };
  }

  const accepted = parsed.verdict === "accept";
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
  if (round < ROUND_CAP) return { ...result, action: "rejected" };
  const loopId = reviewLoopId(task);
  mkdirSync(join(root, ".devcycle/findings"), { recursive: true });
  atomicWrite(join(root, `.devcycle/findings/${loopId}-status.md`),
    `status: exhausted-unresolved rounds: ${round}/${ROUND_CAP} residue: ${parsed.blocking} carried-to: none\n`);
  return { ...result, action: "needs-user", reason: "review loop exhausted-unresolved", loopId };
}

if (isMain(import.meta.url, process.argv[1])) runTaskScript("task-verdict", () => verdict(process.argv.slice(2)));
