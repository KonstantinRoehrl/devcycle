#!/usr/bin/env node
// Called once the implementer's envelope returns: confirms the report exists and carries its
// evidence line, runs the two report lints a reviewer would otherwise spend a round on, and writes
// the `report-received` ledger line and the `dispatch` run-record row for the task's latest
// dispatch. The envelope's `status:` arrives as --status, since the report itself carries none.
// With --compose-review, a report bound for review also gets its reviewer brief and dispatch here.
// Contract: references/ledger.md § Task scripts; resume rows and retry caps: references/resume.md.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { atomicWrite } from "./atomic-write.mjs";
import { authoredClaimsLeg } from "./authored-claims-check.mjs";
import { gitToplevel } from "./git-identity.mjs";
import { isMain } from "./is-main.mjs";
import { field } from "./md-field.mjs";
import { now } from "./stamp.mjs";
import { dispatch, roundFindingsPath } from "./task-dispatch.mjs";
import {
  UsageError, appendLedgerLine, appendRunRecordOnce, checkIds, latestKeyed, ledgerKey, nextReviewRound, retryCount,
  runTaskScript, taskEntries, taskFiles, taskFlags, taskGate, workTreeRoot,
} from "./task-ledger.mjs";

const FLAGS = {
  "--run": "value", "--task": "value", "--report": "value", "--status": "value", "--agent-type": "value",
  "--model": "value", "--model-source": "value", "--agent-id": "value", "--ledger": "value", "--compose-review": "none",
};
const REQUIRED = ["--run", "--task", "--report", "--status", "--agent-type", "--model", "--model-source"];
const EVIDENCE_COMPLETENESS = fileURLToPath(new URL("./evidence-completeness-check.mjs", import.meta.url));
// The report shape's evidence line (references/evidence.md § File-backed evidence); its absence
// is the "mismatched" half of today's missing-report rejection, not a lint finding.
const EVIDENCE_LINE_RE = /^-\s*Evidence:/m;
const MISSING = "rejected (missing report file)";
const BOUNCE = "rejected (intake bounce)";
const RETRY_CAP = 2;

// Both lints over the report, as one list of finding lines; evidence-completeness-check runs against
// the task's gate as the CLI it is (it has no importable entry), from the checkout root its relative
// paths assume.
function lintFindings(root, reportRel, text, { task, ledger }) {
  const findings = authoredClaimsLeg(text, { planPath: reportRel }).findings.map((f) => `authored-claims-check: ${f}`);
  const args = [EVIDENCE_COMPLETENESS, reportRel, "--task", task, "--ledger", ledger];
  const ec = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
  if (ec.status !== 0) findings.push(...ec.stderr.split("\n").filter(Boolean));
  return findings;
}

// The task's constraints, verbatim from its implementer brief, where playbooks/executing-waves.md
// step 2 slices them in, under whatever form it gives them: its Global/Quality Constraints sections
// and its `**Global constraints:**` / `**Quality constraints:**` labels. A section runs to the next
// heading; a label's block runs over the bullets directly beneath it, to the next blank line, heading
// or bold label. The tail task-dispatch appends (the gate line, the capture lines) is no constraint.
const CONSTRAINTS_HEADING_RE = /^## (Global|Quality) Constraints\b/i;
const CONSTRAINTS_LABEL_RE = /^\*\*(Global|Quality) constraints:\*\*/i;
const BOLD_LABEL_RE = /^\*\*[^*]+:\*\*/;
function constraintsOf(briefText) {
  const kept = [];
  let inSection = false;
  let inLabelBlock = false;
  const lines = briefText.split("\n");
  const tailAt = lines.findIndex((line) => line.startsWith("**Gate command:**") || line.startsWith("**Capture command:**"));
  for (const line of tailAt < 0 ? lines : lines.slice(0, tailAt)) {
    if (/^#{1,3} /.test(line)) inSection = CONSTRAINTS_HEADING_RE.test(line);
    if (!line.trim() || /^#{1,3} /.test(line) || BOLD_LABEL_RE.test(line)) inLabelBlock = CONSTRAINTS_LABEL_RE.test(line);
    if (inSection || inLabelBlock) kept.push(line);
  }
  return kept.join("\n").trim();
}

// A report's `- Before:`/`- After:` value is "<path> (exit <n>)" (references/evidence.md § Task report).
const evidenceFile = (report, key) => field(report, key)?.split(/\s+/)[0].replaceAll("`", "") || null;

// The reviewer's instruction to write its verdict, and to confirm the file exists before it returns.
const verdictParagraph = (code, findingsAbs) =>
  `Write your verdict block to ${code(findingsAbs)} in the shape \`"$(devcycle-root)/references/evidence.md"\` ` +
  "§ Reviewer verdicts defines. The file is required: an unwritten one, or one with no verdict line that shape admits, " +
  `costs this round a re-dispatch. Run \`ls -la ${findingsAbs}\` before you return, and return only the task-reviewer envelope.`;

// The reviewer brief playbooks/executing-waves.md step 5 prescribes, from the ledger, the plan and
// the two files the implementer left: no coordinator slicing between intake and the review, naming
// the findings file by absolute path, which the reviewer must confirm it wrote.
function reviewerBrief({ root, ledger, task, round, reportRel, report, findingsPath, dispatched }) {
  const first = latestKeyed(ledger, task, "dispatched", { round: 0 }) ?? dispatched;
  const firstAbs = join(root, first.ref);
  const constraints = existsSync(firstAbs) ? constraintsOf(readFileSync(firstAbs, "utf8")) : "";
  const files = [...(taskFiles(ledger, task) ?? [])];
  const evidenceClass = taskGate(ledger, task)?.evidenceClass;
  const rejected = round > 1 ? latestKeyed(ledger, task, "review-verdict", { round: round - 1 }) : null;
  const evidence = ["Before", "After"].map((key) => evidenceFile(report, key)).filter(Boolean);
  const code = (path) => `\`${path}\``;
  const findingsAbs = join(root, findingsPath);
  return [
    `# Task-reviewer brief — Task ${task}, round ${round}`,
    "",
    `**Task id:** ${task}`,
    `**Round:** ${round}`,
    ...(evidenceClass ? [`**Evidence class:** ${evidenceClass}`] : []),
    "",
    `Review task ${task}'s uncommitted diff against its implementer brief. Read-only, apart from writing your findings file.`,
    "",
    `- The implementer brief (task steps, pinned interfaces, constraints): ${code(first.ref)}`,
    ...(dispatched.ref !== first.ref ? [`- The latest fix-pass brief: ${code(dispatched.ref)}`] : []),
    ...(rejected ? [`- Round ${round - 1} was rejected by ${code(rejected.ref)}: confirm each blocking finding there is resolved`] : []),
    `- The implementer's report: ${code(reportRel)}`,
    `- Evidence files: ${evidence.length ? evidence.map(code).join(" and ") : "none named in the report"}`,
    "- The task's files:",
    ...(files.length ? files.map((f) => `  - ${code(f)}`) : ["  - the implementer brief's **Files:** list (the plan names none for this task)"]),
    "",
    "Produce the diff yourself: first `git add -N` the task's new (untracked) files from the list above, or they are " +
      "invisible to diff, then `git diff -U10 HEAD -- <the files above>`. Other tasks may be in flight in this working " +
      "tree; judge only these files.",
    "",
    verdictParagraph(code, findingsAbs),
    "",
    constraints || "**Constraints:** none extracted — read the implementer brief for constraints",
    "",
  ].join("\n");
}

// The review step 4 hands on, dispatched here through task-dispatch's own reviewer path, so its
// ledger line and findings set-aside stay that script's. A round already dispatched since the latest
// report makes this a re-run: it points at that round's brief and writes nothing.
function composeReview({ root, ledger, run, task, cwd, ledgerFlag, reportRel, report, dispatched }) {
  const entries = taskEntries(ledger, task);
  const round = nextReviewRound(entries);
  const findingsPath = roundFindingsPath(task, round);
  const since = entries.slice(entries.findLastIndex((e) => e.event === "report-received") + 1);
  const sent = since.find((e) => e.event === "review-round" && Number(e.key?.split("/")[2]) === round);
  if (sent) return { reviewBriefPath: sent.ref, findingsPath, reviewRound: round, appended: [] };
  const brief = reviewerBrief({ root, ledger, task, round, reportRel, report, findingsPath, dispatched });
  const argv = ["--run", run, "--task", task, "--role", "reviewer", "--round", String(round), ...(ledgerFlag ? ["--ledger", ledgerFlag] : [])];
  const { briefPath, appended } = dispatch(argv, brief, cwd);
  return { reviewBriefPath: briefPath, findingsPath, reviewRound: round, appended };
}

export function intake(argv, cwd = process.cwd()) {
  const flags = taskFlags(argv, FLAGS, REQUIRED);
  const { "--run": run, "--task": task, "--status": status, "--model-source": modelSource } = flags;
  checkIds({ run, task });
  if (!["complete", "blocked"].includes(status)) throw new UsageError(`--status must be complete or blocked, got "${status}"`);
  if (!["explicit", "inherited"].includes(modelSource))
    throw new UsageError(`--model-source must be explicit or inherited, got "${modelSource}"`);

  const root = workTreeRoot(cwd);
  const ledger = flags["--ledger"] ?? join(root, ".devcycle/ledger.md");
  const dispatched = latestKeyed(ledger, task, "dispatched");
  if (!dispatched) throw new Error(`no dispatched line for task ${task} in ${ledger} — dispatch through task-dispatch.mjs first`);
  const { round, retry } = dispatched;
  const reportRel = relative(root, resolve(cwd, flags["--report"]));
  const reportAbs = join(root, reportRel);
  const text = existsSync(reportAbs) ? readFileSync(reportAbs, "utf8") : "";

  const appended = [];
  const ledgerLine = (outcome, ref) => {
    if (appendLedgerLine(ledger, { task, event: "report-received", outcome, ref, round, retry }).appended)
      appended.push(ledgerKey({ task, event: "report-received", round, retry }));
  };
  const dispatchRow = (outcome) => {
    const startedFile = join(root, `.devcycle/dispatch/${task}-implementer-${round}-${retry}.json`);
    const startedAt = existsSync(startedFile) ? JSON.parse(readFileSync(startedFile, "utf8")).startedAt : dispatched.stamp;
    const fields = {
      taskId: task, agentType: flags["--agent-type"], model: flags["--model"], modelSource, startedAt, endedAt: now(),
      outcome, reviewRound: round, retryIndex: retry,
      ...(flags["--agent-id"] ? { agentId: flags["--agent-id"] } : {}),
    };
    const toplevel = gitToplevel(root);
    if (appendRunRecordOnce({ toplevel, run, kind: "dispatch", fields, matchKeys: ["taskId", "reviewRound", "retryIndex"] }).appended)
      appended.push("rr:dispatch");
  };
  const capped = (prefix) => retryCount(ledger, task, prefix) > RETRY_CAP;
  const base = { task, round, retry, reportPath: reportRel };

  if (status === "blocked") {
    ledgerLine("blocked", existsSync(reportAbs) ? reportRel : "none");
    dispatchRow("blocked");
    return { ...base, action: "needs-user", reason: "implementer reported status: blocked", appended };
  }
  if (!text.trim() || !EVIDENCE_LINE_RE.test(text)) {
    ledgerLine(MISSING, reportRel);
    return capped(MISSING)
      ? { ...base, action: "needs-user", reason: "retry cap: a third missing report file", appended }
      : { ...base, action: "missing-report", appended };
  }
  const findings = lintFindings(root, reportRel, text, { task, ledger });
  if (findings.length) {
    const findingsRel = `.devcycle/findings/${task}-intake-${round}-${retry}.md`;
    mkdirSync(join(root, ".devcycle/findings"), { recursive: true });
    atomicWrite(join(root, findingsRel), `# Intake findings — task ${task}\n\n${findings.map((f) => `- ${f}`).join("\n")}\n`);
    ledgerLine(BOUNCE, findingsRel);
    dispatchRow("rejected");
    return capped(BOUNCE)
      ? { ...base, action: "needs-user", reason: "retry cap: a third intake bounce", findings, findingsPath: findingsRel, appended }
      : { ...base, action: "bounce", findings, findingsPath: findingsRel, appended };
  }
  ledgerLine("complete", reportRel);
  dispatchRow("complete");
  if (!flags["--compose-review"]) return { ...base, action: "review", appended };
  const review = composeReview({ root, ledger, run, task, cwd, ledgerFlag: flags["--ledger"], reportRel, report: text, dispatched });
  return { ...base, action: "review", ...review, appended: [...appended, ...review.appended] };
}

if (isMain(import.meta.url, process.argv[1])) runTaskScript("task-intake", () => intake(process.argv.slice(2)));
