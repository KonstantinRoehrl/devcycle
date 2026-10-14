import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { commitAll, makeFakeBin, makeRepo, sh, writeInto } from "./helpers.mjs";

const DRIVER = fileURLToPath(new URL("../../scripts/drive-execution.mjs", import.meta.url));
const STUB_URL = new URL("../fixtures/stub-claude.mjs", import.meta.url).href;
const RUN = "0123456789abcdef";
const MODEL = "claude-sonnet-5-5";
const MINUTE = 60_000;
// How far the injected clock moves per 10 ms tick: an hours-long wait ends in well under a second.
const TICK_MS = 5 * MINUTE;
const TIMEOUT = { timeout: 30_000 };

const PLAN = [
  "# Fixture plan", "",
  "### Task 1: first", "", "**Files:**", "- Modify: src/a.txt", "",
  "**Dependencies:** none (completely independent)", "",
  "### Task 2: second", "", "**Files:**", "- Modify: src/b.txt", "",
  "**Dependencies:** Tasks 1 committed", "",
  "## Dispatch Map", "",
  "- Wave 1: Task 1 (no dependencies)",
  "- Wave 2: Task 2 (needs Task 1 committed)", "",
].join("\n");

const line = (task, event, ref = "none") => `task=${task} event=${event} outcome=ok ref=${ref}`;
const DONE = [line(1, "committed", "abc1234"), line(2, "committed", "def5678")];

function makeCycle() {
  const root = makeRepo();
  sh("git", ["checkout", "-q", "-b", "feat/drive"], { cwd: root });
  writeInto(root, "src/a.txt", "a\n");
  writeInto(root, "src/b.txt", "b\n");
  writeInto(root, "docs/plan.md", PLAN);
  commitAll(root, "chore: fixture");
  writeInto(root, ".devcycle/state.md", [
    "# devcycle state", "- stage: execution", `- root: ${root}`, "- branch: feat/drive (cut from main at 0000000)",
    "- request: fixture", "- kind: feature", "- plan: docs/plan.md", "- plan-counts: planned=2 waves=2",
    "- ledger: .devcycle/ledger.md", `- run: ${RUN}`, `- drive: auto model=${MODEL} opted=2026-10-13T00:00:00Z via=answer`,
    "- updated: 2026-10-13T00:00:00Z", "",
  ].join("\n"));
  writeInto(root, ".devcycle/ledger.md",
    "Plan: `docs/plan.md`\nBranch: `feat/drive` (cut from `main` at `0000000`)\nProfile: `standard` (evidence tail 40 lines)\n\n");
  return root;
}

const readJsonl = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const driveRecords = (runsDir) =>
  existsSync(runsDir)
    ? readdirSync(runsDir).flatMap((slug) => readJsonl(join(runsDir, slug, `${RUN}.jsonl`))).filter((r) => r.kind === "drive")
    : [];
const resumesOf = (log) => [...log.matchAll(/— resuming at (\S+)/g)].map((m) => Date.parse(m[1]));

// The driver's clock is a file moved forward one tick every 10 ms, written atomically so the
// driver never reads it half-written.
function startClock(dir) {
  const path = join(dir, "clock");
  let t = Date.now();
  const write = () => {
    writeFileSync(`${path}.tmp`, String(t));
    renameSync(`${path}.tmp`, path);
  };
  write();
  const timer = setInterval(() => {
    t += TICK_MS;
    write();
  }, 10);
  return { path, stop: () => clearInterval(timer) };
}

// CLAUDECODE and CLAUDE_CONFIG_DIR, which a suite run inside Claude Code inherits, are dropped, and so
// is DEVCYCLE_DRIVE_TOKEN: a driver started with one is a driven session's, which Task 7 refuses.
const { CLAUDECODE: _claudeCode, CLAUDE_CONFIG_DIR: _configDir, DEVCYCLE_DRIVE_TOKEN: _token, ...BASE_ENV } = process.env;

async function drive(root, scenario, flags = []) {
  const dir = makeTempDir("devcycle-drive-resilience-");
  mkdirSync(join(dir, "home"));
  writeFileSync(join(dir, "scenario.json"), JSON.stringify(scenario));
  const bin = join(makeFakeBin("claude", `import(${JSON.stringify(STUB_URL)});\n`), "claude");
  const clock = startClock(dir);
  const env = {
    ...BASE_ENV,
    PATH: [dirname(process.execPath), process.env.PATH].join(delimiter),
    HOME: join(dir, "home"),
    DEVCYCLE_RUNS_DIR: join(dir, "runs"),
    STUB_CLAUDE_SCENARIO: join(dir, "scenario.json"),
    STUB_CLAUDE_CALLS: join(dir, "calls.jsonl"),
    DEVCYCLE_DRIVE_CLOCK_FILE: clock.path,
    DEVCYCLE_DRIVE_SLICE_MS: "5",
  };
  const child = spawn(process.execPath, [DRIVER, "--state", join(root, ".devcycle", "state.md"), "--claude", bin, ...flags], { cwd: root, env });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  try {
    const code = await new Promise((done) => child.on("close", done));
    return { code, out, calls: readJsonl(join(dir, "calls.jsonl")), records: driveRecords(join(dir, "runs")),
      log: readFileSync(join(root, ".devcycle", "drive.log"), "utf8") };
  } finally {
    clock.stop();
    child.kill("SIGKILL");
  }
}

test("an API-error session is no stall: it backs off, and the next session starts only after the deadline", TIMEOUT, async () => {
  const apiError = { isError: true, result: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}' };
  const r = await drive(makeCycle(), [apiError, apiError, { ledger: DONE, stage: "branch-review" }], ["--max-stalls", "1"]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.records.map((x) => [x.exitReason, x.stallCount]), [["transient", 0], ["transient", 0], ["handoff", 0]]);
  assert.match(r.log, /wait: transient failure \(api-error\), attempt 1 — resuming at \S+\n[\s\S]*wait: transient failure \(api-error\), attempt 2 — resuming at /);
  const resumes = resumesOf(r.log);
  assert.ok(r.calls[1].clock >= resumes[0] && r.calls[2].clock >= resumes[1], "a session started before its backoff deadline");
});

// The status decides: a 5xx, a 408 or a 429 passes on its own, and so does an error with no status
// (the connection never got one). A status counts only where the text calls it one, so a "500 tokens"
// is no server error.
test("an API error with a 5xx, 408, 429 or no status, or a network error, backs off as transient", TIMEOUT, async () => {
  const errors = [
    'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}',
    "API Error: 408 Request Timeout",
    "API Error: Connection error.",
    "TypeError: fetch failed",
    "connect ETIMEDOUT 160.79.104.10:443",
    "Request failed with status code 503",
    "HTTP 502 from the upstream proxy",
    "503 Service Unavailable",
  ];
  const r = await drive(makeCycle(), [...errors.map((result) => ({ isError: true, result })), { ledger: DONE, stage: "branch-review" }], ["--max-stalls", "1"]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.records.map((x) => x.exitReason), [...errors.map(() => "transient"), "handoff"]);
});

test("an error that only mentions a 5xx figure, such as 500 tokens, is no server error: it counts as a stall and is never backed off", TIMEOUT, async () => {
  const r = await drive(makeCycle(), [{ isError: true, result: "The reply was cut off after 500 tokens" }], ["--max-stalls", "1"]);
  assert.equal(r.code, 5, r.out);
  assert.deepEqual(r.records.map((x) => x.exitReason), ["stalled"]);
  assert.doesNotMatch(r.log, /wait: transient failure/);
});

// Each session is a fresh `claude -p`, so a 4xx caused by one session's own transcript — tool-use
// blocks out of step, a request grown too large — is not repeated by the next. A session that ends on
// one is judged like any other: no wait, and a stall unless it progressed.
test("an API error that belongs to its session — a 400 over its tool-use blocks, a 413 — starts a fresh session at once, and counts as a stall without progress", TIMEOUT, async () => {
  const concurrency = 'API Error: 400 due to tool use concurrency issues. Run /rewind to recover the conversation.';
  const orphaned = 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.12: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_01"}}';
  const tooLarge = 'API Error: 413 {"type":"error","error":{"type":"request_too_large","message":"Request exceeds the maximum allowed number of bytes."}}';
  const r = await drive(makeCycle(), [
    { isError: true, result: concurrency, ledger: [line(1, "report-received")] },
    { isError: true, result: orphaned },
    { isError: true, result: tooLarge },
  ]);
  assert.equal(r.code, 5, r.out);
  assert.equal(r.calls.length, 3);
  assert.deepEqual(r.records.map((x) => [x.exitReason, x.stallCount]), [["handoff", 0], ["stalled", 1], ["stalled", 2]]);
  assert.doesNotMatch(r.log, /wait: /);
  assert.doesNotMatch(r.out, /the API refused/);
  assert.ok(r.out.includes(`The last session said:\n${tooLarge}`), r.out);
});

test("an API error that fails the same way in every session — a credit balance, a key without access, an unknown model — ends the run at once, naming the error and the remedy, exit 3", TIMEOUT, async () => {
  const refusals = [
    'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}',
    'API Error: 403 {"type":"error","error":{"type":"permission_error","message":"Your API key does not have permission to use the specified resource."}}',
    'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-sonnet-0-0"}}',
    "Credit balance is too low",
  ];
  for (const result of refusals) {
    const r = await drive(makeCycle(), [{ isError: true, result }, { ledger: DONE, stage: "branch-review" }]);
    assert.equal(r.code, 3, r.out);
    assert.equal(r.calls.length, 1, `retried: ${result}`);
    assert.deepEqual(r.records.map((x) => x.exitReason), ["environment"]);
    assert.ok(r.out.includes(`the API refused the session's request, and retrying cannot fix that: ${result}`), r.out);
    assert.match(r.out, /fix what it names[^\n]*, then restart the run from \/devcycle:continue/);
  }
});

test("a session with no result and no ledger line is transient, and so is a claude that dies before init, each with its own drive row", TIMEOUT, async () => {
  const lost = await drive(makeCycle(), [{ noResult: true, exitCode: 1 }, { ledger: DONE, stage: "branch-review" }], ["--max-stalls", "1"]);
  assert.equal(lost.code, 0, lost.out);
  assert.deepEqual(lost.records.map((x) => [x.exitReason, x.stallCount]), [["transient", 0], ["handoff", 0]]);
  assert.match(lost.log, /wait: transient failure \(no-result\), attempt 1 — resuming at /);

  // Backoffs of 1, 2, 4 and 8 minutes fill --max-backoff 15 exactly; the fifth, 16 more, would pass it.
  const five = await drive(makeCycle(), [{ noInit: true }], ["--max-backoff", "15"]);
  assert.equal(five.code, 6, five.out);
  assert.deepEqual(five.records.map((x) => x.exitReason), ["transient", "transient", "transient", "transient", "budget"]);
  assert.match(five.out, /would pass --max-backoff/);
  assert.equal(new Set(five.records.map((x) => x.sessionHash)).size, 5);
  for (const row of five.records) assert.ok(!JSON.stringify(row).includes(five.calls[0].token), "a drive row stores the raw drive token");
});

test("a usage limit with a known reset is waited out past 360 minutes, never capped or charged to --max-backoff", TIMEOUT, async () => {
  const r = await drive(makeCycle(), [{ rateLimitInSec: 400 * 60 }, { ledger: DONE, stage: "branch-review" }], ["--max-backoff", "1", "--max-stalls", "1"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.calls.length, 2);
  assert.deepEqual(r.records.map((x) => [x.exitReason, x.stallCount]), [["budget", 0], ["handoff", 0]]);
  assert.match(r.log, /wait: usage limit until its reset — resuming at /);
  const [resume] = resumesOf(r.log);
  assert.ok(resume - r.calls[0].clock >= 400 * MINUTE, "the wait ended before the reset");
  assert.ok(r.calls[1].clock >= resume, "the next session started before the reset plus its margin");

  const resetAt = Math.floor((Date.now() + 600 * MINUTE) / 1000);
  const fromText = await drive(makeCycle(), [{ isError: true, result: `Claude AI usage limit reached|${resetAt}` }, { ledger: DONE, stage: "branch-review" }],
    ["--max-backoff", "1"]);
  assert.equal(fromText.code, 0, fromText.out);
  assert.deepEqual(fromText.records.map((x) => x.exitReason), ["budget", "handoff"]);
});

test("the backoff charge resets when a session makes progress; exhausting it exits 6 as wait-cap", TIMEOUT, async () => {
  const noReset = { rateLimitNoReset: true };
  const r = await drive(makeCycle(), [noReset, noReset, { ledger: [line(1, "report-received")] }, noReset, noReset, noReset], ["--max-backoff", "3"]);
  assert.equal(r.code, 6, r.out);
  assert.equal(r.calls.length, 6, "the progress session did not reset the backoff charge");
  assert.deepEqual(r.records.map((x) => x.exitReason), ["transient", "transient", "handoff", "transient", "transient", "budget"]);
  assert.match(r.log, /wait: transient failure \(usage-limit\), attempt 2 — resuming at /);
  assert.match(r.out, /would pass --max-backoff/);
});

test("an authentication failure ends the run at once as an environment failure, exit 3", TIMEOUT, async () => {
  const r = await drive(makeCycle(), [{ isError: true, result: "Invalid API key · Please run /login" }]);
  assert.equal(r.code, 3, r.out);
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.records.map((x) => x.exitReason), ["environment"]);
  assert.match(r.out, /authentication failed: Invalid API key · Please run \/login/);
});

test("the log says when a wave completes, once the in-flight wave moves past it", TIMEOUT, async () => {
  const r = await drive(makeCycle(), [{ ledger: [line(1, "dispatched"), DONE[0]] }, { ledger: [line(2, "dispatched"), DONE[1]], stage: "branch-review" }]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.log, /session 1 ended[^\n]*\n\[drive [^\]]+\] wave 1 of 2 complete\n/);
  assert.match(r.log, /session 2 ended[^\n]*\n\[drive [^\]]+\] wave 2 of 2 complete\n/);
  assert.equal(r.log.match(/wave \d of 2 complete/g).length, 2);
});
