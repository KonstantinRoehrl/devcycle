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

test("intake holds the report's cmd: to the task's gate, read through the ledger's plan", () => {
  const f = fixture();
  writeInto(f.repo, "docs/plan.md", ["# P", "", "**Verification gate:** `npm run gate`", "",
    "### Task 5: T", "**Files:**", "- Modify: src/a.mjs", "**Evidence:** red-green", "**Quality constraints:** none", "",
    "## Dispatch Map", "", "- Wave 1: Task 5", ""].join("\n"));
  writeInto(f.repo, ".devcycle/reports/5.md", report());
  const r = intake(f);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.action, "bounce");
  assert.ok(r.out.findings.some((x) => /cmd: is not the task's gate command — gate: npm run gate \| cmd: npm test/.test(x)), r.out.findings.join("\n"));
});

const IMPLEMENTER_BRIEF = [
  "# Implementer brief — Task 5", "", "**Task id:** 5", "", "## Global Constraints", "", "- Keep the CLI contract.", "",
  "## Quality Constraints (this task's)", "", "- QC1 — Reuse the repo's owners.", "", "### Task 5: T", "", "**Files:**",
  "- Modify: src/a.mjs", "- Test: tests/a.test.mjs", "**Evidence:** red-green", "**Quality constraints:** QC1", "",
  "- [ ] step one", "", "**Gate command:** `npm test`", "",
].join("\n");

// A task the ledger's plan names, with its implementer brief where task-dispatch wrote it.
function planned() {
  const f = fixture();
  writeInto(f.repo, "docs/plan.md", ["# P", "", "**Verification gate:** `npm test`", "", "### Task 5: T", "**Files:**",
    "- Modify: src/a.mjs", "- Test: tests/a.test.mjs", "**Evidence:** red-green", "**Quality constraints:** QC1", "",
    "## Dispatch Map", "", "- Wave 1: Task 5", ""].join("\n"));
  writeInto(f.repo, ".devcycle/briefs/5-implementer.md", IMPLEMENTER_BRIEF);
  writeInto(f.repo, ".devcycle/reports/5.md", report());
  return f;
}
const ledgerText = ({ repo }) => readFileSync(join(repo, ".devcycle/ledger.md"), "utf8");

test("--compose-review writes the reviewer brief and dispatches the task's next review round", () => {
  const f = planned();
  const r = intake(f, ["--compose-review"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.action, "review");
  assert.deepEqual(
    [r.out.reviewBriefPath, r.out.findingsPath, r.out.reviewRound],
    [".devcycle/briefs/5-reviewer-round-1.md", ".devcycle/findings/5-round-1.md", 1],
  );
  assert.deepEqual(r.out.appended, ["5/report-received/0/0", "rr:dispatch", "5/review-round/1/0"]);
  assert.match(ledgerTail(f), / task=5 event=review-round outcome=round 1 ref=\.devcycle\/briefs\/5-reviewer-round-1\.md key=5\/review-round\/1\/0$/);
  assert.equal(readFileSync(join(f.repo, r.out.reviewBriefPath), "utf8"), [
    "# Task-reviewer brief — Task 5, round 1",
    "",
    "**Task id:** 5",
    "**Round:** 1",
    "**Evidence class:** red-green",
    "",
    "Review task 5's uncommitted diff against its implementer brief. Read-only, apart from writing your findings file.",
    "",
    "- The implementer brief (task steps, pinned interfaces, constraints): `.devcycle/briefs/5-implementer.md`",
    "- The implementer's report: `.devcycle/reports/5.md`",
    "- Evidence files: `.devcycle/evidence/5-before.txt` and `.devcycle/evidence/5-after.txt`",
    "- The task's files:",
    "  - `src/a.mjs`",
    "  - `tests/a.test.mjs`",
    "",
    "Produce the diff yourself: first `git add -N` the task's new (untracked) files from the list above, or they are " +
      "invisible to diff, then `git diff -U10 HEAD -- <the files above>`. Other tasks may be in flight in this working " +
      "tree; judge only these files.",
    "",
    "Write your verdict block to `.devcycle/findings/5-round-1.md` in the shape `\"$(devcycle-root)/references/evidence.md\"` " +
      "§ Reviewer verdicts defines, and return only the task-reviewer envelope.",
    "",
    "## Global Constraints",
    "",
    "- Keep the CLI contract.",
    "",
    "## Quality Constraints (this task's)",
    "",
    "- QC1 — Reuse the repo's owners.",
    "",
    "**Quality constraints:** QC1",
    "",
  ].join("\n"));
});

test("a --compose-review re-run points at the round already dispatched and writes nothing", () => {
  const f = planned();
  const first = intake(f, ["--compose-review"]);
  assert.equal(first.out.reviewBriefPath, ".devcycle/briefs/5-reviewer-round-1.md");
  const brief = readFileSync(join(f.repo, first.out.reviewBriefPath), "utf8");
  writeInto(f.repo, first.out.findingsPath, "Verdict: accept\n");
  const ledgerBefore = ledgerText(f);
  const again = intake(f, ["--compose-review"]);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(again.out.appended, []);
  assert.deepEqual(
    [again.out.reviewBriefPath, again.out.findingsPath, again.out.reviewRound],
    [first.out.reviewBriefPath, first.out.findingsPath, 1],
  );
  assert.equal(ledgerText(f), ledgerBefore);
  assert.equal(readFileSync(join(f.repo, first.out.findingsPath), "utf8"), "Verdict: accept\n");
  assert.deepEqual(readdirSync(join(f.repo, ".devcycle/findings")), ["5-round-1.md"]);
  assert.equal(readFileSync(join(f.repo, first.out.reviewBriefPath), "utf8"), brief);
});

test("a later round's brief names the fix-pass brief and the rejection, and keeps the first brief's constraints", () => {
  const f = planned();
  appendFileSync(join(f.repo, ".devcycle/ledger.md"), [
    `- [${STARTED}] task=5 event=report-received outcome=complete ref=.devcycle/reports/5.md key=5/report-received/0/0`,
    `- [${STARTED}] task=5 event=review-round outcome=round 1 ref=.devcycle/briefs/5-reviewer-round-1.md key=5/review-round/1/0`,
    `- [${STARTED}] task=5 event=review-verdict outcome=rejected ref=.devcycle/findings/5-round-1.md key=5/review-verdict/1/0`,
    `- [${STARTED}] task=5 event=dispatched outcome=implementer retry 1 ref=.devcycle/briefs/5-implementer-round-1.md key=5/dispatched/1/1`,
    "",
  ].join("\n"));
  writeInto(f.repo, ".devcycle/briefs/5-implementer-round-1.md", "# Implementer fix pass — Task 5, round 1\n");
  const r = intake(f, ["--compose-review"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([r.out.round, r.out.reviewRound, r.out.reviewBriefPath], [1, 2, ".devcycle/briefs/5-reviewer-round-2.md"]);
  const brief = readFileSync(join(f.repo, r.out.reviewBriefPath), "utf8");
  assert.match(brief, /^- The implementer brief \(task steps, pinned interfaces, constraints\): `\.devcycle\/briefs\/5-implementer\.md`$/m);
  assert.match(brief, /^- The latest fix-pass brief: `\.devcycle\/briefs\/5-implementer-round-1\.md`$/m);
  assert.match(brief, /^- Round 1 was rejected by `\.devcycle\/findings\/5-round-1\.md`: confirm each blocking finding there is resolved$/m);
  assert.match(brief, /^Write your verdict block to `\.devcycle\/findings\/5-round-2\.md` /m);
  assert.match(brief, /^- QC1 — Reuse the repo's owners\.$/m);
});

test("--compose-review on a bounce writes no review round and adds no review fields", () => {
  const f = planned();
  writeInto(f.repo, ".devcycle/reports/5.md", report("renamed src/a.mjs:12 for clarity"));
  const r = intake(f, ["--compose-review"]);
  assert.equal(r.out.action, "bounce");
  assert.equal("reviewBriefPath" in r.out, false);
  assert.doesNotMatch(ledgerText(f), /event=review-round/);
  assert.equal(existsSync(join(f.repo, ".devcycle/briefs/5-reviewer-round-1.md")), false);
});

// The brief a task-dispatch writes for `brief`, then the reviewer brief --compose-review composes from it.
function composedFrom(brief) {
  const f = planned();
  writeInto(f.repo, ".devcycle/briefs/5-implementer.md", brief);
  const r = intake(f, ["--compose-review"]);
  assert.equal(r.status, 0, r.stderr);
  return readFileSync(join(f.repo, r.out.reviewBriefPath), "utf8");
}

test("the reviewer brief carries constraints written as bold labels with bullets, and stops at the next block", () => {
  const brief = composedFrom([
    "# Implementer brief — Task 5", "", "**Task id:** 5", "",
    "**Global constraints:**", "- Keep the CLI contract.", "- No new dependencies.", "",
    "**Quality constraints:** QC1", "- QC1 — Reuse the repo's owners.", "**Files:**", "- Modify: src/a.mjs", "",
    "- [ ] step one", "", "**Gate command:** `npm test`", "",
  ].join("\n"));
  assert.match(brief, /^\*\*Global constraints:\*\*\n- Keep the CLI contract\.\n- No new dependencies\.$/m);
  assert.match(brief, /^\*\*Quality constraints:\*\* QC1\n- QC1 — Reuse the repo's owners\.$/m);
  assert.doesNotMatch(brief, /none in the implementer brief|Modify: src\/a\.mjs\n[\s\S]*step one|Gate command/);
  assert.doesNotMatch(brief, /^- \[ \] step one$/m);
});

test("a brief whose constraints are in no recognised form never claims it has none", () => {
  const brief = composedFrom("# Implementer brief — Task 5\n\n**Task id:** 5\n\nConstraints: keep the CLI contract.\n\n- [ ] step one\n");
  assert.doesNotMatch(brief, /none in the implementer brief/);
  assert.match(brief, /^\*\*Constraints:\*\* none extracted — read the implementer brief for constraints$/m);
});
