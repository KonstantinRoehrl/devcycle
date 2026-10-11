#!/usr/bin/env node
// Called once the implementer's envelope returns: confirms the report exists and carries its
// evidence line, runs the two report lints a reviewer would otherwise spend a round on, and writes
// the `report-received` ledger line and the `dispatch` run-record row for the task's latest
// dispatch. The envelope's `status:` arrives as --status, since the report itself carries none.
// Contract: references/ledger.md § Task scripts; resume rows and retry caps: references/resume.md.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { atomicWrite } from "./atomic-write.mjs";
import { authoredClaimsLeg } from "./authored-claims-check.mjs";
import { gitToplevel } from "./git-identity.mjs";
import { isMain } from "./is-main.mjs";
import { now } from "./stamp.mjs";
import {
  UsageError, appendLedgerLine, appendRunRecordOnce, checkIds, latestKeyed, ledgerKey, retryCount, runTaskScript,
  taskFlags, workTreeRoot,
} from "./task-ledger.mjs";

const FLAGS = {
  "--run": "value", "--task": "value", "--report": "value", "--status": "value", "--agent-type": "value",
  "--model": "value", "--model-source": "value", "--agent-id": "value", "--ledger": "value",
};
const REQUIRED = ["--run", "--task", "--report", "--status", "--agent-type", "--model", "--model-source"];
const EVIDENCE_COMPLETENESS = fileURLToPath(new URL("./evidence-completeness-check.mjs", import.meta.url));
// The report shape's evidence line (references/evidence.md § File-backed evidence); its absence
// is the "mismatched" half of today's missing-report rejection, not a lint finding.
const EVIDENCE_LINE_RE = /^-\s*Evidence:/m;
const MISSING = "rejected (missing report file)";
const BOUNCE = "rejected (intake bounce)";
const RETRY_CAP = 2;

// Both lints over the report, as one list of finding lines; evidence-completeness-check runs as
// the CLI it is (it has no importable entry), from the checkout root its relative paths assume.
function lintFindings(root, reportRel, text) {
  const findings = authoredClaimsLeg(text, { planPath: reportRel }).findings.map((f) => `authored-claims-check: ${f}`);
  const ec = spawnSync(process.execPath, [EVIDENCE_COMPLETENESS, reportRel], { cwd: root, encoding: "utf8" });
  if (ec.status !== 0) findings.push(...ec.stderr.split("\n").filter(Boolean));
  return findings;
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
  const findings = lintFindings(root, reportRel, text);
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
  return { ...base, action: "review", appended };
}

if (isMain(import.meta.url, process.argv[1])) runTaskScript("task-intake", () => intake(process.argv.slice(2)));
