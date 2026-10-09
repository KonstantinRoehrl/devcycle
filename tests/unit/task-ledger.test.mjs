import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import {
  ledgerKey, parseLedgerLine, appendLedgerLine, nextRetry, retryCount, latestKeyed, appendRunRecordOnce, depthBandNow,
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
