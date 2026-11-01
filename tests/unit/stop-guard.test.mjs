// While a stop request stands, hooks/stop-guard.mjs denies every tool a listed session calls except
// what the stop needs. deny = a permissionDecision:"deny" object on stdout; allow = empty stdout. Both
// exit 0. Fixtures sit outside the repo (the suite runs under an out-of-repo TMPDIR), or the upward
// state-file walk would find the repo's own.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { hashSession } from "../../scripts/run-record.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "stop-guard.mjs");
const SESSION = "stopped-session";
const STATE = "# devcycle state\n- stage: planning\n- run: 00000000000000a1\n";
const STOPPED_ROW = "- stopped: 2026-10-30T10:00:00Z .devcycle/stop.json\n";
const requestAt = (at, sessions = [hashSession(SESSION)]) =>
  JSON.stringify({ requestedAt: at, requestedBy: hashSession(SESSION), run: "00000000000000a1", sessions });
const liveRequest = () => requestAt(new Date().toISOString());

function cycle({ state = STATE, request = null, record = null } = {}) {
  const root = makeTempDir("stop-guard-");
  mkdirSync(join(root, ".devcycle"));
  writeFileSync(join(root, ".devcycle/state.md"), state);
  if (request) writeFileSync(join(root, ".devcycle/stop-request"), request);
  if (record) writeFileSync(join(root, ".devcycle/stop.json"), record);
  return root;
}

function callRaw(stdin) {
  const r = spawnSync("node", [HOOK], { input: stdin, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  if (r.stdout.trim() === "") return "allow";
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, "PreToolUse");
  assert.match(out.permissionDecisionReason, /\/devcycle:/);
  return out.permissionDecision;
}
const decide = (root, extra = {}) =>
  callRaw(JSON.stringify({ cwd: root, session_id: SESSION, tool_name: "Read", tool_input: { file_path: "x" }, ...extra }));
const ackLines = (root) => {
  const path = join(root, ".devcycle/stop-ack");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
};

test("with no state file or no request every call is allowed and nothing is written", () => {
  assert.equal(decide(makeTempDir("stop-guard-bare-")), "allow");
  const root = cycle();
  assert.equal(decide(root), "allow");
  assert.equal(decide(root, { agent_id: "a1" }), "allow");
  assert.deepEqual(ackLines(root), []);
});

test("a live request denies a listed session's main thread and its subagents", () => {
  const root = cycle({ request: liveRequest() });
  assert.equal(decide(root), "deny");
  assert.equal(decide(root, { agent_id: "a1", agent_type: "devcycle:implementer", tool_name: "Bash", tool_input: { command: "ls" } }), "deny");
});

test("a session the request does not list is never blocked, nor by a request past its limit", () => {
  assert.equal(decide(cycle({ request: liveRequest() }), { session_id: "joined-after-the-request" }), "allow");
  assert.equal(decide(cycle({ request: requestAt("2026-01-01T00:00:00Z") })), "allow");
});

test("what the stop itself needs passes, with no acknowledgement", () => {
  const root = cycle({ request: liveRequest() });
  assert.equal(decide(root, { tool_name: "TaskStop", tool_input: { task_id: "b1" } }), "allow");
  assert.equal(decide(root, { tool_name: "ToolSearch", tool_input: { query: "select:TaskStop" } }), "allow");
  assert.equal(decide(root, { tool_name: "Bash", tool_input: { command: "node scripts/stop-cycle.mjs list" } }), "allow");
  assert.deepEqual(ackLines(root), []);
  assert.equal(decide(root, { tool_name: "ToolSearch", tool_input: { query: "select:TaskStop,Bash" } }), "deny");
  assert.equal(decide(root, { tool_name: "Bash", tool_input: { command: "node scripts/stop-cycle.mjs list; rm x" } }), "deny");
});

test("each denial appends one line holding the session's hash, never its raw id", () => {
  const root = cycle({ request: liveRequest() });
  decide(root);
  decide(root, { agent_id: "a1", tool_name: "Bash", tool_input: { command: "ls" } });
  const lines = ackLines(root);
  assert.equal(lines.length, 2);
  assert.deepEqual([JSON.parse(lines[1]).session, JSON.parse(lines[1]).agent, JSON.parse(lines[1]).tool], [hashSession(SESSION), "a1", "Bash"]);
  assert.ok(!readFileSync(join(root, ".devcycle/stop-ack"), "utf8").includes(SESSION));
});

test("an acknowledgement that cannot be written still denies", () => {
  const root = cycle({ request: liveRequest() });
  mkdirSync(join(root, ".devcycle/stop-ack"));
  assert.equal(decide(root), "deny");
});

test("after finalize the stopped row halts the listed sessions' subagents and frees every main thread", () => {
  const record = JSON.stringify({ sessions: [hashSession(SESSION)] });
  const root = cycle({ state: STATE + STOPPED_ROW, record });
  assert.equal(decide(root, { agent_id: "a1" }), "deny");
  assert.equal(decide(root), "allow");
  assert.equal(decide(root, { agent_id: "a1", session_id: "another-session" }), "allow");
  assert.equal(decide(cycle({ state: STATE, record }), { agent_id: "a1" }), "allow", "resume dropped the row");
  assert.equal(decide(cycle({ state: STATE + STOPPED_ROW }), { agent_id: "a1" }), "allow", "no record to read");
});

test("malformed input and a torn request fail open", () => {
  assert.equal(callRaw("{not json"), "allow");
  assert.equal(callRaw("null"), "allow");
  assert.equal(callRaw(""), "allow");
  const root = cycle({ request: liveRequest() });
  assert.equal(decide(root, { session_id: undefined }), "allow");
  assert.equal(decide(root, { session_id: 42 }), "allow");
  assert.equal(decide(cycle({ request: "{torn" })), "allow");
  assert.equal(decide(cycle({ request: JSON.stringify({ requestedAt: new Date().toISOString(), sessions: "x" }) })), "allow");
});

test("the path with no request stays near-free: the hashing module is never imported eagerly", () => {
  assert.doesNotMatch(readFileSync(HOOK, "utf8"), /^import [^\n]*run-record/m);
});
