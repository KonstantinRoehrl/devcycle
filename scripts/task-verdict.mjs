#!/usr/bin/env node
// Called once the reviewer's envelope returns: reads the findings file's verdict block, telling an
// absent file from one with no usable verdict (references/evidence.md § Reviewer verdicts), then writes the `review-verdict`
// ledger line, the `verdict` run-record row and, on needs-changes, the `review-reject` event row —
// all against the round's `review-round` line, so a re-run after a crash adds nothing twice.
// A rejected round 3 is the review loop's exhaustion: its status file is written per
// references/loops.md and the task becomes a user decision (references/resume.md). task-commit.mjs
// writes the same status when the green gate rejects round 3's acceptance.
// Given task-commit.mjs's --plan, --test-cmd and --subject, an accepted verdict commits in the same
// call, and the result is the commit's with this verdict under `verdict`.
// Contract: references/ledger.md § Task scripts.
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { DISPATCH_ENDED } from "./dispatch-health.mjs";
import { gitToplevel } from "./git-identity.mjs";
import { isMain } from "./is-main.mjs";
import { ROUND_CAP, exhaustReviewLoop } from "./review-loop.mjs";
import { validateCulprit } from "./run-record.mjs";
import { commitArgs, taskCommit } from "./task-commit.mjs";
import {
  MISSING_FINDINGS, UsageError, appendLedgerLine, appendRunRecordOnce, checkIds, countFlag, isNoVerdict, latestKeyed,
  ledgerKey, nextRetry, parseLedgerLine, retryCount, runTaskScript, taskFlags, unparseableFindings, workTreeRoot,
} from "./task-ledger.mjs";

const FLAGS = {
  "--run": "value", "--task": "value", "--round": "value", "--findings": "value", "--evidence-class": "value",
  "--ledger": "value", "--plan": "value", "--test-cmd": "value", "--subject": "value", "--trailers": "value",
  "--culprit": "value",
};
const REQUIRED = ["--run", "--task", "--round", "--findings", "--evidence-class"];
const COMMIT_FLAGS = ["--plan", "--test-cmd", "--subject", "--trailers", "--culprit"];
const COMMIT_REQUIRED = ["--plan", "--test-cmd", "--subject"];
const EVIDENCE_CLASSES = new Set(["red-green", "green-green", "convention"]);
const RETRY_CAP = 2;
// The verdict outcomes this script writes, beside its no-verdict ones (isNoVerdict); task-commit.mjs's
// green-gate lines share the event.
const OWN_OUTCOMES = new Set(["accepted", "rejected"]);
// Blocking-ness is derived from severity (references/findings.md § Severity): critical and high block.
const BLOCKING_RE = /^\s*\d+\.\s*\[(critical|high)\]/i;

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
// Whether `line` is a fence marker that closes the block the `open` marker began.
const closesFence = (line, open) => {
  const marker = line.match(FENCE_RE)?.[1];
  return Boolean(marker) && marker[0] === open[0] && marker.length >= open.length;
};

// The lines outside fenced code blocks: inside one, a reviewer quotes a verdict or a finding without
// giving it.
function unfencedLines(text) {
  let fence = null;
  return text.split("\n").filter((line) => {
    if (fence ? closesFence(line, fence) : FENCE_RE.test(line)) {
      fence = fence ? null : line.match(FENCE_RE)[1];
      return false;
    }
    return !fence;
  });
}

// A file that is one fenced block and nothing else — references/evidence.md's verdict shape copied
// with its fence — is read as the block's text.
function unwrapWholeFence(text) {
  const lines = text.replace(/^\s*\n/, "").trimEnd().split("\n");
  const open = lines[0].match(FENCE_RE)?.[1];
  const inner = lines.slice(1, -1);
  const whole = open && lines.length > 1 && closesFence(lines.at(-1), open) && !inner.some((line) => closesFence(line, open));
  return whole ? inner.join("\n") : text;
}

const VERDICT_WORD = "accept|accepted|approve|approved|needs-changes";
const VERDICT_RE = new RegExp(`^\\s*Verdict:\\s*(${VERDICT_WORD})\\s*$`, "i");
const VERDICT_HEADING_RE = /^\s*#{1,6}\s+Verdict:?\s*$/i;
const WORD_RE = new RegExp(`^\\s*(${VERDICT_WORD})\\s*$`, "i");
const CULPRIT_RE = /^\s*Culprit:\s*(\S+)\s*$/i;
// A heading (`#`…`######`) or list (`-`, `+`) marker before a verdict block line is markup; `*` is
// already gone with the emphasis.
const unmarked = (line) => line.replace(/^\s*(?:#{1,6}\s+|[-+]\s+)/, "");

const EXPECTED_VERDICT = "Verdict: accept, or Verdict: needs-changes with a Culprit: <slug> line under it (references/evidence.md § Reviewer verdicts)";

// The verdict block's two header lines, tolerating the emphasis, code spans and heading or list
// markers a markdown author wraps them in, either case, and the `approve` / `approved` / `accepted` a
// reviewer writes for accept; a `Verdict` heading may carry its word alone on the next line. A file
// with no usable verdict returns `{ reason }`, one of a fixed set the ledger outcome names.
function parseVerdict(text) {
  const lines = unfencedLines(unwrapWholeFence(text));
  const plain = lines.map((line) => line.replace(/[*`]/g, ""));
  const verdicts = new Set(plain.flatMap((line, i) => {
    const word = unmarked(line).match(VERDICT_RE)?.[1] ?? (VERDICT_HEADING_RE.test(line) ? plain[i + 1]?.match(WORD_RE)?.[1] : undefined);
    return word ? [word.toLowerCase() === "needs-changes" ? "needs-changes" : "accept"] : [];
  }));
  if (!verdicts.size) return { reason: "no verdict line" };
  if (verdicts.size > 1) return { reason: "conflicting verdicts" };
  const [verdict] = verdicts;
  const blocking = lines.filter((line) => BLOCKING_RE.test(line)).length;
  if (verdict === "accept") return blocking ? { reason: "accept lists a blocking finding" } : { verdict, culprit: null, blocking };
  const culprit = plain.map((line) => unmarked(line).match(CULPRIT_RE)?.[1]).find(Boolean);
  if (!culprit || validateCulprit(culprit).length) return { reason: "needs-changes without a valid culprit" };
  return { verdict, culprit, blocking };
}

function readVerdict(findingsAbs) {
  return existsSync(findingsAbs) ? parseVerdict(readFileSync(findingsAbs, "utf8")) : { reason: "absent file", absent: true };
}

function verdictOutcome(parsed) {
  if (!parsed.verdict) return parsed.absent ? MISSING_FINDINGS : unparseableFindings(parsed.reason);
  return parsed.verdict === "accept" ? "accepted" : "rejected";
}

// A round with no verdict re-dispatches its reviewer, saying what the file lacked and what it should
// hold; absent and unparseable files spend one retry cap between them.
function noVerdictResult(ledger, task, base, parsed, appended) {
  const result = { ...base, reason: parsed.reason, expected: EXPECTED_VERDICT, verdict: null, culprit: null, blocking: null, appended };
  return retryCount(ledger, task, isNoVerdict) > RETRY_CAP
    ? { ...result, action: "needs-user", reason: `retry cap: a third findings file with no verdict (${parsed.reason})` }
    : { ...result, action: "missing-findings" };
}

// The task's ledger lines after the round's review-round line, in file order.
function linesSince(ledger, task, reviewRound) {
  const entries = (existsSync(ledger) ? readFileSync(ledger, "utf8") : "").split("\n").map(parseLedgerLine).filter(Boolean);
  const at = entries.findLastIndex((e) => e.key === reviewRound.key);
  return entries.slice(at + 1).filter((e) => e.task === task);
}

// task-commit.mjs's green-gate lines share the `review-verdict` key space, so a reviewer's verdict
// takes the task's next review-verdict retry rather than its review-round's. A crash re-run finds its
// outcome already the round's latest line and reuses that key; a file that reads otherwise now — one
// that turned up after the round logged it missing — gets a line of its own, so the ledger ends on
// what this run reports.
function verdictRetry(ledger, task, later, outcome) {
  const written = later.findLast((e) => e.event === "review-verdict" && e.key);
  return written?.outcome === outcome ? Number(written.key.split("/")[3]) : nextRetry(ledger, task, "review-verdict");
}

// task-commit.mjs's argv for the commit an accept runs in-process, checked as that script checks it;
// null when no commit flag is given. A flag's `=` form keeps a value that starts with `--` its own.
function commitArgv(flags) {
  const given = COMMIT_FLAGS.filter((name) => Object.hasOwn(flags, name));
  if (!given.length) return null;
  const missing = COMMIT_REQUIRED.filter((name) => !given.includes(name));
  if (missing.length)
    throw new UsageError(`${given.join(", ")} needs ${missing.join(", ").replace(/, ([^,]+)$/, " and $1")} too: an accepted verdict commits only given --plan, --test-cmd and --subject`);
  const argv = ["--run", flags["--run"], "--task", flags["--task"], ...[...given, ...(Object.hasOwn(flags, "--ledger") ? ["--ledger"] : [])]
    .map((name) => (flags[name] === undefined ? name : `${name}=${flags[name]}`))];
  commitArgs(argv);
  return argv;
}

// A commit that failed after the verdict was recorded: carries what the verdict wrote, so the failure
// output does not read as though nothing was.
class CommitFailed extends Error {
  constructor(cause, verdictFields, appended) {
    super(cause.message, { cause });
    this.verdictFields = verdictFields;
    this.appended = appended;
  }
}

// The commit's result, with the verdict it followed under `verdict` and the verdict's keys first.
function committed(commit, cwd, verdictFields, appended) {
  let result;
  try {
    result = taskCommit(commit, cwd);
  } catch (err) {
    throw new CommitFailed(err, verdictFields, appended);
  }
  return { ...result, verdict: verdictFields, appended: [...appended, ...result.appended] };
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
  const commit = commitArgv(flags);

  const root = workTreeRoot(cwd);
  const ledger = flags["--ledger"] ?? join(root, ".devcycle/ledger.md");
  const reviewRound = latestKeyed(ledger, task, "review-round", { round });
  if (!reviewRound)
    throw new Error(`no review-round line for task ${task} round ${round} in ${ledger} — dispatch the reviewer through task-dispatch.mjs first`);
  const later = linesSince(ledger, task, reviewRound);
  // Once the coordinator acted on the round's verdict — any later line of the task but this script's
  // own: the green gate's rejection of it, the fix's dispatch — the round is closed, and reading it
  // again would hand what followed it, an unreviewed fix among them, that round's accept.
  // A dispatch that ended without its output is no action on the round's verdict: its redispatch
  // reviews the same round.
  const closing = later.find((e) => e.event !== DISPATCH_ENDED && !(e.event === "review-verdict" && (OWN_OUTCOMES.has(e.outcome) || isNoVerdict(e.outcome))));
  // A commit call re-run once the round's accept committed: the accept stands as the ledger holds it,
  // and task-commit.mjs's own re-run adds only what the commit still lacks.
  const accept = commit && closing?.event === "committed" && later.findLast((e) => e.event === "review-verdict" && e.outcome === "accepted");
  if (accept)
    return committed(commit, cwd,
      { verdict: "accept", round, retry: Number(accept.key.split("/")[3]), findingsPath: accept.ref, blocking: 0, culprit: null }, []);
  if (closing)
    throw new UsageError(`round ${round} of task ${task} is closed: its verdict was acted on (${closing.event} ${closing.outcome})`);
  const findingsRel = relative(root, resolve(cwd, flags["--findings"]));
  const findingsAbs = join(root, findingsRel);
  const parsed = readVerdict(findingsAbs);
  const accepted = parsed.verdict === "accept";
  const outcome = verdictOutcome(parsed);
  const retry = verdictRetry(ledger, task, later, outcome);

  const appended = [];
  const ledgerLine = () => {
    const r = appendLedgerLine(ledger, { task, event: "review-verdict", outcome, ref: findingsRel, round, retry });
    if (r.appended) appended.push(ledgerKey({ task, event: "review-verdict", round, retry }));
    return parseLedgerLine(r.line);
  };
  const base = { task, round, retry, findingsPath: findingsRel };

  if (!parsed.verdict) {
    ledgerLine();
    return noVerdictResult(ledger, task, base, parsed, appended);
  }

  // The status goes first, so a rejected round 3 never stands in the ledger without it — a line that
  // would read as one more fix to make. A crash between the two leaves the round to read again.
  const loopId = !accepted && round >= ROUND_CAP ? exhaustReviewLoop(root, task, round, parsed.blocking) : null;
  const line = ledgerLine();
  const toplevel = gitToplevel(root);
  const row = (kind, fields, matchKeys) => {
    if (appendRunRecordOnce({ toplevel, run, kind, fields, matchKeys }).appended) appended.push(`rr:${kind}`);
  };
  row("verdict", { taskId: task, round, blockingCount: parsed.blocking, evidenceClass, conformance: accepted ? "pass" : "fail" },
    ["taskId", "round", "conformance"]);
  const result = { ...base, verdict: parsed.verdict, culprit: parsed.culprit, blocking: parsed.blocking, appended };
  if (accepted)
    return commit
      ? committed(commit, cwd, { verdict: parsed.verdict, round, retry, findingsPath: findingsRel, blocking: parsed.blocking, culprit: parsed.culprit }, appended)
      : { ...result, action: "accepted" };

  // The ledger line's own stamp is the event's time, so a re-run that finds that line writes the
  // same row and is skipped, while a later round's rejection — a new line, a review round later and
  // so never within the same second — is not.
  row("event", { event: "review-reject", stage: "execution", task, culprit: parsed.culprit, attributedBy: "coordinator", ts: line.stamp },
    ["event", "task", "ts"]);
  if (!loopId) return { ...result, action: "rejected" };
  return { ...result, action: "needs-user", reason: "review loop exhausted-unresolved", loopId };
}

// A failed commit is runTaskScript's failure output, with the recorded verdict beside the error.
function verdictOrCommitFailure(argv) {
  try {
    return verdict(argv);
  } catch (err) {
    if (!(err instanceof CommitFailed)) throw err;
    const usage = err.cause instanceof UsageError;
    process.exitCode = usage ? 2 : 3;
    return {
      ok: false, action: usage ? "usage-error" : "environment-error",
      error: `task-verdict: ${err.message}`, verdict: err.verdictFields, appended: err.appended,
    };
  }
}

if (isMain(import.meta.url, process.argv[1])) runTaskScript("task-verdict", () => verdictOrCommitFailure(process.argv.slice(2)));
