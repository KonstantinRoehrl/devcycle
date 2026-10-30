import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import {
  ledgerKey, parseLedgerLine, appendLedgerLine, nextRetry, retryCount, latestKeyed, appendRunRecordOnce, depthBandNow,
  checkTaskId, ledgerPlan, taskFiles, taskGate, UsageError,
  HelpRequest, taskFlags, usageLine, unparseableFindings, isNoVerdict, noVerdictReason, nextReviewRound, MISSING_FINDINGS,
} from "../../scripts/task-ledger.mjs";

const LEDGER_MODULE = new URL("../../scripts/task-ledger.mjs", import.meta.url).href;
const RUN = "0123456789abcdef";
const PREAMBLE = "Plan: `docs/plan.md`\nBranch: `feat/x` (cut from `dev` at `abc1234`)\nProfile: `standard` (evidence tail 20 lines)\n";
const STAMPED = /^- \[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\] /;

function ledger(extra = "") {
  const path = join(makeTempDir("task-ledger-"), "ledger.md");
  writeFileSync(path, PREAMBLE + extra);
  return path;
}
const lines = (path) => readFileSync(path, "utf8").split("\n").filter((l) => l.startsWith("- ["));

// Run records land under DEVCYCLE_RUNS_DIR/<repo-slug>/<run>.jsonl; each test gets its own runs dir.
function withRunsDir(fn) {
  const prior = process.env.DEVCYCLE_RUNS_DIR;
  process.env.DEVCYCLE_RUNS_DIR = makeTempDir("task-ledger-runs-");
  try {
    return fn(process.env.DEVCYCLE_RUNS_DIR);
  } finally {
    if (prior === undefined) delete process.env.DEVCYCLE_RUNS_DIR;
    else process.env.DEVCYCLE_RUNS_DIR = prior;
  }
}
const recordRows = (runsDir) => {
  const [slug] = readdirSync(runsDir);
  return readFileSync(join(runsDir, slug, `${RUN}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
};

test("ledgerKey: task/event/round/retry, round and retry defaulting to 0", () => {
  assert.equal(ledgerKey({ task: "5", event: "dispatched" }), "5/dispatched/0/0");
  assert.equal(ledgerKey({ task: "5", event: "review-round", round: 2, retry: 1 }), "5/review-round/2/1");
});

test("parseLedgerLine: a keyed line, a pre-key line, and non-event lines", () => {
  assert.deepEqual(
    parseLedgerLine("- [2026-10-08T10:00:00Z] task=5 event=report-received outcome=rejected (missing report file) ref=.devcycle/reports/5.md key=5/report-received/0/1"),
    { stamp: "2026-10-08T10:00:00Z", task: "5", event: "report-received", outcome: "rejected (missing report file)",
      ref: ".devcycle/reports/5.md", key: "5/report-received/0/1" });
  assert.deepEqual(
    parseLedgerLine("- [2026-10-08T10:00:00Z] task=drive event=user-decision outcome=unattended (model=claude-opus-5-5) ref=.devcycle/state.md"),
    { stamp: "2026-10-08T10:00:00Z", task: "drive", event: "user-decision", outcome: "unattended (model=claude-opus-5-5)",
      ref: ".devcycle/state.md", key: null });
  assert.equal(parseLedgerLine("Plan: `docs/plan.md`"), null);
  assert.equal(parseLedgerLine(""), null);
});

test("appendLedgerLine: appends one stamped, keyed line; the same key again appends nothing", () => {
  const path = ledger();
  const first = appendLedgerLine(path, { task: "5", event: "dispatched", outcome: "implementer retry 0", ref: ".devcycle/briefs/5-implementer.md" });
  assert.equal(first.appended, true);
  assert.match(first.line, STAMPED);
  assert.match(first.line, / task=5 event=dispatched outcome=implementer retry 0 ref=\.devcycle\/briefs\/5-implementer\.md key=5\/dispatched\/0\/0$/);
  const again = appendLedgerLine(path, { task: "5", event: "dispatched", outcome: "implementer retry 0", ref: ".devcycle/briefs/5-implementer.md" });
  assert.deepEqual(again, { appended: false, line: first.line });
  assert.equal(appendLedgerLine(path, { task: "5", event: "dispatched", outcome: "implementer retry 1", retry: 1 }).appended, true);
  assert.equal(lines(path).length, 2);
  assert.ok(readFileSync(path, "utf8").startsWith(PREAMBLE), "the preamble is untouched");
});

test("appendLedgerLine: a ledger without a trailing newline still gets its line on a line of its own", () => {
  const path = join(makeTempDir("task-ledger-"), "ledger.md");
  writeFileSync(path, PREAMBLE.trimEnd());
  appendLedgerLine(path, { task: "1", event: "committed", outcome: "committed", ref: "a".repeat(40) });
  assert.equal(lines(path).length, 1);
});

test("appendLedgerLine: refuses a missing ledger, a multi-line outcome and a ref with a space", () => {
  const dir = makeTempDir("task-ledger-");
  assert.throws(() => appendLedgerLine(join(dir, "ledger.md"), { task: "1", event: "dispatched", outcome: "x" }), /no ledger at .*preamble/);
  const path = ledger();
  assert.throws(() => appendLedgerLine(path, { task: "1", event: "dispatched", outcome: "a\nb" }), /one line/);
  assert.throws(() => appendLedgerLine(path, { task: "1", event: "dispatched", outcome: "a", ref: "a b" }), /one token/);
  assert.equal(lines(path).length, 0);
});

test("nextRetry: 0 for none, 1 + the highest keyed retry, pre-key lines counted by position", () => {
  const path = ledger(
    "- [2026-10-08T10:00:00Z] task=5 event=dispatched outcome=model fast ref=none\n" +
    "- [2026-10-08T10:01:00Z] task=6 event=dispatched outcome=implementer retry 4 ref=none key=6/dispatched/0/4\n");
  assert.equal(nextRetry(path, "5", "dispatched"), 1);
  assert.equal(nextRetry(path, "5", "review-round"), 0);
  assert.equal(nextRetry(path, "6", "dispatched"), 5);
  assert.equal(nextRetry(path, "7", "dispatched"), 0);
});

test("retryCount: the task's lines whose outcome starts with the prefix, whatever their event", () => {
  const path = ledger(
    "- [2026-10-08T10:00:00Z] task=5 event=report-received outcome=rejected (missing report file) ref=r key=5/report-received/0/0\n" +
    "- [2026-10-08T10:01:00Z] task=5 event=report-received outcome=rejected (missing report file) ref=r key=5/report-received/0/1\n" +
    "- [2026-10-08T10:02:00Z] task=6 event=report-received outcome=rejected (missing report file) ref=r key=6/report-received/0/0\n");
  assert.equal(retryCount(path, "5", "rejected (missing report file)"), 2);
  assert.equal(retryCount(path, "5", "rejected (intake bounce)"), 0);
});

test("latestKeyed: the newest keyed line for a task and event, optionally of one round", () => {
  const path = ledger(
    "- [2026-10-08T10:00:00Z] task=5 event=review-round outcome=round 1 ref=b key=5/review-round/1/0\n" +
    "- [2026-10-08T10:01:00Z] task=5 event=review-round outcome=round 1 ref=b key=5/review-round/1/1\n" +
    "- [2026-10-08T10:02:00Z] task=5 event=review-round outcome=round 2 ref=b key=5/review-round/2/2\n");
  assert.equal(latestKeyed(path, "5", "review-round").key, "5/review-round/2/2");
  assert.deepEqual([latestKeyed(path, "5", "review-round", { round: 1 }).round, latestKeyed(path, "5", "review-round", { round: 1 }).retry], [1, 1]);
  assert.equal(latestKeyed(path, "5", "dispatched"), null);
});

test("appendRunRecordOnce: writes a valid row once, keyed by matchKeys", () => {
  withRunsDir((runsDir) => {
    const toplevel = makeTempDir("task-ledger-repo-");
    const fields = { taskId: "5", sha: "a".repeat(40) };
    assert.deepEqual(appendRunRecordOnce({ toplevel, run: RUN, kind: "commit", fields, matchKeys: ["taskId", "sha"] }), { appended: true });
    assert.deepEqual(appendRunRecordOnce({ toplevel, run: RUN, kind: "commit", fields, matchKeys: ["taskId", "sha"] }), { appended: false });
    assert.deepEqual(recordRows(runsDir), [{ kind: "commit", runId: RUN, taskId: "5", sha: "a".repeat(40) }]);
  });
});

test("appendRunRecordOnce: stamps ts where the kind requires it, and refuses an invalid row without writing", () => {
  withRunsDir((runsDir) => {
    const toplevel = makeTempDir("task-ledger-repo-");
    appendRunRecordOnce({ toplevel, run: RUN, kind: "event",
      fields: { event: "gate-pass-clean", stage: "execution", task: "5" }, matchKeys: ["event", "task"] });
    assert.match(recordRows(runsDir)[0].ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.throws(() => appendRunRecordOnce({ toplevel, run: RUN, kind: "commit", fields: { taskId: "5", sha: "short" }, matchKeys: ["taskId"] }),
      /commit row rejected — "sha" does not match/);
    assert.throws(() => appendRunRecordOnce({ toplevel, run: RUN, kind: "no-such-kind", fields: {}, matchKeys: [] }), /unknown run-record kind/);
    assert.equal(recordRows(runsDir).length, 1);
  });
});

test("depthBandNow: unknown without a session, the probe's band with one", () => {
  const projects = makeTempDir("task-ledger-projects-");
  assert.equal(depthBandNow({ CLAUDE_DOCTOR_PROJECTS: projects }, "/work/repo"), "unknown");
  mkdirSync(join(projects, "-work-repo"), { recursive: true });
  const usage = { input_tokens: 10000, cache_creation_input_tokens: 0, cache_read_input_tokens: 150000, output_tokens: 5 };
  writeFileSync(join(projects, "-work-repo", "sess-1.jsonl"),
    JSON.stringify({ type: "assistant", timestamp: "2026-10-08T10:00:00Z", message: { model: "claude-opus-5", usage } }) + "\n");
  assert.equal(depthBandNow({ CLAUDE_CODE_SESSION_ID: "sess-1", CLAUDE_DOCTOR_PROJECTS: projects }, "/work/repo"), "over-budget");
});

test("appendLedgerLine: three tasks appending in parallel to one ledger lose no line", async () => {
  const path = ledger();
  const worker = (task) => `
    import { appendLedgerLine } from ${JSON.stringify(LEDGER_MODULE)};
    for (let retry = 0; retry < 20; retry++)
      appendLedgerLine(${JSON.stringify(path)}, { task: "${task}", event: "dispatched", outcome: "implementer retry " + retry, retry });`;
  await Promise.all(["1", "2", "3"].map((task) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", worker(task)], { stdio: ["ignore", "ignore", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`task ${task} worker exited ${code}`))));
  })));
  const keys = lines(path).map((l) => parseLedgerLine(l).key);
  assert.equal(keys.length, 60);
  assert.equal(new Set(keys).size, 60);
});

const GATE_PLAN = [
  "# P", "", "**Verification gate:** `npm test`", "",
  "### Task 1: A", "**Files:**", "- Modify: a.mjs", "**Evidence:** red-green", "**Quality constraints:** none", "",
  "### Task 2: B", "**Files:**", "- Modify: b.md", "**Evidence:** convention (`npm run lint`)", "**Quality constraints:** none", "",
  "## Dispatch Map", "", "- Wave 1: Task 1, Task 2", "",
].join("\n");

// A checkout as the execution stage lays it out: <root>/.devcycle/ledger.md naming <root>/docs/plan.md.
function checkoutLedger({ plan = null } = {}) {
  const root = makeTempDir("task-ledger-gate-");
  mkdirSync(join(root, ".devcycle"), { recursive: true });
  writeFileSync(join(root, ".devcycle/ledger.md"), PREAMBLE);
  if (plan !== null) {
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs/plan.md"), plan);
  }
  return join(root, ".devcycle/ledger.md");
}

test("ledgerPlan reads the preamble's plan path; null without a ledger or a preamble", () => {
  assert.equal(ledgerPlan(ledger()), "docs/plan.md");
  assert.equal(ledgerPlan(join(makeTempDir("task-ledger-none-"), "ledger.md")), null);
  const bare = join(makeTempDir("task-ledger-bare-"), "ledger.md");
  writeFileSync(bare, "- [2026-10-08T10:00:00Z] task=1 event=dispatched outcome=x ref=none\n");
  assert.equal(ledgerPlan(bare), null);
});

test("taskGate resolves through the ledger's plan, relative to the checkout holding the ledger", () => {
  const path = checkoutLedger({ plan: GATE_PLAN });
  assert.deepEqual(taskGate(path, "1"), { cmd: "npm test", source: "plan-gate", evidenceClass: "red-green" });
  assert.deepEqual(taskGate(path, "2"), { cmd: "npm run lint", source: "convention", evidenceClass: "convention", planGate: "npm test" });
});

test("taskGate is null for a missing plan file, a non-numeric task id, or an unknown task", () => {
  assert.equal(taskGate(checkoutLedger(), "1"), null);
  const path = checkoutLedger({ plan: GATE_PLAN });
  assert.equal(taskGate(path, "fast"), null);
  assert.equal(taskGate(path, "0x1"), null);
  assert.equal(taskGate(path, "7"), null);
});

test("taskGate reads a plan the preamble names by absolute path as is", () => {
  const plan = join(makeTempDir("task-ledger-abs-plan-"), "plan.md");
  writeFileSync(plan, GATE_PLAN);
  const path = join(makeTempDir("task-ledger-abs-"), "ledger.md");
  writeFileSync(path, `Plan: \`${plan}\`\n\n`);
  assert.deepEqual(taskGate(path, "1"), { cmd: "npm test", source: "plan-gate", evidenceClass: "red-green" });
});

test("taskFiles reads a task's **Files:** set through the ledger's plan; null with no plan, a non-numeric id or an unknown task", () => {
  const path = checkoutLedger({ plan: GATE_PLAN });
  assert.deepEqual(taskFiles(path, "1"), new Set(["a.mjs"]));
  assert.deepEqual(taskFiles(path, "2"), new Set(["b.md"]));
  assert.equal(taskFiles(checkoutLedger(), "1"), null);
  assert.equal(taskFiles(path, "fast"), null);
  assert.equal(taskFiles(path, "7"), null);
});

test("checkTaskId refuses a task id the task scripts would refuse", () => {
  assert.doesNotThrow(() => checkTaskId("3"));
  assert.throws(() => checkTaskId("../x"), (err) => err instanceof UsageError && /--task must be a plan task id, got "\.\.\/x"/.test(err.message));
});

test("taskFlags names every missing required flag in one error", () => {
  const known = { "--run": "value", "--a": "value", "--b": "value", "--c": "value" };
  assert.throws(() => taskFlags(["--run", "x"], known, ["--run", "--a", "--b", "--c"]),
    (err) => err instanceof UsageError && err.message === "--a, --b, --c are required");
  assert.throws(() => taskFlags(["--run", "x", "--a", "1", "--b", "2"], known, ["--run", "--a", "--b", "--c"]),
    (err) => err instanceof UsageError && err.message === "--c is required");
});

test("taskFlags answers --help with the flag names, required first, before any other check", () => {
  const known = { "--run": "value", "--task": "value", "--ledger": "value" };
  assert.throws(() => taskFlags(["--help", "--bogus"], known, ["--run", "--task"]), (err) =>
    err instanceof HelpRequest && !(err instanceof UsageError) &&
    JSON.stringify(err.usage) === JSON.stringify({ required: ["--run", "--task"], optional: ["--ledger"] }));
  assert.equal(usageLine("task-x", { required: ["--run"], optional: ["--ledger"] }), "usage: task-x.mjs --run [--ledger]");
});

test("the no-verdict predicate covers an absent and an unparseable findings file, and nothing else", () => {
  const unparseable = unparseableFindings("no verdict line");
  assert.equal(unparseable, "rejected (unparseable findings file: no verdict line)");
  assert.equal(parseLedgerLine(`- [2026-10-29T10:00:00Z] task=5 event=review-verdict outcome=${unparseable} ref=.devcycle/findings/5-round-1.md key=5/review-verdict/1/0`).outcome, unparseable);
  assert.deepEqual([MISSING_FINDINGS, unparseable, "rejected", "accepted", "rejected (green gate: exit 1)"].map(isNoVerdict), [true, true, false, false, false]);
  assert.deepEqual([MISSING_FINDINGS, unparseable].map(noVerdictReason), ["absent file", "no verdict line"]);
});

test("retryCount takes a predicate as well as a prefix", () => {
  const path = ledger([
    `- [2026-10-29T10:00:00Z] task=5 event=review-verdict outcome=${MISSING_FINDINGS} ref=none key=5/review-verdict/1/0`,
    `- [2026-10-29T10:01:00Z] task=5 event=review-verdict outcome=${unparseableFindings("conflicting verdicts")} ref=none key=5/review-verdict/1/1`,
    "",
  ].join("\n"));
  assert.equal(retryCount(path, "5", MISSING_FINDINGS), 1);
  assert.equal(retryCount(path, "5", isNoVerdict), 2);
});

test("nextReviewRound keeps a round open across an unparseable findings file", () => {
  const entries = [
    "- [2026-10-29T10:00:00Z] task=5 event=review-round outcome=round 1 ref=none key=5/review-round/1/0",
    `- [2026-10-29T10:01:00Z] task=5 event=review-verdict outcome=${unparseableFindings("no verdict line")} ref=none key=5/review-verdict/1/0`,
  ].map(parseLedgerLine);
  assert.equal(nextReviewRound(entries), 1);
});
