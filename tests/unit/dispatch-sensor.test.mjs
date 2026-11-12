import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { makeRepo, writeInto } from "./helpers.mjs";
import { repoSlug, gitToplevel, hashSession } from "../../scripts/run-record.mjs";
import { readProcesses, recordProcess } from "../../scripts/process-registry.mjs";
import { acquireDriveLock, driveTokenHash, releaseDriveLock } from "../../scripts/drive-lock.mjs";

const HOOK = new URL("../../hooks/dispatch-sensor.mjs", import.meta.url).pathname;
const SCHEMA = JSON.parse(readFileSync(new URL("../fixtures/run-record.schema.json", import.meta.url), "utf8"));
const ROW_SCHEMA = SCHEMA.oneOf.find((b) => b.title === "agent-depth").properties;
const RUN = "00000000000000a1";
const SESSION = "cycle-session-resumed";
const usage = (i, cc, cr, o) => ({ input_tokens: i, cache_creation_input_tokens: cc, cache_read_input_tokens: cr, output_tokens: o });

// `sessions` seeds the run file with the `session` rows cycle.md/continue.md append per real session.
function fixture({ depth = 16149, stage = "planning", run = RUN, model = "claude-haiku-4-5-20251001", sessions = [SESSION] } = {}) {
  const repo = makeRepo();
  writeInto(repo, ".devcycle/state.md", `# devcycle state\n- stage: ${stage}\n- run: ${run}\n`);
  const runsDir = makeTempDir("dispatch-sensor-runs");
  if (sessions.length) {
    const runFile = join(runsDir, repoSlug(gitToplevel(repo)), `${run}.jsonl`);
    mkdirSync(dirname(runFile), { recursive: true });
    writeFileSync(runFile, sessions.map((id) => JSON.stringify({ kind: "session", runId: run, sessionHash: hashSession(id) }) + "\n").join(""));
  }
  const transcript = join(makeTempDir("dispatch-sensor-t"), "agent-a3382414bf84c15db.jsonl");
  writeFileSync(transcript, [
    { type: "user", timestamp: "2026-10-07T07:18:05.680Z", message: { content: "go" } },
    { type: "assistant", timestamp: "2026-10-07T07:18:12.261Z",
      message: { model, usage: usage(depth, 0, 0, 38), content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] } },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { repo, runsDir, transcript };
}

function callHook({ repo, runsDir, transcript }, extra = {}) {
  return spawnSync("node", [HOOK], {
    input: JSON.stringify({ hook_event_name: "SubagentStop", agent_id: "a3382414bf84c15db", agent_type: "devcycle:plan-researcher",
      agent_transcript_path: transcript, cwd: repo, session_id: SESSION, stop_hook_active: false, ...extra }),
    encoding: "utf8", env: { ...process.env, DEVCYCLE_RUNS_DIR: runsDir } });
}

// The rows the hook appended: everything in the repo's runs dir except the seeded session rows.
function rows(repo, runsDir) {
  const dir = join(runsDir, repoSlug(gitToplevel(repo)));
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)))
    .filter((o) => o.kind !== "session");
}

test("a finished subagent leaves one agent-depth row with its final depth", () => {
  const fx = fixture();
  const r = callHook(fx);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  const [row, ...rest] = rows(fx.repo, fx.runsDir);
  assert.equal(rest.length, 0);
  assert.equal(row.kind, "agent-depth");
  assert.equal(row.stage, "planning");
  assert.equal(row.agentType, "devcycle:plan-researcher");
  assert.equal(row.agentId, "a3382414bf84c15db");
  assert.equal(row.model, "claude-haiku-4-5-20251001");
  assert.equal(row.tokens, 16149);
  assert.equal(row.toolUses, 1);
  assert.equal(row.durationMs, 6581);
  assert.equal(row.depth, "ok");
});

test("above 150k the row says warn; above 200k it says breach and a depth-breach event follows", () => {
  const warn = fixture({ depth: 150_001 });
  callHook(warn);
  assert.equal(rows(warn.repo, warn.runsDir)[0].depth, "warn");
  const breach = fixture({ depth: 200_001 });
  callHook(breach);
  const all = rows(breach.repo, breach.runsDir);
  assert.equal(all.find((o) => o.kind === "agent-depth").depth, "breach");
  assert.deepEqual(all.filter((o) => o.kind === "event").map((o) => [o.event, o.stage]), [["depth-breach", "planning"]]);
});

test("no state file, a run of none, a stage outside the enum, malformed input: silent exit 0, nothing written", () => {
  const fx = fixture({ run: "none" });
  assert.equal(callHook(fx).status, 0);
  const done = fixture({ stage: "done" });
  assert.equal(callHook(done).status, 0);
  const bare = { ...fixture({ sessions: [] }), repo: makeTempDir("dispatch-sensor-norepo") };
  assert.equal(callHook(bare).status, 0);
  const junkRuns = makeTempDir("dispatch-sensor-junk-runs");
  const junk = spawnSync("node", [HOOK], { input: "{not json", encoding: "utf8", env: { ...process.env, DEVCYCLE_RUNS_DIR: junkRuns } });
  assert.equal(junk.status, 0);
  assert.equal(junk.stdout + junk.stderr, "");
  assert.deepEqual(readdirSync(junkRuns), []);
  for (const f of [fx, done]) assert.deepEqual(rows(f.repo, f.runsDir), []);
  assert.deepEqual(readdirSync(bare.runsDir), []);
});

test("a parallel session that never joined the run records nothing, even past the breach line", () => {
  const fx = fixture({ depth: 250_000 });
  const r = callHook(fx, { session_id: "UNRELATED-PARALLEL-SESSION" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.deepEqual(rows(fx.repo, fx.runsDir), []);
});

test("after a /clear resume every session row of the run counts as the cycle's, not only the latest", () => {
  const before = "cycle-session-started";
  for (const sessionId of [before, SESSION]) {
    const fx = fixture({ sessions: [before, SESSION] });
    assert.equal(callHook(fx, { session_id: sessionId }).status, 0);
    assert.deepEqual(rows(fx.repo, fx.runsDir).map((o) => o.kind), ["agent-depth"], sessionId);
  }
});

test("no session_id, a non-string one, or a run with no record yet: nothing written, silent exit 0", () => {
  for (const extra of [{ session_id: undefined }, { session_id: "" }, { session_id: 42 }]) {
    const fx = fixture();
    const r = callHook(fx, extra);
    assert.equal(r.status, 0);
    assert.equal(r.stdout + r.stderr, "");
    assert.deepEqual(rows(fx.repo, fx.runsDir), [], JSON.stringify(extra));
  }
  const unrecorded = fixture({ sessions: [] });
  assert.equal(callHook(unrecorded).status, 0);
  assert.deepEqual(readdirSync(unrecorded.runsDir), []);
});

test("model-authored strings are sanitized to the agent-depth schema: control characters stripped, length capped", () => {
  const fx = fixture({ model: "claude haiku/4\u001b[31m" + "m".repeat(200) });
  callHook(fx, { agent_type: "evil\u001b[31m\ntype" + "x".repeat(200), agent_id: "A3382414BF-x\u0007" + "f".repeat(60) });
  const row = rows(fx.repo, fx.runsDir)[0];
  for (const key of ["agentType", "agentId", "model"]) assert.match(row[key], new RegExp(ROW_SCHEMA[key].pattern), key);
  assert.ok(!row.agentType.includes("\u001b"));
});

test("an agent_id with nothing schema-valid left in it writes the row without an agentId", () => {
  const fx = fixture();
  callHook(fx, { agent_id: "--ABC--" });
  const [row, ...rest] = rows(fx.repo, fx.runsDir);
  assert.equal(rest.length, 0);
  assert.equal(row.kind, "agent-depth");
  assert.ok(!("agentId" in row));
});

test("importing the hook exposes depthOf without reading stdin or exiting the importer", () => {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e",
    `const m = await import(${JSON.stringify(HOOK)}); console.log(typeof m.depthOf, m.depthOf(m.DEPTH_BREACH + 1));`],
  { input: "", encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "function breach");
});

test("a stopped dispatch's record is marked ended with whether its owed output exists", () => {
  const fx = fixture({ stage: "execution" });
  writeInto(fx.repo, ".devcycle/dispatch/5-implementer-0-0.json", JSON.stringify({ startedAt: "2026-10-07T07:18:00Z", sessionId: SESSION, holds: 3 }) + "\n");
  writeFileSync(fx.transcript, [
    { type: "user", timestamp: "2026-10-07T07:18:05.680Z", message: { content: "Your brief is at .devcycle/briefs/5-implementer.md" } },
    { type: "assistant", timestamp: "2026-10-07T07:18:12.261Z", message: { model: "claude-haiku-4-5-20251001", usage: usage(100, 0, 0, 5), content: [{ type: "text", text: "done" }], stop_reason: "end_turn" } },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  assert.equal(callHook(fx).status, 0);
  const record = JSON.parse(readFileSync(join(fx.repo, ".devcycle/dispatch/5-implementer-0-0.json"), "utf8"));
  assert.equal(record.agentId, "a3382414bf84c15db");
  assert.match(record.endedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(record.outputPresent, false);
  assert.equal(rows(fx.repo, fx.runsDir).filter((r) => r.kind === "agent-depth").length, 1, "the depth row still lands");
});

function endedDispatch(fx) {
  writeInto(fx.repo, ".devcycle/dispatch/5-implementer-0-0.json", JSON.stringify({ startedAt: "2026-10-07T07:18:00Z", sessionId: SESSION }) + "\n");
  writeFileSync(fx.transcript, [
    { type: "user", timestamp: "2026-10-07T07:18:05.680Z", message: { content: "Your brief is at .devcycle/briefs/5-implementer.md" } },
    { type: "assistant", timestamp: "2026-10-07T07:18:12.261Z", message: { model: "claude-haiku-4-5-20251001", usage: usage(100, 0, 0, 5), content: [{ type: "text", text: "done" }], stop_reason: "end_turn" } },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeInto(fx.repo, ".devcycle/reports/5.md", "## Task report\n");
  assert.equal(callHook(fx).status, 0);
  return JSON.parse(readFileSync(join(fx.repo, ".devcycle/dispatch/5-implementer-0-0.json"), "utf8"));
}

test("under a live stop request or a stopped row the record is stamped stopped; otherwise it is plainly ended", () => {
  const underRequest = fixture({ stage: "execution" });
  writeInto(underRequest.repo, ".devcycle/stop-request", JSON.stringify({ requestedAt: new Date().toISOString(), sessions: [] }));
  assert.match(endedDispatch(underRequest).stopped ?? "", /^\d{4}-\d{2}-\d{2}T/);
  const underRow = fixture({ stage: "execution" });
  writeInto(underRow.repo, ".devcycle/state.md", `# devcycle state\n- stage: execution\n- run: ${RUN}\n- stopped: 2026-10-07T07:19:00Z .devcycle/stop.json\n`);
  assert.match(endedDispatch(underRow).stopped ?? "", /^\d{4}-\d{2}-\d{2}T/);
  const expired = fixture({ stage: "execution" });
  writeInto(expired.repo, ".devcycle/stop-request", JSON.stringify({ requestedAt: "2026-01-01T00:00:00Z", sessions: [] }));
  const plain = endedDispatch(expired);
  assert.equal(plain.stopped, undefined);
  assert.match(plain.endedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("a broken dispatch record never stops the depth row", () => {
  const fx = fixture({ stage: "execution" });
  writeInto(fx.repo, ".devcycle/dispatch/5-implementer-0-0.json", "{not json");
  assert.equal(callHook(fx).status, 0);
  assert.equal(rows(fx.repo, fx.runsDir).filter((r) => r.kind === "agent-depth").length, 1);
});

const IMPLEMENTER_STOP = [
  { type: "user", timestamp: "2026-10-07T07:18:05.680Z", message: { content: "Your brief is at .devcycle/briefs/5-implementer.md" } },
  { type: "assistant", timestamp: "2026-10-07T07:18:12.261Z", message: { model: "claude-haiku-4-5-20251001", usage: usage(100, 0, 0, 5), content: [{ type: "text", text: "waiting for the capture" }], stop_reason: "end_turn" } },
].map((r) => JSON.stringify(r)).join("\n") + "\n";
function implementerFixture() {
  const fx = fixture({ stage: "execution" });
  writeInto(fx.repo, ".devcycle/dispatch/5-implementer-0-0.json", JSON.stringify({ startedAt: "2026-10-07T07:18:00Z", sessionId: SESSION }) + "\n");
  writeFileSync(fx.transcript, IMPLEMENTER_STOP);
  return fx;
}
const recordOf = (fx) => JSON.parse(readFileSync(join(fx.repo, ".devcycle/dispatch/5-implementer-0-0.json"), "utf8"));

test("an implementer that stops before its report is held three times, then released and recorded", () => {
  const fx = implementerFixture();
  for (let n = 1; n <= 3; n += 1) {
    const r = callHook(fx);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, "block");
    assert.match(out.reason, new RegExp(`hold ${n} of 3`));
    assert.equal(recordOf(fx).endedAt, undefined, `hold ${n} marks nothing ended`);
    assert.deepEqual(rows(fx.repo, fx.runsDir), [], `hold ${n} writes no run-record row`);
  }
  const released = callHook(fx);
  assert.equal(released.stdout, "");
  assert.match(recordOf(fx).endedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(rows(fx.repo, fx.runsDir).filter((o) => o.kind === "agent-depth").length, 1);
});

test("a running background capture in the stop's input puts its await command in the hold reason", () => {
  const fx = implementerFixture();
  const r = callHook(fx, { background_tasks: [{ id: "b1", type: "shell", status: "running", description: "capture", command: 'node "/p/scripts/capture-evidence.mjs" --task 5 --phase before' }] });
  assert.match(JSON.parse(r.stdout).reason, /--await --task 5 --phase before/);
});

test("inside a stop window nothing is held: the stop is stamped stopped", () => {
  const fx = implementerFixture();
  writeInto(fx.repo, ".devcycle/stop-request", JSON.stringify({ requestedAt: new Date().toISOString(), sessions: [] }));
  const r = callHook(fx);
  assert.equal(r.stdout, "");
  assert.match(recordOf(fx).stopped ?? "", /^\d{4}-\d{2}-\d{2}T/);
});

test("a held subagent stays open in the process registry; the stop that releases it retires it", () => {
  const fx = implementerFixture();
  const dir = join(fx.repo, ".devcycle");
  recordProcess(dir, { id: "a3382414bf84c15db", kind: "subagent", session: hashSession(SESSION), run: RUN, stage: "execution", startedAt: "2026-10-07T07:18:00Z" });
  const entry = () => readProcesses(dir).find((e) => e.id === "a3382414bf84c15db");
  callHook(fx);
  assert.equal(entry().endedAt, undefined, "/devcycle:stop must still list a held implementer");
  writeInto(fx.repo, ".devcycle/reports/5.md", "## Task report\n");
  assert.equal(callHook(fx).stdout, "");
  assert.equal(entry().endedBy, "finished");
});

test("a stop with a fresh report is released and the dispatch is marked ended", () => {
  const fx = implementerFixture();
  writeInto(fx.repo, ".devcycle/reports/5.md", "## Task report\n");
  const r = callHook(fx);
  assert.equal(r.stdout, "");
  assert.equal(recordOf(fx).holds, undefined);
  assert.match(recordOf(fx).endedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(recordOf(fx).outputPresent, true);
});

test("a reviewer stopping without its findings file is never held", () => {
  const fx = fixture({ stage: "execution" });
  writeInto(fx.repo, ".devcycle/dispatch/5-reviewer-1-0.json", JSON.stringify({ startedAt: "2026-10-07T07:18:00Z", sessionId: SESSION }) + "\n");
  writeFileSync(fx.transcript, IMPLEMENTER_STOP.replace("5-implementer.md", "5-reviewer-round-1.md"));
  const r = callHook(fx);
  assert.equal(r.stdout, "");
  const record = JSON.parse(readFileSync(join(fx.repo, ".devcycle/dispatch/5-reviewer-1-0.json"), "utf8"));
  assert.equal(record.holds, undefined);
  assert.match(record.endedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("a report older than the dispatch does not release the stop: it is still held", () => {
  const fx = implementerFixture();
  writeInto(fx.repo, ".devcycle/reports/5.md", "## Task report\n");
  const before = new Date(Date.parse("2026-10-07T07:18:00Z") - 60_000);
  utimesSync(join(fx.repo, ".devcycle/reports/5.md"), before, before);
  const r = callHook(fx);
  assert.equal(JSON.parse(r.stdout).decision, "block");
  assert.equal(recordOf(fx).endedAt, undefined);
});

test("a stop input with no transcript path still retires the subagent from the process registry", () => {
  const fx = implementerFixture();
  const dir = join(fx.repo, ".devcycle");
  recordProcess(dir, { id: "a3382414bf84c15db", kind: "subagent", session: hashSession(SESSION), run: RUN, stage: "execution", startedAt: "2026-10-07T07:18:00Z" });
  const r = callHook(fx, { agent_transcript_path: undefined });
  assert.equal(r.stdout, "");
  assert.equal(readProcesses(dir).find((e) => e.id === "a3382414bf84c15db").endedBy, "finished");
});

// #404: the live driver's own session may not end its turn while a dispatch it started is still
// working; a headless session that does exits ~600 s later and interrupts it (docs/platform-notes.md § (p)).
const DRIVE_TOKEN = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
function drivenFixture() {
  const fx = fixture({ stage: "execution" });
  writeInto(fx.repo, ".devcycle/ledger.md", "Plan: `docs/plan.md`\n\n- [2026-10-28T08:00:00Z] task=5 event=dispatched outcome=model x ref=.devcycle/briefs/5-implementer.md key=5/dispatched/0/0\n");
  writeInto(fx.repo, ".devcycle/dispatch/5-implementer-0-0.json", JSON.stringify({ startedAt: "2026-10-28T08:00:00Z", sessionId: SESSION }) + "\n");
  const config = makeTempDir("dispatch-sensor-config");
  const subagents = join(config, "projects", "-repo", SESSION, "subagents");
  mkdirSync(subagents, { recursive: true });
  writeFileSync(join(config, "projects", "-repo", `${SESSION}.jsonl`), "");
  writeFileSync(join(subagents, "agent-a1.jsonl"), readFileSync(new URL("../fixtures/dispatch-health/pending-tool.jsonl", import.meta.url), "utf8"));
  return { ...fx, config };
}
function callStop(fx, env = {}) {
  return spawnSync("node", [HOOK], {
    input: JSON.stringify({ hook_event_name: "Stop", cwd: fx.repo, session_id: SESSION, stop_hook_active: false, background_tasks: [] }),
    encoding: "utf8", env: { ...process.env, DEVCYCLE_RUNS_DIR: fx.runsDir, CLAUDE_CONFIG_DIR: fx.config, ...env } });
}
function withDriveLock(fx, fn) {
  const statePath = join(fx.repo, ".devcycle/state.md");
  const { lock } = acquireDriveLock(fx.repo, { statePath, logPath: join(fx.repo, ".devcycle/drive.log"), tokenHash: driveTokenHash(DRIVE_TOKEN) });
  try {
    return fn();
  } finally {
    releaseDriveLock(fx.repo, lock);
  }
}

test("Stop: the driver's own session is held while a dispatch works, with the foreground wait in the reason", () => {
  const fx = drivenFixture();
  const r = withDriveLock(fx, () => callStop(fx, { DEVCYCLE_DRIVE_TOKEN: DRIVE_TOKEN }));
  assert.equal(r.status, 0, r.stderr);
  assert.notEqual(r.stdout, "", "the driven turn was not held");
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /task 5 implementer in flight.*dispatch-health\.mjs" --record --wait 590000.*Bash tool's `timeout: 600000`/);
});

test("Stop: a walked session, a wrong token or no lock is never held", () => {
  const fx = drivenFixture();
  assert.equal(callStop(fx, { DEVCYCLE_DRIVE_TOKEN: DRIVE_TOKEN }).stdout, "", "no lock");
  assert.equal(withDriveLock(fx, () => callStop(fx, { DEVCYCLE_DRIVE_TOKEN: "" })).stdout, "", "a walked session");
  assert.equal(withDriveLock(fx, () => callStop(fx, { DEVCYCLE_DRIVE_TOKEN: "not-the-token" })).stdout, "", "a wrong token");
});

test("Stop: a dispatch with its report, or a stop window, releases the driven turn", () => {
  const reported = drivenFixture();
  writeInto(reported.repo, ".devcycle/reports/5.md", "## Task report\n");
  writeFileSync(join(reported.config, "projects", "-repo", SESSION, "subagents", "agent-a1.meta.json"), JSON.stringify({ finished: true }));
  assert.equal(withDriveLock(reported, () => callStop(reported, { DEVCYCLE_DRIVE_TOKEN: DRIVE_TOKEN })).stdout, "");
  const stopping = drivenFixture();
  writeInto(stopping.repo, ".devcycle/stop-request", JSON.stringify({ requestedAt: new Date().toISOString(), sessions: [] }));
  assert.equal(withDriveLock(stopping, () => callStop(stopping, { DEVCYCLE_DRIVE_TOKEN: DRIVE_TOKEN })).stdout, "");
});
