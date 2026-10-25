import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { createHash } from "node:crypto";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { DRIVE_LOCK_REL, readDriveLockHolder } from "../../scripts/drive-lock.mjs";
import { processStartTime } from "../../scripts/file-lock.mjs";
import { classifyTrackedChanges, inFlightFiles, SESSION_START_TOKENS, stopDriver } from "../../scripts/drive-execution.mjs";
import { classifyDrive, HANDLED_REL, readDriveResult, readHandledResult, RESULT_REL, STOP_REQUEST_REL } from "../../scripts/drive-result.mjs";
import { commitAll, makeFakeBin, makeRepo, sh, writeInto } from "./helpers.mjs";

const DRIVER = fileURLToPath(new URL("../../scripts/drive-execution.mjs", import.meta.url));
const STUB_URL = new URL("../fixtures/stub-claude.mjs", import.meta.url).href;
const RUN = "0123456789abcdef";
const MODEL = "claude-sonnet-5-5";
// scripts/drive-signal.mjs's reasons, pinned verbatim: the driver passes each one through untouched.
const STOP_REASONS = ["needs-user", "knob-drift", "foreign-state", "resume-check", "branch", "depth-at-start",
  "sweep-fallback", "scope-change", "no-driver", "not-opted-in"];

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

// A git repo on a topic branch holding a two-wave plan, a state file at execution and an empty ledger.
function makeCycle({ branch = "feat/drive", stage = "execution", drive = `- drive: auto model=${MODEL} opted=2026-10-08T00:00:00Z via=answer`, plan = PLAN, files = [] } = {}) {
  const root = makeRepo();
  if (branch !== "main") sh("git", ["checkout", "-q", "-b", branch], { cwd: root });
  for (const path of ["src/a.txt", "src/b.txt", "other.txt", ...files]) writeInto(root, path, "seed\n");
  writeInto(root, "docs/plan.md", plan);
  commitAll(root, "chore: fixture");
  writeInto(root, ".devcycle/state.md", [
    "# devcycle state", `- stage: ${stage}`, `- root: ${root}`, `- branch: ${branch} (cut from main at 0000000)`,
    "- request: fixture", "- kind: feature", "- plan: docs/plan.md", "- plan-counts: planned=2 waves=2",
    "- ledger: .devcycle/ledger.md", `- run: ${RUN}`, ...(drive ? [drive] : []), "- updated: 2026-10-08T00:00:00Z", "",
  ].join("\n"));
  writeInto(root, ".devcycle/ledger.md",
    "Plan: `docs/plan.md`\nBranch: `" + branch + "` (cut from `main` at `0000000`)\nProfile: `standard` (evidence tail 40 lines)\n\n");
  return root;
}

// One isolated world per scenario: its own HOME (the sandbox probe writes under ~/.claude), runs dir,
// scenario and call log, and a `claude` on PATH that is the stub. DEVCYCLE_NESTED_RUN is set on
// purpose — the driver must strip it from every session it starts. CLAUDECODE, CLAUDE_EFFORT and a
// DEVCYCLE_DRIVE_TOKEN, which a suite run inside Claude Code or a driven session inherits, and
// CLAUDE_CONFIG_DIR, which would point the driver at the real transcripts and settings, are dropped:
// only the tests that are about them set them. `prelude` runs in the fake `claude` before the stub does.
const { CLAUDECODE: _claudeCode, CLAUDE_CONFIG_DIR: _configDir, CLAUDE_EFFORT: _effort, DEVCYCLE_DRIVE_TOKEN: _driveToken, ...BASE_ENV } = process.env;
function harness(scenario = [], env = {}, { prelude = "" } = {}) {
  const dir = makeTempDir("devcycle-drive-test-");
  const home = join(dir, "home");
  mkdirSync(home);
  writeFileSync(join(dir, "scenario.json"), JSON.stringify(scenario));
  const bin = join(makeFakeBin("claude", `${prelude}import(${JSON.stringify(STUB_URL)});\n`), "claude");
  return {
    bin,
    runsDir: join(dir, "runs"),
    callsPath: join(dir, "calls.jsonl"),
    env: {
      ...BASE_ENV,
      PATH: [dirname(process.execPath), process.env.PATH].join(delimiter),
      HOME: home,
      DEVCYCLE_RUNS_DIR: join(dir, "runs"),
      STUB_CLAUDE_SCENARIO: join(dir, "scenario.json"),
      STUB_CLAUDE_CALLS: join(dir, "calls.jsonl"),
      DEVCYCLE_NESTED_RUN: "1",
      ...env,
    },
  };
}

const calls = (h) => (existsSync(h.callsPath) ? readFileSync(h.callsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

function records(h) {
  if (!existsSync(h.runsDir)) return [];
  return readdirSync(h.runsDir).flatMap((slug) => {
    const p = join(h.runsDir, slug, `${RUN}.jsonl`);
    return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.kind === "drive") : [];
  });
}

function startDriver(root, h, flags = []) {
  const child = spawn(process.execPath, [DRIVER, "--state", join(root, ".devcycle", "state.md"), "--claude", h.bin, ...flags], { cwd: root, env: h.env });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const closed = new Promise((res) => child.on("close", (code) => res(code)));
  return { child, result: async () => ({ code: await closed, out }) };
}

async function drive(root, scenario, { flags = [], env = {} } = {}) {
  const h = harness(scenario, env);
  const r = await startDriver(root, h, flags).result();
  return { ...r, calls: calls(h), records: records(h) };
}

// Pre-flight only: --dry-run spawns nothing and takes no lock.
function dryRun(root, flags = [], env = {}) {
  const h = harness([], env);
  const r = spawnSync(process.execPath, [DRIVER, "--state", join(root, ".devcycle", "state.md"), "--claude", h.bin, "--dry-run", ...flags], { cwd: root, env: h.env, encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr, calls: calls(h) };
}

async function waitFor(predicate, ms = 15000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the driver");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const lockPath = (root) => join(root, DRIVE_LOCK_REL);
const writeLock = (root, fields) =>
  writeFileSync(lockPath(root), JSON.stringify({ hostname: hostname(), state: ".devcycle/state.md", log: ".devcycle/drive.log", ...fields }));

test("drives one fresh session per wave until the state reaches branch-review, writing one drive record per session", async () => {
  const root = makeCycle();
  const r = await drive(root, [
    { ledger: [line(1, "dispatched"), DONE[0]] },
    { ledger: [line(2, "dispatched"), DONE[1]], stage: "branch-review", costUsd: 0.25, denials: 1 },
  ]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.calls.length, 2);
  assert.deepEqual(r.records.map((x) => x.exitReason), ["handoff", "handoff"]);
  assert.deepEqual(
    r.records.map((x) => [x.ledgerLinesBefore, x.ledgerLinesAfter, x.committedBefore, x.committedAfter, x.waveAtStart]),
    [[0, 2, 0, 1, 1], [2, 4, 1, 2, 2]],
  );
  assert.equal(r.records[1].costUsd, 0.25);
  assert.equal(r.records[1].guardDenials, 1);
  assert.equal(r.records[0].depthTokens, 60010);
  assert.equal(r.records[0].model, MODEL);
  assert.match(r.records[0].sessionHash, /^[0-9a-f]{64}$/);
  assert.match(r.out, /task=1 event=committed/);
  assert.ok(!existsSync(lockPath(root)), "the lock outlived the driver");
  // Started with stdout a pipe, not a terminal: the log the lock names is still written.
  assert.match(readFileSync(join(root, ".devcycle", "drive.log"), "utf8"), /session 2 ended — handoff[\s\S]*execution is complete/);
});

test("each session is claude -p on the drive prompt with auto permissions, stream-json and an explicit model, and never sees DEVCYCLE_NESTED_RUN", async () => {
  const root = makeCycle({ drive: `- drive: auto model=${MODEL} effort=high opted=2026-10-08T00:00:00Z via=answer` });
  const r = await drive(root, [{ ledger: DONE, stage: "branch-review" }]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.calls[0].argv, ["-p", "/devcycle:continue --drive .devcycle/state.md", "--model", MODEL, "--effort", "high",
    "--permission-mode", "auto", "--output-format", "stream-json", "--verbose",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']);
  assert.equal(r.calls[0].effort, "high", "the session's CLAUDE_EFFORT disagrees with its --effort");
  assert.equal(r.calls[0].nested, false, "DEVCYCLE_NESTED_RUN reached the driven session");
  const pinned = await drive(makeCycle(), [{ ledger: DONE, stage: "branch-review" }], { flags: ["--model", "claude-opus-5-5"] });
  assert.equal(pinned.calls[0].argv[pinned.calls[0].argv.indexOf("--model") + 1], "claude-opus-5-5");
});

const PLUGIN_LIST = readFileSync(fileURLToPath(new URL("../fixtures/plugin-list.json", import.meta.url)), "utf8");
const NO_MCP = ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'];
const startLine = (log) => log.split("\n").find((l) => l.includes("] session 1 starts"));

test("a driven session starts with no MCP servers and only the kept plugins, and the plugin list never spends a scenario step", async () => {
  const root = makeCycle();
  const r = await drive(root, [{ ledger: [line(1, "dispatched"), DONE[0]] }, { ledger: [DONE[1]], stage: "branch-review" }],
    { flags: ["--plugins", "impeccable", "--max-usd", "5"], env: { STUB_CLAUDE_PLUGIN_LIST: PLUGIN_LIST } });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.calls.length, 2, "the plugin list call consumed a scenario step or landed in the call log");
  const argv = r.calls[0].argv;
  const surface = argv.slice(argv.indexOf("--verbose") + 1, argv.indexOf("--max-budget-usd"));
  assert.deepEqual(surface.slice(0, 4), [...NO_MCP, "--settings"]);
  assert.deepEqual(JSON.parse(surface[4]).enabledPlugins,
    { "token-optimizer@alexgreensh-token-optimizer": false, "engineering@synced": false });
  assert.equal(surface.length, 5);
  assert.deepEqual(r.calls[1].argv.slice(argv.indexOf("--verbose") + 1, argv.indexOf("--max-budget-usd")), surface, "the list is read once and every session gets the same surface");
  const log = readFileSync(join(root, ".devcycle", "drive.log"), "utf8");
  assert.match(startLine(log), new RegExp(`session 1 starts — wave 1, model ${MODEL}, effort \\S+, plugins devcycle,impeccable,superpowers, mcp none$`));
  assert.doesNotMatch(log, /plugin list unavailable/);
});

test("--plugins all restores today's surface: no MCP restriction, no plugin override", async () => {
  const root = makeCycle();
  const r = await drive(root, [{ ledger: DONE, stage: "branch-review" }], { flags: ["--plugins", "all"], env: { STUB_CLAUDE_PLUGIN_LIST: PLUGIN_LIST } });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.calls[0].argv.at(-1), "--verbose");
  assert.ok(!r.calls[0].argv.includes("--settings") && !r.calls[0].argv.includes("--strict-mcp-config"), r.calls[0].argv.join(" "));
  assert.match(startLine(readFileSync(join(root, ".devcycle", "drive.log"), "utf8")), /, plugins all, mcp all$/);
});

test("an unreadable plugin list never stops a run: the MCP restriction stays, plugins are not overridden, and the log says so once", async () => {
  const root = makeCycle();
  const missing = join(makeTempDir("devcycle-drive-plugins-"), "no-list.json");
  const r = await drive(root, [{ ledger: [line(1, "dispatched"), DONE[0]] }, { ledger: [DONE[1]], stage: "branch-review" }],
    { env: { DEVCYCLE_DRIVE_PLUGIN_LIST: missing } });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.calls.length, 2);
  for (const c of r.calls) assert.deepEqual(c.argv.slice(c.argv.indexOf("--verbose") + 1), NO_MCP);
  const log = readFileSync(join(root, ".devcycle", "drive.log"), "utf8");
  assert.equal(log.split("plugin list unavailable — full plugin surface").length - 1, 1, log);
  assert.ok(log.indexOf("plugin list unavailable") < log.indexOf("session 1 starts"), "the note was not logged before the first session");
  assert.match(startLine(log), /, plugins all, mcp none$/);
});

test("--dry-run reads the plugin list, so its command is the argv a session would get", () => {
  const listFile = join(makeTempDir("devcycle-drive-plugins-"), "list.json");
  writeFileSync(listFile, PLUGIN_LIST);
  const r = dryRun(makeCycle(), [], { DEVCYCLE_DRIVE_PLUGIN_LIST: listFile });
  assert.equal(r.code, 0, r.out);
  const command = JSON.parse(r.out.trim().split("\n").at(-1)).command;
  assert.deepEqual(command.slice(command.indexOf("--verbose") + 1, command.indexOf("--verbose") + 5), [...NO_MCP, "--settings"]);
  assert.deepEqual(Object.keys(JSON.parse(command.at(-1)).enabledPlugins),
    ["impeccable@impeccable", "token-optimizer@alexgreensh-token-optimizer", "engineering@synced"]);
});

test("--plugins refuses a value outside none, all, or a comma-separated list of plugin names, with exit 2", () => {
  for (const value of ["two words", "none,impeccable", "a,,b", " "]) {
    const r = dryRun(makeCycle(), ["--plugins", value]);
    assert.equal(r.code, 2, `${JSON.stringify(value)}: ${r.out}`);
    assert.match(r.out, /^drive-execution: --plugins requires none, all, or a comma-separated list of plugin names/m);
  }
});

const effortRow = (effort) => `- drive: auto model=${MODEL} effort=${effort} opted=2026-10-08T00:00:00Z via=answer`;
const startsLine = (root) => readFileSync(join(root, ".devcycle", "drive.log"), "utf8").split("\n").find((l) => l.includes("] session 1 starts"));

test("effort comes from --effort, else the drive row's effort=, else the settings at driver start, which are never written back", async () => {
  const legacy = makeCycle();
  writeInto(legacy, ".claude/settings.json", JSON.stringify({ modelSettings: { [MODEL]: { effortLevel: "xhigh" } }, effortLevel: "low" }));
  const resolved = await drive(legacy, [{ ledger: DONE, stage: "branch-review" }]);
  assert.equal(resolved.code, 0, resolved.out);
  assert.deepEqual(resolved.calls[0].argv.slice(4, 6), ["--effort", "xhigh"]);
  assert.equal(resolved.calls[0].effort, "xhigh", "the session's CLAUDE_EFFORT disagrees with its --effort");
  assert.match(startsLine(legacy), new RegExp(`session 1 starts — wave 1, model ${MODEL}, effort xhigh`));
  assert.doesNotMatch(readFileSync(join(legacy, ".devcycle", "state.md"), "utf8"), /effort=/, "the resolved effort was written back to the row");

  const inherited = await drive(makeCycle(), [{ ledger: DONE, stage: "branch-review" }], { env: { CLAUDE_EFFORT: "low" } });
  assert.deepEqual(inherited.calls[0].argv.slice(4, 6), ["--effort", "low"], "the launching session's CLAUDE_EFFORT was not resolved");

  const recorded = makeCycle({ drive: effortRow("medium") });
  writeInto(recorded, ".claude/settings.json", JSON.stringify({ effortLevel: "max" }));
  const fromRow = await drive(recorded, [{ ledger: DONE, stage: "branch-review" }], { env: { CLAUDE_EFFORT: "low" } });
  assert.deepEqual(fromRow.calls[0].argv.slice(4, 6), ["--effort", "medium"]);
  assert.equal(fromRow.calls[0].effort, "medium");

  const flagged = await drive(makeCycle({ drive: effortRow("medium") }), [{ ledger: DONE, stage: "branch-review" }], { flags: ["--effort", "max"] });
  assert.deepEqual(flagged.calls[0].argv.slice(4, 6), ["--effort", "max"]);
  assert.equal(flagged.calls[0].effort, "max");
});

test("effort default passes no --effort and keeps an inherited CLAUDE_EFFORT from every session", async () => {
  const fromRow = await drive(makeCycle({ drive: effortRow("default") }),
    [{ ledger: [line(1, "dispatched"), DONE[0]] }, { ledger: [DONE[1]], stage: "branch-review" }], { env: { CLAUDE_EFFORT: "high" } });
  assert.equal(fromRow.code, 0, fromRow.out);
  assert.equal(fromRow.calls.length, 2);
  for (const c of fromRow.calls) {
    assert.ok(!c.argv.includes("--effort"), c.argv.join(" "));
    assert.equal(c.effort, null, "a session inherited the driver's CLAUDE_EFFORT");
  }
  const flagged = await drive(makeCycle({ drive: effortRow("high") }), [{ ledger: DONE, stage: "branch-review" }], { flags: ["--effort", "default"] });
  assert.ok(!flagged.calls[0].argv.includes("--effort"), flagged.calls[0].argv.join(" "));
  assert.equal(flagged.calls[0].effort, null);
  // Nothing set anywhere: the harness drops CLAUDE_EFFORT, and neither its HOME nor the checkout holds settings.
  const unset = makeCycle();
  const r = await drive(unset, [{ ledger: DONE, stage: "branch-review" }]);
  assert.ok(!r.calls[0].argv.includes("--effort"), r.calls[0].argv.join(" "));
  assert.match(startsLine(unset), /, effort default/);
});

test("an effort the driver cannot use refuses the start with exit 3 naming where it came from; a bad --effort is a usage error", () => {
  const unusable = makeCycle();
  writeInto(unusable, ".claude/settings.json", JSON.stringify({ effortLevel: "turbo" }));
  const unresolvable = dryRun(unusable);
  assert.equal(unresolvable.code, 3, unresolvable.out);
  assert.match(unresolvable.out, /^drive-execution: the effort level cannot be resolved: effortLevel in \S+\/\.claude\/settings\.json is "turbo", not one of low, medium, high, xhigh, max — correct it, or pass --effort <low\|medium\|high\|xhigh\|max\|default>$/m);

  const overridden = dryRun(unusable, ["--effort", "low"]);
  assert.equal(overridden.code, 0, overridden.out);
  assert.deepEqual(JSON.parse(overridden.out.trim().split("\n").at(-1)).command.slice(3, 7), ["--model", MODEL, "--effort", "low"]);

  const badRow = dryRun(makeCycle({ drive: effortRow("turbo") }));
  assert.equal(badRow.code, 3, badRow.out);
  assert.ok(badRow.out.includes("drive-execution: the drive row records effort=turbo, not one of low, medium, high, xhigh, max, default — pass --effort <low|medium|high|xhigh|max|default>"), badRow.out);

  for (const value of ["turbo", "HIGH", " "]) {
    const r = dryRun(makeCycle(), ["--effort", value]);
    assert.equal(r.code, 2, `${JSON.stringify(value)}: ${r.out}`);
    assert.match(r.out, /^drive-execution: --effort requires one of low \| medium \| high \| xhigh \| max \| default/m);
  }
});

test("each session gets this driver's own token, whose hash and only its hash the lock holds; every run draws a new one", async () => {
  const r = await drive(makeCycle(), [{ ledger: [line(1, "dispatched"), DONE[0]] }, { ledger: [DONE[1]], stage: "branch-review" }]);
  assert.equal(r.code, 0, r.out);
  const [first, second] = r.calls;
  assert.match(first.token, /^[0-9a-f]{32}$/, "the driven session was not handed a token");
  assert.equal(first.lockTokenHash, createHash("sha256").update(first.token).digest("hex"));
  assert.equal(second.token, first.token, "one driver run hands every session the same token");
  const again = await drive(makeCycle(), [{ ledger: DONE, stage: "branch-review" }]);
  assert.notEqual(again.calls[0].token, first.token, "two driver runs share a token");
});

// D5: a driven session holds DEVCYCLE_DRIVE_TOKEN; only /devcycle:continue starts a driver.
test("a start from a driven session (DEVCYCLE_DRIVE_TOKEN set) is refused before the pre-flight, touching neither the lock nor a result", async () => {
  const root = makeCycle();
  writeInto(root, RESULT_REL, JSON.stringify({ outcome: "interrupted", code: 130 }));
  const env = { DEVCYCLE_DRIVE_TOKEN: "a-driven-session" };
  const r = await drive(root, [{ ledger: DONE, stage: "branch-review" }], { env });
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /drive-execution: a driven session never starts a driver; \/devcycle:continue does/);
  assert.equal(r.calls.length, 0);
  assert.ok(!existsSync(lockPath(root)), "a refused start left a lock");
  assert.ok(existsSync(join(root, RESULT_REL)), "a refused start handled a result it never acted on");
  const dry = dryRun(root, [], env);
  assert.equal(dry.code, 3, dry.out);
  assert.match(dry.out, /a driven session never starts a driver/);
});

test("a session that ends mid-wave is respawned, and the safety valve's label is recorded as valve", async () => {
  const root = makeCycle();
  const r = await drive(root, [
    { ledger: [line(1, "dispatched"), line(1, "report-received")], result: "## Handoff\n- Session ended mid-wave: 0 of 1 tasks done (stage: execution)" },
    { ledger: [DONE[0]] },
    { ledger: [DONE[1]], stage: "branch-review" },
  ]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.records.map((x) => x.exitReason), ["valve", "handoff", "handoff"]);
});

test("sessions without a ledger line beyond a dispatch are stalls: --max-stalls in a row exits 5 with the last result text, and progress resets the count", async () => {
  const root = makeCycle();
  const question = "Which state file should I resume: .devcycle/state.md or sub/.devcycle/state.md?";
  const r = await drive(root, [{ result: "nothing to do" }, { ledger: [line(1, "report-received")] }, { result: "still nothing" }, { result: question }]);
  assert.equal(r.code, 5, r.out);
  assert.ok(r.out.includes(question), "the last session's result text was not printed");
  assert.deepEqual(r.records.map((x) => [x.exitReason, x.stallCount]), [["stalled", 1], ["handoff", 0], ["stalled", 1], ["stalled", 2]]);
  const three = await drive(makeCycle(), [{ result: "nothing" }], { flags: ["--max-stalls", "3"] });
  assert.equal(three.code, 5);
  assert.equal(three.calls.length, 3);
  const dispatchOnly = await drive(makeCycle(), [{ ledger: [line(1, "dispatched")] }]);
  assert.equal(dispatchOnly.code, 5, dispatchOnly.out);
  assert.match(dispatchOnly.out, /stalled: 2 sessions in a row added no ledger line beyond a dispatch/);
  assert.deepEqual(dispatchOnly.records.map((x) => [x.exitReason, x.stallCount]), [["stalled", 1], ["stalled", 2]]);
  // A review round is the reviewer's dispatch.
  const reviewOnly = await drive(makeCycle(), [{ ledger: [line(1, "review-round")] }]);
  assert.equal(reviewOnly.code, 5, reviewOnly.out);
  assert.match(reviewOnly.out, /stalled: 2 sessions in a row added no ledger line beyond a dispatch/);
  assert.deepEqual(reviewOnly.records.map((x) => [x.exitReason, x.stallCount]), [["stalled", 1], ["stalled", 2]]);
});

test("sessions that add ledger lines but no report, verdict or commit are churn: --max-churn in a row exits 5", async () => {
  const dying = { ledger: [line(1, "user-decision")], noResult: true, exitCode: 1 };
  const r = await drive(makeCycle(), [dying]);
  assert.equal(r.code, 5, r.out);
  assert.equal(r.calls.length, 3, "the default --max-churn is 3");
  assert.match(r.out, /3 sessions in a row added ledger lines but no report, verdict or commit/);
  assert.deepEqual(r.records.map((x) => x.exitReason), ["error", "error", "stalled"]);
  const reported = await drive(makeCycle(), [dying, dying, { ledger: [line(1, "report-received")] }, dying, dying, dying], { flags: ["--max-churn", "3"] });
  assert.equal(reported.code, 5, reported.out);
  assert.equal(reported.calls.length, 6, "a report resets the churn count");
  const two = await drive(makeCycle(), [dying], { flags: ["--max-churn", "2"] });
  assert.equal(two.calls.length, 2);
});

test("every stop reason a driven session signals ends the driver with exit 4, its reason and its detail", async () => {
  for (const reason of STOP_REASONS) {
    const r = await drive(makeCycle(), [{ stop: { reason, detail: `detail for ${reason}` } }]);
    assert.equal(r.code, 4, `${reason}: ${r.out}`);
    assert.ok(r.out.includes(reason) && r.out.includes(`detail for ${reason}`), r.out);
    assert.deepEqual(r.records.map((x) => [x.exitReason, x.stopReason]), [["stopped", reason]]);
  }
});

test("a drive-stop.json left from an earlier run is cleared before the next session", async () => {
  const root = makeCycle();
  writeInto(root, ".devcycle/drive-stop.json", JSON.stringify({ reason: "needs-user", detail: "old" }));
  const r = await drive(root, [{ ledger: DONE, stage: "branch-review" }]);
  assert.equal(r.code, 0, r.out);
});

test("--max-usd caps the total and passes each session the remainder as --max-budget-usd", async () => {
  const r = await drive(makeCycle(), [{ ledger: [line(1, "report-received")], costUsd: 0.6 }], { flags: ["--max-usd", "1"] });
  assert.equal(r.code, 6, r.out);
  assert.equal(r.calls.length, 2);
  const budgetOf = (c) => c.argv[c.argv.indexOf("--max-budget-usd") + 1];
  assert.deepEqual(r.calls.map(budgetOf), ["1.00", "0.40"]);
  assert.equal(r.records.at(-1).exitReason, "budget");
});

// A session killed or crashed before its result event reports no cost; the driver prices the usage
// it streamed instead, so the cap still holds. 300k uncached input tokens on claude-sonnet-5-5
// ($2 per million) is $0.60 a session.
test("a session that ends without a result event still counts toward --max-usd, priced from the usage it streamed", async () => {
  const crashing = { ledger: [line(1, "report-received")], noResult: true, exitCode: 1, usage: { input_tokens: 300_000 } };
  const budgetOf = (c) => c.argv[c.argv.indexOf("--max-budget-usd") + 1];
  const r = await drive(makeCycle(), [crashing], { flags: ["--max-usd", "1"] });
  assert.equal(r.code, 6, r.out);
  assert.deepEqual(r.calls.map(budgetOf), ["1.00", "0.40"]);
  assert.match(r.out, /spent \$1\.20 of --max-usd 1/);
  // One request streamed once per content block is priced once.
  const repeated = await drive(makeCycle(), [{ ...crashing, messageId: "msg_1", repeat: 3 }], { flags: ["--max-usd", "1"] });
  assert.equal(repeated.code, 6, repeated.out);
  assert.deepEqual(repeated.calls.map(budgetOf), ["1.00", "0.40"]);
  assert.match(repeated.out, /session 1 ended — [^\n]*, ~\$0\.60 estimated\n/);
});

// Claude Code writes a session's transcript, and each subagent's beside it under
// <session id>/subagents/, as it goes, so both outlive a killed session. A request appears once
// per content block, and a transcript request the stream also carried is priced once. A subagent's
// rows carry the output count from before the request generated anything — the same on every row,
// as Claude Code 2.1.296 writes them — so only its content's length says what it produced. The
// stub's sessions are stub-session-<n>.
test("a session that ends without a result event is also charged its subagents' spend, read from the transcripts it left", async () => {
  const budgetOf = (c) => c.argv[c.argv.indexOf("--max-budget-usd") + 1];
  const assistant = (id, usage, content = []) => JSON.stringify({ type: "assistant", message: { id, model: MODEL, usage, content } });
  // One content block whose JSON is exactly `chars` characters long.
  const blockOf = (chars) => [{ type: "text", text: "x".repeat(chars - JSON.stringify([{ type: "text", text: "" }]).length) }];
  const transcriptsFor = (projects, root, sessions, files) => {
    const slug = join(projects, root.replace(/[^A-Za-z0-9]/g, "-"));
    for (let n = 1; n <= sessions; n++)
      for (const [rel, lines] of Object.entries(files))
        writeInto(slug, rel.replace("<sid>", `stub-session-${n}`), lines.map((l) => l.replace("<sid>", `stub-session-${n}`)).join("\n") + "\n");
  };
  const crashing = { ledger: [line(1, "report-received")], noResult: true, exitCode: 1, usage: { input_tokens: 1 } };
  // 200k input tokens on claude-sonnet-5-5 is $0.40; two 20k-character blocks are at least 20k
  // output tokens, $0.20.
  const pending = { input_tokens: 200_000, output_tokens: 1 };
  const subagent = [assistant("<sid>-sub", pending, blockOf(20_000)), assistant("<sid>-sub", pending, blockOf(20_000))];
  const files = { "<sid>.jsonl": [], "<sid>/subagents/agent-a1.jsonl": subagent, "<sid>/subagents/agent-a1.meta.json": ["{}"] };
  const root = makeCycle();
  const h = harness([crashing], {});
  transcriptsFor(join(h.env.HOME, ".claude", "projects"), root, 3, files);
  const r = await startDriver(root, h, ["--max-usd", "1"]).result();
  assert.equal(r.code, 6, r.out);
  assert.deepEqual(calls(h).map(budgetOf), ["1.00", "0.40"]);
  assert.match(r.out, /spent \$1\.20 of --max-usd 1/);

  // CLAUDE_CONFIG_DIR moves Claude Code's whole config home, transcripts included.
  const moved = makeCycle();
  const config = makeTempDir("devcycle-drive-config-");
  const hm = harness([crashing], { CLAUDE_CONFIG_DIR: config });
  transcriptsFor(join(config, "projects"), moved, 3, files);
  const fromConfig = await startDriver(moved, hm, ["--max-usd", "1"]).result();
  assert.equal(fromConfig.code, 6, fromConfig.out);
  assert.deepEqual(calls(hm).map(budgetOf), ["1.00", "0.40"], "the transcripts under CLAUDE_CONFIG_DIR were not read");

  // Both carry the request's 120 content blocks, the stub's 35-character one: 300k input tokens
  // ($0.60) and 2,100 output tokens ($0.02, or $0.04 with the characters counted twice).
  const shared = makeCycle();
  const sh2 = harness([{ ...crashing, usage: { input_tokens: 300_000 }, messageId: "msg_main", repeat: 120 }], {});
  const sharedRequest = assistant("msg_main", { input_tokens: 300_000, output_tokens: 1 }, [{ type: "tool_use", name: "Bash" }]);
  transcriptsFor(join(sh2.env.HOME, ".claude", "projects"), shared, 3, { "<sid>.jsonl": Array(120).fill(sharedRequest) });
  const once = await startDriver(shared, sh2, ["--max-usd", "1"]).result();
  assert.equal(once.code, 6, once.out);
  assert.deepEqual(calls(sh2).map(budgetOf), ["1.00", "0.38"], "a request in both the stream and the transcript was priced twice");
});

test("a usage limit or a silent session still ends the driver once --max-usd is spent, instead of waiting", async () => {
  const limited = await drive(makeCycle(), [{ rateLimitInSec: 1, costUsd: 2 }, { ledger: DONE, stage: "branch-review" }], { flags: ["--max-usd", "1"] });
  assert.equal(limited.code, 6, limited.out);
  assert.equal(limited.calls.length, 1, "the driver waited out the limit with the cap already spent");
  assert.match(limited.out, /spent \$2\.00 of --max-usd 1/);
  assert.match(limited.out, /session 1 ended — budget; [^\n]*, \$2\.00\n/);

  // The session must stream its usage before it is stopped, so it gets the slow-start allowance.
  const silent = await drive(makeCycle(), [{ hangMs: 60000, usage: { input_tokens: 600_000 } }],
    { flags: ["--max-usd", "1", "--max-backoff", "1"], env: { DEVCYCLE_DRIVE_IDLE_MS: "5000" } });
  assert.equal(silent.code, 6, silent.out);
  assert.match(silent.out, /spent \$1\.20 of --max-usd 1/);
});

// DEVCYCLE_DRIVE_IDLE_MS shortens the 30-minute silence after which the driver stops a session.
// Its clock runs from the spawn, and on a loaded machine the stub can take seconds to start (2.6 s
// measured with 16 copies of this test at once), so the session that must reach its result first
// gets about twice that. A session stopped before any result is judged the same however early it is
// stopped, so those keep a short limit.
test("a session silent past the idle limit after its result is no usage limit; one silent before any result counts as a stall", async () => {
  const finished = await drive(makeCycle(), [{ ledger: DONE, stage: "branch-review", hangAfterResultMs: 60000 }],
    { flags: ["--max-backoff", "0"], env: { DEVCYCLE_DRIVE_IDLE_MS: "5000" } });
  assert.equal(finished.code, 0, finished.out);
  assert.deepEqual(finished.records.map((x) => x.exitReason), ["handoff"]);

  // Silence with no rate-limit signal may still be a limit, so it is waited out — and counted.
  const env = { DEVCYCLE_DRIVE_IDLE_MS: "300" };
  const waited = await drive(makeCycle(), [{ hangMs: 60000 }], { flags: ["--max-backoff", "0"], env });
  assert.equal(waited.code, 6, waited.out);
  assert.deepEqual(waited.records.map((x) => [x.exitReason, x.stallCount]), [["budget", 1]]);

  // A dispatch alone is no progress. This session must reach its ledger line before the stop.
  const hung = await drive(makeCycle(), [{ ledger: [line(1, "dispatched")], hangMs: 60000 }],
    { flags: ["--max-backoff", "0", "--max-stalls", "1"], env: { DEVCYCLE_DRIVE_IDLE_MS: "5000" } });
  assert.equal(hung.code, 5, hung.out);
  assert.match(hung.out, /stalled: 1 sessions in a row added no ledger line beyond a dispatch; the last went silent with no usage-limit signal/);
  assert.deepEqual(hung.records.map((x) => [x.exitReason, x.stallCount]), [["stalled", 1]]);

  // A stall count built partly by a session that ended is not a run of silent sessions.
  const mixed = await drive(makeCycle(), [{ ledger: [line(1, "dispatched")] }, { hangMs: 60000 }],
    { flags: ["--max-backoff", "0", "--max-stalls", "2"], env: { DEVCYCLE_DRIVE_IDLE_MS: "5000" } });
  assert.equal(mixed.code, 5, mixed.out);
  assert.match(mixed.out, /stalled: 2 sessions in a row added no ledger line beyond a dispatch; the last went silent/);
  assert.deepEqual(mixed.records.map((x) => [x.exitReason, x.stallCount]), [["stalled", 1], ["stalled", 2]]);
});

// A subagent can work for longer than the idle limit without its session printing a line, so a
// session stopped for silence is judged on its ledger lines exactly as one that ended: a line beyond
// a dispatch is no stall, and a report, verdict or commit is no churn either. It is still waited out
// as a possible limit. Like the session above, it must reach its ledger lines before the stop.
test("a session stopped for silence is judged on the same progress as one that ended", async () => {
  const flags = ["--max-backoff", "0", "--max-stalls", "1", "--max-churn", "1"];
  const env = { DEVCYCLE_DRIVE_IDLE_MS: "5000" };
  for (const outcome of [DONE[0], line(1, "report-received"), line(1, "review-verdict")]) {
    const r = await drive(makeCycle(), [{ ledger: [line(1, "dispatched"), outcome], hangMs: 60000 }], { flags, env });
    assert.equal(r.code, 6, `${outcome}: ${r.out}`);
    assert.match(r.out, /waiting it out would pass --max-backoff/);
    assert.deepEqual(r.records.map((x) => [x.exitReason, x.stallCount]), [["budget", 0]], outcome);
  }
  const decided = await drive(makeCycle(), [{ ledger: [line(1, "user-decision")], hangMs: 60000 }], { flags, env });
  assert.equal(decided.code, 5, decided.out);
  assert.match(decided.out, /stalled: 1 sessions in a row added ledger lines but no report, verdict or commit/);
  assert.deepEqual(decided.records.map((x) => [x.exitReason, x.stallCount]), [["stalled", 0]]);
});

test("SIGINT stops the running session, writes its record, releases the lock and exits 130", async () => {
  const root = makeCycle();
  const h = harness([{ ledger: [line(1, "dispatched")], hangMs: 60000 }]);
  const d = startDriver(root, h);
  await waitFor(() => calls(h).length === 1);
  const { pid } = calls(h)[0];
  d.child.kill("SIGINT");
  const r = await d.result();
  assert.equal(r.code, 130, r.out);
  assert.ok(!existsSync(lockPath(root)), "the lock outlived an interrupted driver");
  assert.deepEqual(records(h).map((x) => x.exitReason), ["interrupted"]);
  assert.throws(() => process.kill(pid, 0), "the driven session survived the interrupt");
});

test("after a SIGKILL the next driver reclaims the dead holder's lock and carries on", async () => {
  const root = makeCycle();
  const h = harness([{ ledger: [line(1, "dispatched")], hangMs: 60000 }, { ledger: DONE, stage: "branch-review" }]);
  const first = startDriver(root, h);
  await waitFor(() => calls(h).length === 1);
  first.child.kill("SIGKILL");
  await first.result();
  try { process.kill(-calls(h)[0].pid, "SIGKILL"); } catch { /* already gone */ }
  assert.equal(JSON.parse(readFileSync(lockPath(root), "utf8")).pid, first.child.pid, "the killed driver left no lock to reclaim");
  const r = await startDriver(root, h).result();
  assert.equal(r.code, 0, r.out);
  assert.equal(calls(h).length, 2);
  assert.deepEqual(records(h).map((x) => x.exitReason), ["handoff"]);
  assert.ok(!existsSync(lockPath(root)));
});

test("a lock whose pid is alive but whose start time differs is a reused pid, and is reclaimed", async () => {
  const root = makeCycle();
  writeLock(root, { pid: process.pid, startTime: "Thu Jan  1 00:00:00 1970" });
  const r = await drive(root, [{ ledger: DONE, stage: "branch-review" }]);
  assert.equal(r.code, 0, r.out);
});

const isDead = (pid) => { try { process.kill(pid, 0); return false; } catch { return true; } };

test("--detach handles a stale result, returns once the lock names the driver it started with the log offset its run begins at, and the driver walks to branch-review on its own", async () => {
  const root = makeCycle();
  const earlier = "[drive 2026-10-12T00:00:00Z] an earlier run's line\n";
  writeInto(root, ".devcycle/drive.log", earlier);
  writeInto(root, RESULT_REL, JSON.stringify({ outcome: "interrupted", code: 130 }));
  const h = harness([{ ledger: [line(1, "dispatched"), DONE[0]], hangMs: 2000 }, { ledger: [DONE[1]], stage: "branch-review" }]);
  const r = spawnSync(process.execPath, [DRIVER, "--state", join(root, ".devcycle", "state.md"), "--claude", h.bin, "--detach"], { cwd: root, env: h.env, encoding: "utf8" });
  let pid = null;
  try {
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const printed = JSON.parse(r.stdout);
    pid = printed.pid;
    assert.equal(readDriveLockHolder(root)?.pid, pid, "--detach returned before the driver held the lock");
    assert.deepEqual([printed.log, printed.logOffset], [".devcycle/drive.log", Buffer.byteLength(earlier)]);
    assert.notEqual(readDriveResult(root)?.outcome, "interrupted", "the earlier run's result survived into this run");
    assert.equal(JSON.parse(readFileSync(join(root, HANDLED_REL), "utf8")).outcome, "interrupted");
    // A new session's leader leads its own process group too: the caller's hangup cannot reach it.
    assert.equal(spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim(), String(pid));
    await waitFor(() => isDead(pid), 30000);
    assert.deepEqual(records(h).map((x) => x.exitReason), ["handoff", "handoff"]);
    assert.ok(!existsSync(lockPath(root)), "the detached driver left its lock behind");
    assert.equal(readFileSync(join(root, ".devcycle", "drive.log"), "utf8").match(/execution is complete/g)?.length, 1,
      "the detached driver's log lacks the line, or holds it twice");
  } finally {
    if (pid && !isDead(pid)) process.kill(-pid, "SIGKILL");
  }

  const refused = spawnSync(process.execPath, [DRIVER, "--state", join(makeCycle({ branch: "main" }), ".devcycle", "state.md"), "--claude", h.bin, "--detach"], { env: h.env, encoding: "utf8" });
  assert.equal(refused.status, 3, "a pre-flight refusal must reach the caller before anything detaches");
  assert.match(refused.stderr, /default or an integration branch/);
});

// The driver takes the lock before it hands off the last run's result, and in a real run the gap is
// microseconds. A preload in the detached driver alone stretches that hand-off (its rename of
// drive-result.json) to 1.5 s, so a --detach that returned on the lock alone would leave the earlier
// run's result in place.
test("--detach returns only once the driver it started has handed off the previous run's result, not as soon as it holds the lock", async () => {
  const root = makeCycle();
  writeInto(root, RESULT_REL, JSON.stringify({ outcome: "interrupted", code: 130 }));
  const h = harness([{ ledger: DONE, stage: "branch-review" }]);
  const preload = join(dirname(h.callsPath), "slow-hand-off.cjs");
  writeFileSync(preload, [
    'const fs = require("node:fs");',
    'if (!process.argv.includes("--detach")) {',
    "  const rename = fs.renameSync;",
    "  fs.renameSync = (from, to) => {",
    '    if (String(from).endsWith("drive-result.json")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);',
    "    return rename(from, to);",
    "  };",
    '  require("node:module").syncBuiltinESMExports();',
    "}",
  ].join("\n"));
  const env = { ...h.env, NODE_OPTIONS: `${h.env.NODE_OPTIONS ?? ""} --require "${preload}"` };
  const r = spawnSync(process.execPath, [DRIVER, "--state", join(root, ".devcycle", "state.md"), "--claude", h.bin, "--detach"], { cwd: root, env, encoding: "utf8" });
  let pid = null;
  try {
    assert.equal(r.status, 0, r.stdout + r.stderr);
    pid = JSON.parse(r.stdout).pid;
    assert.notEqual(readDriveResult(root)?.outcome, "interrupted", "--detach returned while the earlier run's result was still in place");
    assert.equal(readHandledResult(root)?.outcome, "interrupted");
    await waitFor(() => isDead(pid), 30000);
  } finally {
    if (pid && !isDead(pid)) process.kill(-pid, "SIGKILL");
  }
});

// The child runs the pre-flight the parent just passed, so the refusal here is one only the child
// meets: the lock module fails closed on a reclaim a dead starter left half-done (scripts/drive-lock.mjs).
test("--detach relays a driver that fails to start: its own stderr lines from this run, and its exit code", () => {
  const root = makeCycle();
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  const stale = { pid: dead, startTime: "Thu Jan  1 00:00:00 1970" };
  writeLock(root, stale);
  writeFileSync(`${lockPath(root)}.reclaim`, JSON.stringify({ hostname: hostname(), ...stale }));
  writeInto(root, ".devcycle/drive.log", "drive-execution: an earlier run's refusal\n");
  const h = harness([{ ledger: DONE, stage: "branch-review" }]);
  const r = spawnSync(process.execPath, [DRIVER, "--state", join(root, ".devcycle", "state.md"), "--claude", h.bin, "--detach"], { cwd: root, env: h.env, encoding: "utf8", timeout: 20000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(r.stdout, "", "a driver that never held the lock was reported started");
  assert.match(r.stderr, /^drive-execution: drive-lock: a starter died while reclaiming /m);
  assert.doesNotMatch(r.stderr, /an earlier run's refusal/);
  assert.equal(calls(h).length, 0);
});

// A reclaim mutex a live process (this test) holds keeps the child from the lock until the mutex goes,
// a second here. The detach timeout this once read is set short, so a wait that gives up would show.
test("--detach waits for a slow driver until it takes the lock, with no time limit", async () => {
  const root = makeCycle();
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  writeLock(root, { pid: dead, startTime: "Thu Jan  1 00:00:00 1970" });
  const mutex = `${lockPath(root)}.reclaim`;
  writeFileSync(mutex, JSON.stringify({ hostname: hostname(), pid: process.pid, startTime: processStartTime(process.pid) }));
  const h = harness([{ ledger: DONE, stage: "branch-review" }], { DEVCYCLE_DRIVE_DETACH_TIMEOUT_MS: "300" });
  const detaching = spawn(process.execPath, [DRIVER, "--state", join(root, ".devcycle", "state.md"), "--claude", h.bin, "--detach"], { cwd: root, env: h.env });
  let out = "";
  detaching.stdout.on("data", (d) => { out += d; });
  detaching.stderr.on("data", (d) => { out += d; });
  const code = new Promise((res) => detaching.on("close", res));
  setTimeout(() => rmSync(mutex, { force: true }), 1000);
  const status = await code;
  let pid = null;
  try {
    assert.equal(status, 0, out);
    pid = JSON.parse(out).pid;
    assert.ok(pid > 0, out);
    await waitFor(() => isDead(pid), 30000);
    assert.deepEqual(records(h).map((x) => x.exitReason), ["handoff"]);
  } finally {
    const stray = pid ?? Number(out.match(/pid (\d+)/)?.[1]);
    if (stray && !isDead(stray)) process.kill(-stray, "SIGKILL");
  }
});

test("a second driver on a live lock exits 3, naming the running one, and leaves its lock alone", async () => {
  const root = makeCycle();
  writeLock(root, { pid: process.pid, startTime: processStartTime(process.pid) });
  const before = readFileSync(lockPath(root), "utf8");
  const r = await drive(root, [{ ledger: DONE, stage: "branch-review" }]);
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, new RegExp(`pid ${process.pid}`));
  assert.match(r.out, /\.devcycle\/drive\.lock/, "the refusal does not name the lock file");
  assert.match(r.out, /no longer running[^\n]*remove/, "the refusal does not say how to clear a stale lock");
  assert.equal(r.calls.length, 0);
  assert.equal(readFileSync(lockPath(root), "utf8"), before);
});

test("a session without devcycle loaded, with plugin errors, or a claude that never starts is an environment failure: exit 3", async () => {
  const missing = await drive(makeCycle(), [{ plugins: [{ name: "superpowers" }] }]);
  assert.equal(missing.code, 3, missing.out);
  assert.match(missing.out, /devcycle is not loaded/);
  assert.deepEqual(missing.records.map((x) => x.exitReason), ["environment"]);
  const broken = await drive(makeCycle(), [{ pluginErrors: [{ plugin: "devcycle", error: "bad manifest" }] }]);
  assert.equal(broken.code, 3, broken.out);
  assert.match(broken.out, /plugin error/);
  const qualified = await drive(makeCycle(), [{ pluginErrors: [{ plugin: "devcycle@devcycle", error: "bad manifest" }] }]);
  assert.equal(qualified.code, 3, qualified.out);
  const unrelated = await drive(makeCycle(), [{ pluginErrors: [{ plugin: "other-plugin", error: "bad manifest" }], ledger: DONE, stage: "branch-review" }]);
  assert.equal(unrelated.code, 0, `another plugin's error stopped the driver: ${unrelated.out}`);
  const h = harness();
  const absent = spawnSync(process.execPath, [DRIVER, "--state", join(makeCycle(), ".devcycle", "state.md"), "--claude", join(h.runsDir, "no-such-claude")], { env: h.env, encoding: "utf8" });
  assert.equal(absent.status, 3, absent.stdout + absent.stderr);
  assert.match(absent.stdout + absent.stderr, /cannot run/);
});

test("pre-flight refuses the default branch, an integration branch, a branch other than the recorded one, and an unresolvable default", () => {
  for (const branch of ["main", "dev"]) {
    const r = dryRun(makeCycle({ branch }));
    assert.equal(r.code, 3, `${branch}: ${r.out}`);
    assert.match(r.out, /default or an integration branch/);
  }
  const root = makeCycle();
  sh("git", ["checkout", "-q", "-b", "elsewhere"], { cwd: root });
  const moved = dryRun(root);
  assert.equal(moved.code, 3, moved.out);
  assert.match(moved.out, /on elsewhere, but the state records feat\/drive/);
  const unnamed = makeCycle();
  sh("git", ["branch", "-qm", "main", "trunk"], { cwd: unnamed });
  const unresolved = dryRun(unnamed);
  assert.equal(unresolved.code, 3, unresolved.out);
  assert.match(unresolved.out, /cannot resolve the default branch/);
});

// D5: /devcycle:continue starts the driver from inside its own Claude Code session, so CLAUDECODE
// no longer gates a start; a nested `claude -p` must still never inherit it.
test("a start from inside a Claude Code session with a `drive: auto` row is admitted, and no session it starts sees CLAUDECODE", async () => {
  const seen = join(makeTempDir("devcycle-drive-env-"), "claudecode.log");
  const prelude = `if (process.argv[2] !== "plugin") require("node:fs").appendFileSync(${JSON.stringify(seen)}, (process.env.CLAUDECODE ?? "absent") + "\\n");\n`;
  const inSession = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "the-continue-session" };
  const h = harness([{ ledger: [line(1, "dispatched"), DONE[0]] }, { ledger: [DONE[1]], stage: "branch-review" }], inSession, { prelude });
  const r = await startDriver(makeCycle(), h).result();
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(seen, "utf8"), "absent\nabsent\n", "a driven session inherited CLAUDECODE");
});

const remedy = (path, task) => `${path}: commit, stash or revert it — task ${task} writes this file`;

test("pre-flight allows an in-flight task's tracked edits and untracked files, and refuses a later wave's task's file, naming the file and the task", () => {
  const root = makeCycle();
  writeInto(root, "src/a.txt", "half-done implementer edit\n");
  writeInto(root, "notes.txt", "untracked\n");
  const allowed = dryRun(root);
  assert.equal(allowed.code, 0, allowed.out);
  assert.deepEqual(JSON.parse(allowed.out.trim().split("\n").at(-1)).command.slice(1, 3), ["-p", "/devcycle:continue --drive .devcycle/state.md"]);
  assert.equal(allowed.calls.length, 0, "--dry-run spawned a session");

  writeInto(root, "src/b.txt", "edited ahead of its wave\n");
  const refused = dryRun(root);
  assert.equal(refused.code, 3, refused.out);
  assert.ok(refused.out.includes(`tracked changes a remaining task would overwrite: ${remedy("src/b.txt", 2)}`), refused.out);
});

test("pre-flight lists every tracked change a remaining task would overwrite, more than five included", () => {
  const many = ["src/b.txt", "src/c1.txt", "src/c2.txt", "src/c3.txt", "src/c4.txt", "src/c5.txt"];
  const plan = PLAN.replace("- Modify: src/b.txt", many.map((p) => `- Modify: ${p}`).join("\n"));
  const root = makeCycle({ plan, files: many });
  for (const path of many) writeInto(root, path, "edited before the run\n");
  const r = dryRun(root);
  assert.equal(r.code, 3, r.out);
  assert.ok(r.out.includes(`tracked changes a remaining task would overwrite: ${many.map((p) => remedy(p, 2)).join("; ")}`), r.out);
});

test("tracked changes no remaining task writes — outside the plan, or only in a committed task's Files — are left alone and listed in drive.log", async () => {
  const root = makeCycle();
  writeInto(root, ".devcycle/ledger.md", readFileSync(join(root, ".devcycle/ledger.md"), "utf8") + `- [2026-10-08T00:00:00Z] ${DONE[0]}\n`);
  writeInto(root, "src/a.txt", "edit to a committed task's file\n");
  writeInto(root, "other.txt", "edit outside every task\n");
  const r = await drive(root, [{ ledger: [DONE[1]], stage: "branch-review" }]);
  assert.equal(r.code, 0, r.out);
  const log = readFileSync(join(root, ".devcycle", "drive.log"), "utf8");
  assert.match(log, /\] 2 tracked change\(s\) no remaining task writes are left alone\n\[drive [^\]]+\] other\.txt\n\[drive [^\]]+\] src\/a\.txt\n/);
  assert.ok(log.indexOf("left alone") < log.indexOf("session 1 starts"), "the left-alone list was not logged before the first session");
});

test("classifyTrackedChanges allows in-flight Files, refuses a remaining task's file naming the lowest such task, and leaves every other path alone", () => {
  const plan = [
    "### Task 1: one", "", "**Files:**", "- Modify: src/a.txt", "",
    "### Task 2: two", "", "**Files:**", "- Modify: src/b.txt", "- Modify: shared.txt", "",
    "### Task 3: three", "", "**Files:**", "- Modify: shared.txt", "- Modify: src/c.txt", "",
    "## Dispatch Map", "", "- Wave 1: Task 1", "- Wave 2: Task 2", "- Wave 3: Task 3", "",
  ].join("\n");
  const committed = (...tasks) => tasks.map((t) => ({ task: String(t), event: "committed" }));
  const paths = ["other.txt", "shared.txt", "src/a.txt", "src/b.txt", "src/c.txt"];
  assert.deepEqual(classifyTrackedChanges(plan, [], paths), {
    refused: [{ path: "shared.txt", task: "2" }, { path: "src/b.txt", task: "2" }, { path: "src/c.txt", task: "3" }],
    leftAlone: ["other.txt"],
  });
  assert.deepEqual(classifyTrackedChanges(plan, committed(1), paths), {
    refused: [{ path: "src/c.txt", task: "3" }],
    leftAlone: ["other.txt", "src/a.txt"],
  });
  assert.deepEqual(classifyTrackedChanges(plan, committed(1, 2), paths), { refused: [], leftAlone: ["other.txt", "src/a.txt", "src/b.txt"] });
});

test("a ledger whose Plan: preamble names another plan is a previous cycle's: its lines count as no progress", () => {
  const root = makeCycle();
  writeInto(root, ".devcycle/ledger.md",
    "Plan: `docs/old-plan.md`\nBranch: `feat/drive` (cut from `main` at `0000000`)\n\n" + `- [2026-10-08T00:00:00Z] ${DONE[0]}\n`);
  // Read as this plan's, Task 1 would be committed and an edit to its file a stray change.
  writeInto(root, "src/a.txt", "half-done implementer edit\n");
  const r = dryRun(root);
  assert.equal(r.code, 0, r.out);
});

test("pre-flight refuses a state without the drive row, a state off execution, a model whose window cannot hold a session start, and a sandbox", () => {
  const notOpted = dryRun(makeCycle({ drive: null }));
  assert.equal(notOpted.code, 3, notOpted.out);
  assert.ok(notOpted.out.includes("the state file has no `drive: auto` row — run /devcycle:continue and answer Start unattended"), notOpted.out);

  const planning = dryRun(makeCycle({ stage: "planning" }));
  assert.equal(planning.code, 3, planning.out);
  assert.match(planning.out, /stage planning, not execution/);

  assert.equal(SESSION_START_TOKENS, 55000);
  const small = dryRun(makeCycle(), ["--model", "claude-haiku-4-5-20251001"]);
  assert.equal(small.code, 3, small.out);
  assert.match(small.out, /over-budget band/);

  const home = makeTempDir("devcycle-drive-readonly-home-");
  chmodSync(home, 0o500);
  try {
    const sandbox = dryRun(makeCycle(), [], { HOME: home });
    assert.equal(sandbox.code, 3, sandbox.out);
    assert.ok(sandbox.out.includes('the Claude Code Bash sandbox blocks ~/.claude — /devcycle:continue retries the start outside the sandbox through a permission prompt; from a terminal, use one that is not a Claude Code session ("!" runs inside the session)'), sandbox.out);
  } finally {
    chmodSync(home, 0o700);
  }
});

test("--check-sandbox answers {sandboxed} alone, in a Claude Code session too, and touches no state; usage errors exit 2", () => {
  const h = harness();
  const run = (args, env = {}) => spawnSync(process.execPath, [DRIVER, ...args], { env: { ...h.env, ...env }, encoding: "utf8" });
  const probe = run(["--check-sandbox"], { CLAUDE_CODE_SESSION_ID: "a-session-id" });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout), { sandboxed: false });
  for (const args of [[], ["--state"], ["--state", "x", "--bogus"], ["--state", "x", "--max-stalls", "0"], ["--state", "x", "--max-usd", "abc"],
  ])
    assert.equal(run(args).status, 2, `expected a usage error for ${JSON.stringify(args)}`);
});

test("inFlightFiles names the first wave with an uncommitted task and only its uncommitted tasks' files", () => {
  const entry = (task, event) => ({ task: String(task), event });
  assert.deepEqual(inFlightFiles(PLAN, []), { wave: 1, files: new Set(["src/a.txt"]) });
  assert.deepEqual(inFlightFiles(PLAN, [entry(1, "dispatched")]), { wave: 1, files: new Set(["src/a.txt"]) });
  assert.deepEqual(inFlightFiles(PLAN, [entry(1, "committed")]), { wave: 2, files: new Set(["src/b.txt"]) });
  assert.deepEqual(inFlightFiles(PLAN, [entry(1, "committed"), entry(2, "committed")]), { wave: null, files: new Set() });
  // A later wave's task the ledger already names was dispatched ahead by readiness: in flight too.
  const ahead = PLAN.replace("**Dependencies:** Tasks 1 committed", "**Dependencies:** none (completely independent)");
  assert.deepEqual(inFlightFiles(ahead, [entry(2, "dispatched")]), { wave: 1, files: new Set(["src/a.txt", "src/b.txt"]) });
});

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const statePathOf = (root) => join(root, ".devcycle", "state.md");
function resultOf(root) {
  const r = readDriveResult(root);
  assert.ok(r, "the driver wrote no .devcycle/drive-result.json");
  return r;
}
// A driver whose session hangs, stopped in `finally` with its session's group if a test fails first.
async function withHungDriver(fn) {
  const root = makeCycle();
  const h = harness([{ ledger: [line(1, "dispatched")], hangMs: 60000 }]);
  const d = startDriver(root, h);
  try {
    await waitFor(() => calls(h).length === 1);
    await fn({ root, h, d });
  } finally {
    if (d.child.exitCode === null) d.child.kill("SIGKILL");
    try { process.kill(-calls(h)[0].pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

test("a run that reaches branch-review writes drive-result.json: outcome complete, progressed, stamped", async () => {
  const root = makeCycle();
  const r = await drive(root, [{ ledger: [line(1, "dispatched"), DONE[0]] }, { ledger: [DONE[1]], stage: "branch-review" }]);
  assert.equal(r.code, 0, r.out);
  const res = resultOf(root);
  assert.deepEqual([res.code, res.outcome, res.reason, res.task, res.detail, res.progressed, res.noProgressEnds], [0, "complete", null, null, "", true, 0]);
  assert.match(res.startedAt, STAMP);
  assert.match(res.endedAt, STAMP);
  assert.equal(classifyDrive({ statePath: statePathOf(root) }).next, "branch-review");
});

test("a gate stop copies the stop's reason, task and detail into the result; a stop with no --task records task null", async () => {
  const root = makeCycle();
  const r = await drive(root, [{ ledger: [line(1, "report-received")], stop: { reason: "needs-user", detail: "task 2 is blocked", task: "2" } }]);
  assert.equal(r.code, 4, r.out);
  const res = resultOf(root);
  assert.deepEqual([res.code, res.outcome, res.reason, res.task, res.detail, res.progressed, res.noProgressEnds],
    [4, "gate-stop", "needs-user", "2", "task 2 is blocked", true, 0]);
  const bare = makeCycle();
  assert.equal((await drive(bare, [{ stop: { reason: "branch", detail: "off the topic branch" } }])).code, 4);
  assert.deepEqual([resultOf(bare).reason, resultOf(bare).task], ["branch", null]);
});

test("a budget end records why: max-usd over the dollar cap, wait-cap past --max-backoff", async () => {
  const spent = makeCycle();
  assert.equal((await drive(spent, [{ ledger: [line(1, "report-received")], costUsd: 0.6 }], { flags: ["--max-usd", "1"] })).code, 6);
  assert.deepEqual([resultOf(spent).outcome, resultOf(spent).reason], ["budget", "max-usd"]);
  // Silence is waited out like a limit with no reset, under Task 6's rules too, so a zero
  // --max-backoff reaches wait-cap at once, with no real-time wait.
  const capped = makeCycle();
  assert.equal((await drive(capped, [{ hangMs: 60000 }], { flags: ["--max-backoff", "0"], env: { DEVCYCLE_DRIVE_IDLE_MS: "300" } })).code, 6);
  const res = resultOf(capped);
  assert.deepEqual([res.outcome, res.reason, res.progressed, res.noProgressEnds], ["budget", "wait-cap", false, 1]);
  assert.equal(classifyDrive({ statePath: statePathOf(capped) }).next, "restart");
});

test("SIGINT with no stop request records interrupted, which the next continue restarts", async () => {
  await withHungDriver(async ({ root, d }) => {
    d.child.kill("SIGINT");
    const r = await d.result();
    assert.equal(r.code, 130, r.out);
    const res = resultOf(root);
    assert.deepEqual([res.code, res.outcome, res.progressed, res.noProgressEnds], [130, "interrupted", false, 1]);
    assert.equal(classifyDrive({ statePath: statePathOf(root) }).next, "restart");
  });
});

test("--stop writes the stop request and SIGTERMs the driver, which records stopped; with no driver running --stop exits 3", async () => {
  let stoppedRoot;
  await withHungDriver(async ({ root, h, d }) => {
    stoppedRoot = root;
    const stop = spawnSync(process.execPath, [DRIVER, "--stop", "--state", statePathOf(root)], { cwd: root, env: h.env, encoding: "utf8" });
    assert.equal(stop.status, 0, stop.stdout + stop.stderr);
    assert.deepEqual(JSON.parse(stop.stdout), { stopped: true, pid: d.child.pid });
    const r = await d.result();
    assert.equal(r.code, 130, r.out);
    assert.deepEqual([resultOf(root).code, resultOf(root).outcome], [130, "stopped"]);
    assert.equal(existsSync(join(root, STOP_REQUEST_REL)), false, "the stop request outlived the run it stopped");
    assert.deepEqual(records(h).map((x) => x.exitReason), ["interrupted"]);
    const c = classifyDrive({ statePath: statePathOf(root) });
    assert.deepEqual([c.next, c.reason], ["answer-gate", "stopped"], "a stopped run must never restart unasked");
  });
  const none = spawnSync(process.execPath, [DRIVER, "--stop", "--state", statePathOf(stoppedRoot)], { encoding: "utf8" });
  assert.equal(none.status, 3, none.stdout + none.stderr);
  assert.equal(none.stderr, `drive-execution: no driver is running for ${statePathOf(stoppedRoot)}\n`);
  assert.equal(existsSync(join(stoppedRoot, STOP_REQUEST_REL)), false);
});

test("--mark-handled hands off the result once continue has acted on it, says whether there was one, and needs --state", () => {
  const root = makeCycle();
  writeInto(root, RESULT_REL, JSON.stringify({ code: 4, outcome: "gate-stop", reason: "needs-user", noProgressEnds: 0 }));
  writeInto(root, ".devcycle/drive-progress.json", "{}\n");
  const mark = (args) => spawnSync(process.execPath, [DRIVER, "--mark-handled", ...args], { cwd: root, encoding: "utf8" });
  const first = mark(["--state", statePathOf(root)]);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), { handled: true });
  assert.equal(existsSync(join(root, ".devcycle", "drive-progress.json")), false, "the drive band outlived the handled result");
  assert.equal(readDriveResult(root), null);
  assert.equal(readHandledResult(root).outcome, "gate-stop");
  assert.equal(classifyDrive({ statePath: statePathOf(root) }).next, "none");
  const second = mark(["--state", statePathOf(root)]);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout), { handled: false });
  assert.equal(mark([]).status, 2, "--mark-handled without --state");
});

// A stopped run never restarts unasked, so only a start that passes its pre-flight and holds the
// lock may hand off the result it supersedes.
test("a --dry-run, or a start its pre-flight refuses, leaves an unhandled result and a stop request where they are", async () => {
  const stopped = { code: 130, outcome: "stopped", noProgressEnds: 0 };
  const untouched = (root, label) => {
    assert.equal(readDriveResult(root)?.outcome, "stopped", `${label} handled a result it never acted on`);
    assert.equal(readHandledResult(root), null, label);
    assert.ok(existsSync(join(root, STOP_REQUEST_REL)), `${label} removed the stop request`);
  };
  const passing = makeCycle();
  const refusedBranch = makeCycle({ branch: "main" });
  const notOpted = makeCycle({ drive: null });
  for (const root of [passing, refusedBranch, notOpted]) {
    writeInto(root, RESULT_REL, JSON.stringify(stopped));
    writeInto(root, STOP_REQUEST_REL, "2026-10-13T00:00:00Z\n");
  }
  const dry = dryRun(passing);
  assert.equal(dry.code, 0, dry.out);
  untouched(passing, "a passing --dry-run");
  assert.equal(dryRun(refusedBranch).code, 3);
  untouched(refusedBranch, "a refused --dry-run");
  assert.equal(dryRun(notOpted).code, 3);
  untouched(notOpted, "a --dry-run refused for the missing drive row");
  assert.deepEqual([classifyDrive({ statePath: statePathOf(notOpted) }).next, classifyDrive({ statePath: statePathOf(notOpted) }).reason], ["answer-gate", "stopped"]);
  const started = await drive(refusedBranch, [{ ledger: DONE, stage: "branch-review" }]);
  assert.equal(started.code, 3, started.out);
  untouched(refusedBranch, "a refused start");
});

test("a start that passes its pre-flight marks the result left unhandled as handled and clears a stale stop request", async () => {
  // The handled end chains into this run's count: a second resumable end without progress.
  const again = makeCycle();
  writeInto(again, RESULT_REL, JSON.stringify({ code: 130, outcome: "interrupted", progressed: false, noProgressEnds: 1 }));
  writeInto(again, STOP_REQUEST_REL, "2026-10-13T00:00:00Z\n");
  const r = await drive(again, [{ hangMs: 60000 }], { flags: ["--max-backoff", "0"], env: { DEVCYCLE_DRIVE_IDLE_MS: "300" } });
  assert.equal(r.code, 6, r.out);
  assert.equal(r.calls.length, 1, "a stale stop request stopped the run it predates");
  assert.equal(readHandledResult(again).outcome, "interrupted");
  assert.equal(existsSync(join(again, STOP_REQUEST_REL)), false);
  assert.equal(resultOf(again).noProgressEnds, 2);
  const c = classifyDrive({ statePath: statePathOf(again) });
  assert.deepEqual([c.next, c.reason], ["answer-gate", "no-progress"]);
});

// A driver killed outright (SIGKILL, out of memory) records no end of its own; the result it wrote as
// it started is what the next /devcycle:continue reads.
async function killDriverMidRun(root, h, { until = () => true } = {}) {
  const sessions = calls(h).length;
  const d = startDriver(root, h);
  try {
    await waitFor(() => calls(h).length > sessions && until(), 10000);
  } finally {
    if (d.child.exitCode === null) d.child.kill("SIGKILL");
    await d.result();
    try { process.kill(-calls(h).at(-1).pid, "SIGKILL"); } catch { /* already gone */ }
  }
  return classifyDrive({ statePath: statePathOf(root) });
}

test("a driver killed mid-run reads as crashed and restarts; a restart killed again with no progress becomes the no-progress question", async () => {
  const root = makeCycle();
  const h = harness([{ ledger: [line(1, "dispatched")], hangMs: 60000 }]);
  const first = await killDriverMidRun(root, h);
  assert.deepEqual([first.outcome, first.noProgressEnds, first.next], ["crashed", 1, "restart"]);
  const second = await killDriverMidRun(root, h);
  assert.deepEqual([second.outcome, second.noProgressEnds, second.next, second.reason], ["crashed", 2, "answer-gate", "no-progress"]);
});

test("a driver killed after its run made progress, mid-session included, reads as a crash to restart whatever ended before it", async () => {
  const root = makeCycle();
  writeInto(root, RESULT_REL, JSON.stringify({ code: 130, outcome: "interrupted", progressed: false, noProgressEnds: 1 }));
  const h = harness([{ ledger: [line(1, "dispatched"), line(1, "report-received")], hangMs: 60000 }]);
  const c = await killDriverMidRun(root, h, { until: () => readDriveResult(root)?.progressed === true });
  assert.deepEqual([c.outcome, c.progressed, c.noProgressEnds, c.next], ["crashed", true, 0, "restart"]);
});

test("a session event the driver fails on ends the run as failed, with its result written and its lock released", async () => {
  const root = makeCycle();
  // An init event whose plugin list is no list.
  const r = await drive(root, [{ plugins: { devcycle: true } }]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^drive-execution: session 1's output broke the driver \(.+\) — /m);
  assert.deepEqual([resultOf(root).code, resultOf(root).outcome], [1, "failed"]);
  assert.ok(!existsSync(lockPath(root)), "the driver left its lock behind");
  assert.equal(classifyDrive({ statePath: statePathOf(root) }).next, "restart");
});

// A driver another user or a sandbox started may refuse the signal (EPERM) while it runs on. Only a
// pid that no longer exists (ESRCH) means no driver runs. The kill is injected: this test's own
// process stands in as the live holder.
test("--stop keeps the stop request and says so when the driver cannot be signalled; only a driver that is gone reads as not running", (t) => {
  const root = makeCycle();
  writeLock(root, { pid: process.pid, startTime: processStartTime(process.pid) });
  const said = [];
  t.mock.method(console, "error", (msg) => said.push(msg));
  t.mock.method(console, "log", (msg) => said.push(msg));
  const refusing = (code) => () => {
    throw Object.assign(new Error(`kill ${code}`), { code });
  };
  assert.equal(stopDriver(statePathOf(root), { kill: refusing("EPERM") }), 1);
  assert.ok(existsSync(join(root, STOP_REQUEST_REL)), "the stop request was removed while the driver may still run");
  assert.doesNotMatch(said.join("\n"), /no driver is running/);
  assert.match(said.join("\n"), new RegExp(`^drive-execution: could not signal the driver \\(pid ${process.pid}: EPERM\\)`, "m"));
  assert.match(said.join("\n"), /the stop request stays in \.devcycle\/drive-stop-request/);

  said.length = 0;
  assert.equal(stopDriver(statePathOf(root), { kill: refusing("ESRCH") }), 3);
  assert.equal(existsSync(join(root, STOP_REQUEST_REL)), false);
  assert.deepEqual(said, [`drive-execution: no driver is running for ${statePathOf(root)}`]);
});

// Where ps cannot run, a live pid may be the driver or a later process that reused a dead driver's
// pid. The watcher may trust it; a signal must not, since it would land on that other process. A
// PATH with no ps in it stands in for such a sandbox.
test("--stop sends no signal when ps cannot confirm the pid is still the driver: the stop request stays and it says so", (t) => {
  const root = makeCycle();
  writeLock(root, { pid: process.pid, startTime: processStartTime(process.pid) });
  const said = [];
  t.mock.method(console, "error", (msg) => said.push(msg));
  t.mock.method(console, "log", (msg) => said.push(msg));
  const signalled = [];
  const path = process.env.PATH;
  process.env.PATH = makeTempDir("devcycle-no-ps-");
  let code;
  try {
    code = stopDriver(statePathOf(root), { kill: (pid, signal) => signalled.push([pid, signal]) });
  } finally {
    process.env.PATH = path;
  }
  assert.deepEqual(signalled, [], "a pid ps could not confirm was signalled");
  assert.equal(code, 1);
  assert.ok(existsSync(join(root, STOP_REQUEST_REL)), "the stop request was removed while the driver may still run");
  assert.match(said.join("\n"), new RegExp(`^drive-execution: cannot confirm pid ${process.pid} is still the driver`, "m"));
  assert.match(said.join("\n"), /the stop request stays in \.devcycle\/drive-stop-request/);
});

// What makes a stop request on disk work without the signal: the driver reads it between sessions
// and in every slice of a wait. The fake claude writes it during session 1, as a --stop whose signal
// was refused would.
test("a driver that finds a stop request on disk ends as stopped before its next session, or within a slice of a wait", async () => {
  const request = `require("node:fs").writeFileSync(${JSON.stringify(STOP_REQUEST_REL)}, "2026-10-13T00:00:00Z\\n");\n`;
  const root = makeCycle();
  const h = harness([{ ledger: [line(1, "dispatched"), DONE[0]] }, { ledger: [DONE[1]], stage: "branch-review" }], {}, { prelude: request });
  const r = await startDriver(root, h).result();
  assert.equal(r.code, 130, r.out);
  assert.equal(calls(h).length, 1, "the driver started a session after a stop request");
  assert.equal(resultOf(root).outcome, "stopped");
  assert.equal(existsSync(join(root, STOP_REQUEST_REL)), false);

  const waiting = makeCycle();
  const hw = harness([{ rateLimitInSec: 3600 }], { DEVCYCLE_DRIVE_SLICE_MS: "50" });
  const d = startDriver(waiting, hw);
  try {
    const log = join(waiting, ".devcycle", "drive.log");
    await waitFor(() => existsSync(log) && /wait: usage limit/.test(readFileSync(log, "utf8")));
    writeInto(waiting, STOP_REQUEST_REL, "2026-10-13T00:00:00Z\n");
    const ended = await Promise.race([d.result(), new Promise((res) => setTimeout(() => res(null), 10000))]);
    assert.ok(ended, "the driver waited on past a stop request");
    assert.equal(ended.code, 130, ended.out);
    assert.equal(resultOf(waiting).outcome, "stopped");
  } finally {
    if (d.child.exitCode === null) d.child.kill("SIGKILL");
  }
});

const readProgress = (root) => {
  try {
    return JSON.parse(readFileSync(join(root, ".devcycle", "drive-progress.json"), "utf8"));
  } catch {
    return null;
  }
};
const driveLogOf = (root) => (existsSync(join(root, ".devcycle", "drive.log")) ? readFileSync(join(root, ".devcycle", "drive.log"), "utf8") : "");
const timeless = ({ startedAt: _s, updatedAt: _u, ...rest }) => rest;
const setClock = (path, ms) => {
  writeFileSync(`${path}.tmp`, String(ms));
  renameSync(`${path}.tmp`, path);
};
const PROGRESS_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

test("the driver keeps .devcycle/drive-progress.json on the run: running per session, waiting with its deadline and a heartbeat, then ended complete", async () => {
  const root = makeCycle();
  const dir = makeTempDir("devcycle-drive-progress-");
  const clock = join(dir, "clock");
  const t0 = Math.floor(Date.now() / 1000) * 1000;
  setClock(clock, t0);
  // Each session's fake claude records the progress file as the session finds it.
  const snaps = join(dir, "snaps.jsonl");
  const prelude = `if (process.argv[2] !== "plugin") { const fs = require("node:fs"); let p = "null\\n"; ` +
    `try { p = fs.readFileSync(".devcycle/drive-progress.json", "utf8"); } catch {} fs.appendFileSync(${JSON.stringify(snaps)}, p); }\n`;
  const h = harness([
    { ledger: [line(1, "dispatched")], rateLimitInSec: 60 },
    { ledger: [DONE[0], line(2, "dispatched"), DONE[1]], stage: "branch-review" },
  ], { DEVCYCLE_DRIVE_CLOCK_FILE: clock, DEVCYCLE_DRIVE_SLICE_MS: "5", DEVCYCLE_DRIVE_HEARTBEAT_MS: "50" }, { prelude });
  const driver = startDriver(root, h);
  try {
    await waitFor(() => driveLogOf(root).includes("] wait: "));
    const waiting = readProgress(root);
    assert.equal(waiting?.state, "waiting", JSON.stringify(waiting));
    assert.equal(waiting.session, 1);
    assert.equal(waiting.waitWhat, "usage limit until its reset");
    assert.equal(waiting.waitUntil, driveLogOf(root).match(/wait: usage limit until its reset — resuming at (\S+)/)[1]);
    assert.equal(Date.parse(waiting.waitUntil), t0 + 120_000, "the deadline is the limit's reset plus the driver's one-minute margin");
    assert.deepEqual(waiting.waves[0].tasks, [{ task: "1", step: "implementing", round: 0, rejections: 0 }]);
    // The clock stands still, so nothing is logged while it waits: only the heartbeat can move updatedAt.
    const refreshed = await new Promise((done) => {
      const until = Date.now() + 3000;
      const poll = () => {
        const p = readProgress(root);
        if (p && p.updatedAt !== waiting.updatedAt) done(p);
        else if (Date.now() > until) done(null);
        else setTimeout(poll, 25);
      };
      poll();
    });
    assert.equal(refreshed?.state, "waiting", "no heartbeat refreshed updatedAt while the driver waited with nothing to log");
    setClock(clock, t0 + 10 * 60_000);
    const r = await driver.result();
    assert.equal(r.code, 0, r.out);
    const log = driveLogOf(root);
    const effort = log.match(/\] session 1 starts — .*, effort ([^,]+),/)[1];
    const [atSession1, atSession2, ...more] = readFileSync(snaps, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(more, [], "a fake claude ran more than twice");
    const pending = { v: 1, state: "running", model: MODEL, effort, waitUntil: null, waitWhat: null, stopDetail: null, outcome: null, total: 2 };
    assert.deepEqual(timeless(atSession1), { ...pending, session: 1, currentWave: 1, committed: 0, waves: [
      { wave: 1, committed: 0, tasks: [{ task: "1", step: "pending", round: 0, rejections: 0 }] },
      { wave: 2, committed: 0, tasks: [{ task: "2", step: "pending", round: 0, rejections: 0 }] },
    ] });
    assert.deepEqual(timeless(atSession2), { ...pending, session: 2, currentWave: 1, committed: 0, waves: [
      { wave: 1, committed: 0, tasks: [{ task: "1", step: "implementing", round: 0, rejections: 0 }] },
      { wave: 2, committed: 0, tasks: [{ task: "2", step: "pending", round: 0, rejections: 0 }] },
    ] });
    const final = readProgress(root);
    assert.deepEqual(timeless(final), { ...pending, state: "ended", outcome: "complete", session: 2, currentWave: null, committed: 2, waves: [
      { wave: 1, committed: 1, tasks: [{ task: "1", step: "committed", round: 0, rejections: 0 }] },
      { wave: 2, committed: 1, tasks: [{ task: "2", step: "committed", round: 0, rejections: 0 }] },
    ] });
    assert.match(final.startedAt, PROGRESS_ISO);
    assert.equal(final.startedAt, atSession1.startedAt, "startedAt moved during the run");
    assert.match(final.updatedAt, PROGRESS_ISO);
  } finally {
    driver.child.kill("SIGKILL");
  }
});

test("--mark-handled clears the band of a run that ended complete and keeps the result as the handled one", async () => {
  const root = makeCycle();
  const r = await drive(root, [{ ledger: [line(1, "dispatched"), DONE[0]] }, { ledger: [DONE[1]], stage: "branch-review" }]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual([readProgress(root)?.state, readProgress(root)?.outcome], ["ended", "complete"], "the band's data is the run's end until continue handles it");
  const mark = spawnSync(process.execPath, [DRIVER, "--mark-handled", "--state", statePathOf(root)], { cwd: root, encoding: "utf8" });
  assert.equal(mark.status, 0, mark.stdout + mark.stderr);
  assert.equal(existsSync(join(root, ".devcycle", "drive-progress.json")), false, "the band outlived the handled end");
  assert.equal(readHandledResult(root).outcome, "complete");
  assert.equal(classifyDrive({ statePath: statePathOf(root) }).next, "none");
});

// The band says "run /devcycle:continue" for an ended run until continue handles it; the two ends that
// hand off to a later stage are handled by the handoff itself, so the doc must run the command there.
test("references/drive.md marks a run that ended complete or left execution as handled once its handoff is emitted", () => {
  const doc = readFileSync(fileURLToPath(new URL("../../references/drive.md", import.meta.url)), "utf8");
  const ends = doc.split(/^## /m).find((section) => section.startsWith("When the run ends"));
  assert.ok(ends, "references/drive.md has no `## When the run ends` section");
  for (const next of ["branch-review", "resume-stage"]) {
    const bullet = ends.split(/^- /m).find((b) => b.startsWith(`\`${next}\``));
    assert.ok(bullet, `§ When the run ends has no \`${next}\` bullet`);
    assert.ok(bullet.includes("--mark-handled"), `the \`${next}\` bullet never marks the end handled, so the band keeps saying the run is waiting for continue`);
  }
});

test("a stop for the user leaves the progress file stopped with the stop's reason and detail, and the task's step, round and rejections", async () => {
  const root = makeCycle();
  const review = [
    "task=1 event=dispatched outcome=ok ref=none",
    "task=1 event=report-received outcome=complete ref=none",
    "task=1 event=review-round outcome=round 1 ref=none key=1/review-round/1/0",
    "task=1 event=review-verdict outcome=rejected ref=none key=1/review-verdict/1/0",
    "task=1 event=report-received outcome=rejected (intake bounce) ref=none key=1/report-received/2/0",
    "task=1 event=review-round outcome=round 2 ref=none key=1/review-round/2/0",
    "task=1 event=review-verdict outcome=rejected (missing findings file) ref=none key=1/review-verdict/2/0",
  ];
  const r = await drive(root, [{ ledger: review, stop: { reason: "needs-user", detail: "task 1: a decision" } }]);
  assert.equal(r.code, 4, r.out);
  const p = readProgress(root);
  assert.equal(p?.state, "stopped", JSON.stringify(p));
  assert.equal(p.stopDetail, "needs-user: task 1: a decision");
  assert.match(driveLogOf(root), /stopped for you — needs-user: task 1: a decision\n/);
  assert.equal(p.outcome, null);
  assert.equal(p.session, 1);
  assert.equal(p.currentWave, 1);
  assert.deepEqual(p.waves[0].tasks, [{ task: "1", step: "reviewing", round: 2, rejections: 2 }]);
});

test("--dry-run writes no progress file", () => {
  const root = makeCycle();
  const r = dryRun(root);
  assert.equal(r.code, 0, r.out);
  assert.equal(existsSync(join(root, ".devcycle", "drive-progress.json")), false);
});
