import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { makeRepo, writeInto } from "./helpers.mjs";

const SCRIPT = new URL("../../scripts/task-intake.mjs", import.meta.url).pathname;
const RUN = "0123456789abcdef";
const PREAMBLE = "Plan: `docs/plan.md`\nBranch: `feat/x` (cut from `dev` at `abc1234`)\nProfile: `standard` (evidence tail 20 lines)\n";
const STARTED = "2026-10-08T10:00:00Z";
// A node --test summary, assembled from fragments as the evidence-completeness suite does.
const SUMMARY = ["ℹ pass 3", "ℹ fail 0"].join("\n");

const dispatchedLine = (retry, round = 0) =>
  `- [${STARTED}] task=5 event=dispatched outcome=implementer retry ${retry} ref=.devcycle/briefs/5-implementer.md key=5/dispatched/${round}/${retry}\n`;

function fixture() {
  const repo = makeRepo();
  writeInto(repo, ".devcycle/ledger.md", PREAMBLE + dispatchedLine(0));
  writeInto(repo, ".devcycle/dispatch/5-implementer-0-0.json", JSON.stringify({ startedAt: STARTED }) + "\n");
  writeInto(repo, ".devcycle/evidence/5-before.txt", "# devcycle-cmd: npm test\nnot ok 1 - adds\n");
  writeInto(repo, ".devcycle/evidence/5-after.txt", `# devcycle-cmd: npm test\n${SUMMARY}\n`);
  return { repo, runsDir: makeTempDir("task-intake-runs-") };
}

const report = (deviations = "none") =>
  "## Task report\n- Files changed: src/a.mjs\n- Evidence: red-green | cmd: npm test\n" +
  "- Before: .devcycle/evidence/5-before.txt (exit 1)\n- After: .devcycle/evidence/5-after.txt (exit 0)\n" +
  `- Deviations: ${deviations}\n`;

function intake({ repo, runsDir }, extra = [], status = "complete") {
  const env = { ...process.env, DEVCYCLE_RUNS_DIR: runsDir, CLAUDE_DOCTOR_PROJECTS: makeTempDir("task-intake-projects-") };
  delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync(process.execPath, [SCRIPT, "--run", RUN, "--task", "5", "--report", ".devcycle/reports/5.md",
    "--status", status, "--agent-type", "devcycle:implementer", "--model", "claude-sonnet-5-5", "--model-source", "explicit",
    ...extra], { cwd: repo, encoding: "utf8", env });
  assert.notEqual(r.stdout, "", `no JSON object on stdout — stderr: ${r.stderr}`);
  return { status: r.status, out: JSON.parse(r.stdout), stderr: r.stderr };
}
const ledgerTail = ({ repo }) => readFileSync(join(repo, ".devcycle/ledger.md"), "utf8").trim().split("\n").at(-1);
const rows = ({ runsDir }) => {
  const [slug] = readdirSync(runsDir);
  return slug ? readFileSync(join(runsDir, slug, `${RUN}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
};

test("a clean report: report-received complete and a dispatch row carrying every required field", () => {
  const f = fixture();
  writeInto(f.repo, ".devcycle/reports/5.md", report());
  const r = intake(f, ["--agent-id", "agent-a12394549e76f104a"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.action, "review");
  assert.deepEqual(r.out.appended, ["5/report-received/0/0", "rr:dispatch"]);
  assert.match(ledgerTail(f), / task=5 event=report-received outcome=complete ref=\.devcycle\/reports\/5\.md key=5\/report-received\/0\/0$/);
  const [row] = rows(f);
  assert.deepEqual({ ...row, endedAt: "<now>" }, {
    kind: "dispatch", runId: RUN, taskId: "5", agentType: "devcycle:implementer", model: "claude-sonnet-5-5",
    modelSource: "explicit", startedAt: STARTED, endedAt: "<now>", outcome: "complete", reviewRound: 0, retryIndex: 0,
    agentId: "agent-a12394549e76f104a",
  });
  assert.match(row.endedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test("a re-run after a crash appends neither the line nor the row again", () => {
  const f = fixture();
  writeInto(f.repo, ".devcycle/reports/5.md", report());
  intake(f);
  const again = intake(f);
  assert.equal(again.out.action, "review");
  assert.deepEqual(again.out.appended, []);
  assert.equal(rows(f).length, 1);
  assert.equal(readFileSync(join(f.repo, ".devcycle/ledger.md"), "utf8").match(/event=report-received/g).length, 1);
});

test("a missing report, or one without its Evidence line, is today's missing-report rejection with no dispatch row", () => {
  const f = fixture();
  const r = intake(f);
  assert.equal(r.out.action, "missing-report");
  assert.match(ledgerTail(f), / event=report-received outcome=rejected \(missing report file\) ref=\.devcycle\/reports\/5\.md key=5\/report-received\/0\/0$/);
  assert.deepEqual(rows(f), []);
  appendFileSync(join(f.repo, ".devcycle/ledger.md"), dispatchedLine(1));
  writeInto(f.repo, ".devcycle/reports/5.md", "## Task report\n- Files changed: src/a.mjs\n");
  assert.equal(intake(f).out.action, "missing-report");
});

test("the third missing report for a task is a user decision, not another dispatch", () => {
  const f = fixture();
  const actions = [0, 1, 2].map((retry) => {
    if (retry) appendFileSync(join(f.repo, ".devcycle/ledger.md"), dispatchedLine(retry));
    return intake(f).out.action;
  });
  assert.deepEqual(actions, ["missing-report", "missing-report", "needs-user"]);
});

test("a lint failure bounces back to the implementer with its findings, writing no review round", () => {
  const f = fixture();
  writeInto(f.repo, ".devcycle/reports/5.md", report("renamed src/a.mjs:12 for clarity"));
  const r = intake(f);
  assert.equal(r.out.action, "bounce");
  assert.match(r.out.findings.join("\n"), /authored-claims-check: .*unverified line-reference claim "src\/a\.mjs:12"/);
  assert.equal(r.out.findingsPath, ".devcycle/findings/5-intake-0-0.md");
  assert.match(readFileSync(join(f.repo, r.out.findingsPath), "utf8"), /src\/a\.mjs:12/);
  assert.match(ledgerTail(f), / outcome=rejected \(intake bounce\) ref=\.devcycle\/findings\/5-intake-0-0\.md key=5\/report-received\/0\/0$/);
  assert.equal(rows(f)[0].outcome, "rejected");
  assert.doesNotMatch(readFileSync(join(f.repo, ".devcycle/ledger.md"), "utf8"), /event=review-(round|verdict)/);
});

test("an evidence-completeness failure bounces too", () => {
  const f = fixture();
  writeInto(f.repo, ".devcycle/reports/5.md", report().replace(" (exit 0)", ""));
  const r = intake(f);
  assert.equal(r.out.action, "bounce");
  assert.match(r.out.findings.join("\n"), /^evidence-completeness-check: /m);
});

test("the third bounce for a task is a user decision", () => {
  const f = fixture();
  writeInto(f.repo, ".devcycle/reports/5.md", report("renamed src/a.mjs:12 for clarity"));
  const actions = [0, 1, 2].map((retry) => {
    if (retry) appendFileSync(join(f.repo, ".devcycle/ledger.md"), dispatchedLine(retry));
    return intake(f).out.action;
  });
  assert.deepEqual(actions, ["bounce", "bounce", "needs-user"]);
});

test("status: blocked is a user decision, recorded as blocked in the ledger and the dispatch row", () => {
  const f = fixture();
  const r = intake(f, [], "blocked");
  assert.equal(r.out.action, "needs-user");
  assert.match(ledgerTail(f), / event=report-received outcome=blocked ref=none key=5\/report-received\/0\/0$/);
  assert.equal(rows(f)[0].outcome, "blocked");
});

test("a fix-pass dispatch's report is taken against that dispatch's round and retry, start time from the ledger when no start file exists", () => {
  const f = fixture();
  appendFileSync(join(f.repo, ".devcycle/ledger.md"), dispatchedLine(1, 1));
  writeInto(f.repo, ".devcycle/reports/5.md", report());
  const r = intake(f);
  assert.deepEqual([r.out.round, r.out.retry], [1, 1]);
  assert.deepEqual([rows(f)[0].reviewRound, rows(f)[0].retryIndex, rows(f)[0].startedAt], [1, 1, STARTED]);
});

test("usage and environment errors", () => {
  const f = fixture();
  const bad = intake(f, [], "done");
  assert.equal(bad.status, 2);
  assert.match(bad.out.error, /--status must be complete or blocked/);
  const noDispatch = fixture();
  writeInto(noDispatch.repo, ".devcycle/ledger.md", PREAMBLE);
  const env = intake(noDispatch);
  assert.equal(env.status, 3);
  assert.match(env.out.error, /no dispatched line for task 5/);
  assert.equal(existsSync(join(noDispatch.repo, ".devcycle/findings")), false);
});
