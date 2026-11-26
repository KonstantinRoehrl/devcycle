import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { commitAll, makeRepo, writeInto } from "./helpers.mjs";
import { acquireDriveLock, driveTokenHash, releaseDriveLock } from "../../scripts/drive-lock.mjs";

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

function intake({ repo, runsDir }, extra = [], status = "complete", extraEnv = {}) {
  const env = { ...process.env, DEVCYCLE_RUNS_DIR: runsDir, CLAUDE_DOCTOR_PROJECTS: makeTempDir("task-intake-projects-") };
  delete env.CLAUDE_CODE_SESSION_ID;
  Object.assign(env, extraEnv);
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
  assert.deepEqual(routed(r), [null, null, "model session (auto: no file list)"]);
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

test("a missing report, or one without its Evidence line, is a missing-report rejection with a rejected dispatch row", () => {
  const f = fixture();
  const r = intake(f);
  assert.equal(r.out.action, "missing-report");
  assert.match(ledgerTail(f), / event=report-received outcome=rejected \(missing report file\) ref=\.devcycle\/reports\/5\.md key=5\/report-received\/0\/0$/);
  assert.deepEqual(rows(f).map((row) => [row.outcome, row.reviewRound, row.retryIndex, row.model]), [["rejected", 0, 0, "claude-sonnet-5-5"]]);
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
  const r = intake(f, ["--compose-review", "--orchestrator", "claude-opus-5-5"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.action, "review");
  assert.deepEqual(
    [r.out.reviewBriefPath, r.out.findingsPath, r.out.reviewRound],
    [".devcycle/briefs/5-reviewer-round-1.md", ".devcycle/findings/5-round-1.md", 1],
  );
  assert.deepEqual(r.out.appended, ["5/report-received/0/0", "rr:dispatch", "5/review-round/1/0"]);
  assert.match(ledgerTail(f), / task=5 event=review-round outcome=model fast:claude-sonnet-5-5 \(auto: lines=0, files=0\) ref=\.devcycle\/briefs\/5-reviewer-round-1\.md key=5\/review-round\/1\/0$/);
  // The scripts resolve the root through the git toplevel, which resolves symlinks.
  const findingsAbs = join(realpathSync(f.repo), ".devcycle/findings/5-round-1.md");
  const brief = readFileSync(join(f.repo, r.out.reviewBriefPath), "utf8");
  assert.match(brief, /The file is required: an unwritten one, or one with no verdict line that shape admits, costs this round a re-dispatch\. Run `ls -la [^`]+5-round-1\.md` before you return/);
  assert.equal(brief, [
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
    `Write your verdict block to \`${findingsAbs}\` in the shape \`"$(devcycle-root)/references/evidence.md"\` ` +
      "§ Reviewer verdicts defines. The file is required: an unwritten one, or one with no verdict line that shape admits, " +
      `costs this round a re-dispatch. Run \`ls -la ${findingsAbs}\` before you return, and return only the task-reviewer envelope.`,
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

test("the reviewer brief's constraints stop before the tail task-dispatch appends to a brief ending in a constraints section", () => {
  const f = planned();
  const cmd = "npm test -- a";
  writeInto(f.repo, ".devcycle/briefs/5-implementer.md", [
    "# Implementer brief — Task 5", "", "**Task id:** 5", "", "## Quality Constraints", "", "- QC1 — Reuse the repo's owners.", "",
    "**Gate command:** `npm test`",
    `**Capture command:** \`${cmd}\` — pass it as \`capture-evidence.mjs --cmd\` for both the before and the after capture (references/evidence.md § File-backed evidence owns the before/after rule), and copy this line into your report:`,
    `- Narrowing: ${cmd} — concurrent wave: siblings' uncommitted edits share the checkout; the whole gate runs at commit in an isolated worktree`, "",
  ].join("\n"));
  const r = intake(f, ["--compose-review"]);
  assert.equal(r.status, 0, r.stderr);
  const brief = readFileSync(join(f.repo, r.out.reviewBriefPath), "utf8");
  assert.match(brief, /## Quality Constraints\n\n- QC1 — Reuse the repo's owners\.\n/);
  assert.doesNotMatch(brief, /Capture command|Narrowing|Gate command/);
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
  assert.match(brief, /^Write your verdict block to `[^`]+\/\.devcycle\/findings\/5-round-2\.md` /m);
  assert.ok(brief.includes(`\`${join(realpathSync(f.repo), ".devcycle/findings/5-round-2.md")}\``));
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

// #412: the reviewer dispatch --compose-review runs in-process takes task-dispatch's driver guard.
test("--compose-review on waves the driver owns refuses the reviewer dispatch; a manual row or a stage after execution composes it", () => {
  const owned = planned();
  writeInto(owned.repo, ".devcycle/state.md", "# devcycle state\n- stage: execution\n- knobs: profile=standard executionMode=unattended\n");
  const refused = intake(owned, ["--compose-review"]);
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.out.error, /waves run under the driver/);
  assert.doesNotMatch(ledgerText(owned), /event=review-round/);
  assert.equal(existsSync(join(owned.repo, ".devcycle/briefs/5-reviewer-round-1.md")), false);
  const walked = planned();
  writeInto(walked.repo, ".devcycle/state.md",
    "# devcycle state\n- stage: execution\n- knobs: profile=standard executionMode=unattended\n- drive: manual chosen=2026-11-06T09:00:00Z via=answer\n");
  const composed = intake(walked, ["--compose-review"]);
  assert.equal(composed.status, 0, composed.stderr);
  assert.equal(composed.out.reviewBriefPath, ".devcycle/briefs/5-reviewer-round-1.md");
  // #431: the driver walks only execution, so at branch-review an auto row holds no fix dispatch.
  const after = planned();
  writeInto(after.repo, ".devcycle/state.md",
    "# devcycle state\n- stage: branch-review\n- knobs: profile=standard executionMode=unattended\n- drive: auto model=claude-sonnet-5-5 opted=2026-11-06T09:00:00Z via=knob\n");
  const postExecution = intake(after, ["--compose-review"]);
  assert.equal(postExecution.status, 0, postExecution.stderr);
  assert.equal(postExecution.out.reviewBriefPath, ".devcycle/briefs/5-reviewer-round-1.md");
});

test("--compose-review composes the reviewer dispatch for a session holding the live driver's token", () => {
  const token = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
  const driven = planned();
  const statePath = join(driven.repo, ".devcycle/state.md");
  writeInto(driven.repo, ".devcycle/state.md",
    "# devcycle state\n- stage: execution\n- knobs: profile=standard executionMode=unattended\n- drive: auto model=claude-sonnet-5-5 opted=2026-11-06T09:00:00Z via=knob\n");
  const { lock } = acquireDriveLock(driven.repo, { statePath, logPath: join(driven.repo, ".devcycle/drive.log"), tokenHash: driveTokenHash(token) });
  try {
    const composed = intake(driven, ["--compose-review"], "complete", { DEVCYCLE_DRIVE_TOKEN: token });
    assert.equal(composed.status, 0, composed.stderr);
    assert.equal(composed.out.reviewBriefPath, ".devcycle/briefs/5-reviewer-round-1.md");
  } finally {
    releaseDriveLock(driven.repo, lock);
  }
});

// The ledger's plan names `files` for task 5, each left as an untracked file of `lines` lines.
function plannedWith(files, lines = 1) {
  const f = planned();
  writeInto(f.repo, "docs/plan.md", ["# P", "", "**Verification gate:** `npm test`", "", "### Task 5: T", "**Files:**",
    ...files.map((path) => `- Modify: ${path}`), "**Evidence:** red-green", "**Quality constraints:** QC1", "",
    "## Dispatch Map", "", "- Wave 1: Task 5", ""].join("\n"));
  for (const path of files) writeInto(f.repo, path, "x\n".repeat(lines));
  return f;
}

// A transcript root whose session runs on `model`: the ceiling a pinned or pooled reviewer resolves under.
function orchestratedBy(model) {
  const projects = makeTempDir("task-intake-projects-");
  mkdirSync(join(projects, "-repo"), { recursive: true });
  writeFileSync(join(projects, "-repo", "sess-1.jsonl"), JSON.stringify({ type: "assistant", timestamp: STARTED, message: {
    model, content: [], usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 } } }) + "\n");
  return { CLAUDE_CODE_SESSION_ID: "sess-1", CLAUDE_DOCTOR_PROJECTS: projects };
}

const routed = (r) => [r.out.reviewModel, r.out.reviewDispatchModel, r.out.reviewDecision];

test("--compose-review routes the reviewer from the task's diff, tracked edits and new files both, and records the decision", () => {
  const f = planned();
  writeInto(f.repo, "src/a.mjs", "a\n");
  commitAll(f.repo, "chore: seed");
  writeInto(f.repo, "src/a.mjs", "a\nb\nc\n");
  writeInto(f.repo, "tests/a.test.mjs", "t1\nt2\n");
  const r = intake(f, ["--compose-review", "--orchestrator", "claude-opus-5-5"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(routed(r), ["claude-sonnet-5-5", "sonnet", "model fast:claude-sonnet-5-5 (auto: lines=4, files=2)"]);
  assert.match(ledgerTail(f), / event=review-round outcome=model fast:claude-sonnet-5-5 \(auto: lines=4, files=2\) ref=\.devcycle\/briefs\/5-reviewer-round-1\.md key=5\/review-round\/1\/0$/);
  assert.deepEqual(routed(intake(f, ["--compose-review", "--orchestrator", "claude-opus-5-5"])), routed(r));
});

test("an auto reviewer escalates to the session tier past 400 changed lines or 5 files, naming the limit crossed", () => {
  assert.deepEqual(routed(intake(plannedWith(["src/a.mjs"], 401), ["--compose-review", "--orchestrator", "claude-opus-5-5"])),
    [null, null, "model session (auto: escalated on lines=401)"]);
  const six = ["1", "2", "3", "4", "5", "6"].map((n) => `src/${n}.mjs`);
  assert.equal(intake(plannedWith(six), ["--compose-review", "--orchestrator", "claude-opus-5-5"]).out.reviewDecision, "model session (auto: escalated on files=6)");
  assert.equal(intake(plannedWith(six.slice(0, 5), 80), ["--compose-review", "--orchestrator", "claude-opus-5-5"]).out.reviewDecision, "model fast:claude-sonnet-5-5 (auto: lines=400, files=5)");
});

test("a pinned or pooled taskReviewerModel resolves through model-pool, one signal per limit crossed", () => {
  const pinned = plannedWith(["src/a.mjs"]);
  writeInto(pinned.repo, ".devcycle/state.md", "# devcycle state\n- stage: execution\n- knobs: profile=standard taskReviewerModel=claude-sonnet-5-5\n");
  const r = intake(pinned, ["--compose-review"], "complete", orchestratedBy("claude-opus-5-5"));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(routed(r), ["claude-sonnet-5-5", "sonnet", "model claude-sonnet-5-5 (pinned)"]);
  const pooled = plannedWith(["src/a.mjs"], 401);
  writeInto(pooled.repo, ".devcycle/state.md",
    "# devcycle state\n- stage: execution\n- knobs: profile=standard taskReviewerModel=claude-haiku-4-5,claude-sonnet-5-5\n");
  assert.deepEqual(routed(intake(pooled, ["--compose-review"], "complete", orchestratedBy("claude-opus-5-5"))),
    ["claude-sonnet-5-5", "sonnet", "model claude-sonnet-5-5 (pooled: rung 2/2)"]);
});

test("a pooled reviewer that crosses both the line and the file limit climbs two rungs", () => {
  const six = ["1", "2", "3", "4", "5", "6"].map((n) => `src/${n}.mjs`);
  const both = plannedWith(six, 70);
  writeInto(both.repo, ".devcycle/state.md",
    "# devcycle state\n- stage: execution\n- knobs: profile=standard taskReviewerModel=claude-haiku-4-5,claude-sonnet-5-5,claude-opus-5-5\n");
  assert.deepEqual(routed(intake(both, ["--compose-review"], "complete", orchestratedBy("claude-opus-5-5"))),
    ["claude-opus-5-5", "opus", "model claude-opus-5-5 (pooled: rung 3/3)"]);
});

test("the reviewer's diff measure counts a binary file as a changed file with no lines, and a last line with no newline as a line", () => {
  const binary = (last) => Buffer.from([0, 1, 2, 3, last]);
  const withBinaryEdit = () => {
    const f = planned();
    writeInto(f.repo, "src/a.mjs", binary(4));
    commitAll(f.repo, "chore: seed");
    writeInto(f.repo, "src/a.mjs", binary(5));
    return f;
  };
  assert.equal(intake(withBinaryEdit(), ["--compose-review", "--orchestrator", "claude-opus-5-5"]).out.reviewDecision, "model fast:claude-sonnet-5-5 (auto: lines=0, files=1)", "a binary-only diff");
  const beside = withBinaryEdit();
  writeInto(beside.repo, "tests/a.test.mjs", "t1\nt2");
  assert.equal(intake(beside, ["--compose-review", "--orchestrator", "claude-opus-5-5"]).out.reviewDecision, "model fast:claude-sonnet-5-5 (auto: lines=2, files=2)", "a binary file beside a new file with no trailing newline");
});

test("a tier or family word as --model is a usage error that names the fix and writes nothing", () => {
  for (const word of ["sonnet", "opus", "haiku", "session", "fast", "inherited"]) {
    const f = fixture();
    writeInto(f.repo, ".devcycle/reports/5.md", report());
    const before = readFileSync(join(f.repo, ".devcycle/ledger.md"), "utf8");
    const r = intake(f, ["--model", word]);
    assert.equal(r.status, 2, word);
    assert.match(r.out.error, new RegExp(`--model must be a model id such as claude-sonnet-5-5, got "${word}": pass the model task-dispatch printed, or this session's own model id when it printed null`));
    assert.equal(readFileSync(join(f.repo, ".devcycle/ledger.md"), "utf8"), before);
    assert.deepEqual(rows(f), []);
  }
  for (const id of ["claude-sonnet-5", "claude-haiku-4-5-20251001", "us.anthropic.claude-opus-4-6-v1:0"]) {
    const f = fixture();
    writeInto(f.repo, ".devcycle/reports/5.md", report());
    assert.equal(intake(f, ["--model", id]).status, 0, id);
  }
});

test("intake's review result carries the model task-dispatch resolves, with and without --compose-review", () => {
  const preview = intake(plannedWith(["src/a.mjs"], 2), ["--orchestrator", "claude-opus-5-5"]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.deepEqual(routed(preview), ["claude-sonnet-5-5", "sonnet", "model fast:claude-sonnet-5-5 (auto: lines=2, files=1)"]);
  assert.equal("reviewTier" in preview.out, false);
  const composed = intake(plannedWith(["src/a.mjs"], 2), ["--compose-review", "--orchestrator", "claude-opus-5-5"]);
  assert.equal(composed.status, 0, composed.stderr);
  assert.deepEqual(routed(composed), routed(preview));
});

test("a driven reviewer's ceiling is the drive row's model, whatever --orchestrator says", () => {
  const f = plannedWith(["src/a.mjs"], 401);
  writeInto(f.repo, ".devcycle/state.md",
    "# devcycle state\n- stage: branch-review\n- drive: auto model=claude-opus-5-5 opted=2026-11-26T09:00:00Z via=answer\n");
  const r = intake(f, ["--compose-review", "--orchestrator", "claude-sonnet-5-5"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(routed(r), ["claude-opus-5-5", "opus", "model session:claude-opus-5-5 (auto: escalated on lines=401)"]);
  assert.match(ledgerTail(f), / event=review-round outcome=model session:claude-opus-5-5 \(auto: escalated on lines=401\) ref=/);
});
