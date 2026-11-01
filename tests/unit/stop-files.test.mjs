import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { STOP_TTL_MS, isLiveRequest, isStopCycleCommand, readStopRecord, readStopRequest, stopPaths, stopWindowOpen } from "../../scripts/stop-files.mjs";

const T0 = Date.parse("2026-10-30T10:00:00Z");
const REQUEST = { requestedAt: "2026-10-30T10:00:00Z", requestedBy: "h", run: "00000000000000a1", sessions: ["h"] };
function devcycle(files = {}) {
  const dir = join(makeTempDir("stop-files-"), ".devcycle");
  mkdirSync(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

test("every stop file sits in the directory it is given", () => {
  assert.deepEqual(stopPaths("/x/.devcycle"), {
    request: "/x/.devcycle/stop-request", ack: "/x/.devcycle/stop-ack", record: "/x/.devcycle/stop.json",
    processes: "/x/.devcycle/processes.jsonl", history: "/x/.devcycle/stop-history",
  });
});

test("reading a request or record never throws: absent, torn or non-object files read as null", () => {
  assert.equal(readStopRequest(devcycle()), null);
  assert.equal(readStopRecord(devcycle()), null);
  for (const text of ["{not json", "[1]", "null", "3"]) {
    const dir = devcycle({ "stop-request": text, "stop.json": text });
    assert.equal(readStopRequest(dir), null, text);
    assert.equal(readStopRecord(dir), null, text);
  }
  const dir = devcycle({ "stop-request": JSON.stringify(REQUEST), "stop.json": JSON.stringify({ stage: "planning" }) });
  assert.deepEqual(readStopRequest(dir), REQUEST);
  assert.deepEqual(readStopRecord(dir), { stage: "planning" });
});

test("a request is live until its time limit, and null or unstamped is never live", () => {
  assert.equal(STOP_TTL_MS, 600_000);
  assert.equal(isLiveRequest(REQUEST, T0 + STOP_TTL_MS - 1), true);
  assert.equal(isLiveRequest(REQUEST, T0 + STOP_TTL_MS), false);
  assert.equal(isLiveRequest(null, T0), false);
  assert.equal(isLiveRequest({ requestedAt: "garbage" }, T0), false);
  assert.equal(isLiveRequest({}, T0), false);
});

test("the stop window holds on a live request or a stopped row, and on neither it is shut", () => {
  const withRequest = devcycle({ "stop-request": JSON.stringify(REQUEST) });
  assert.equal(stopWindowOpen(withRequest, "- stage: planning\n", T0), true);
  assert.equal(stopWindowOpen(withRequest, "- stage: planning\n", T0 + STOP_TTL_MS), false);
  assert.equal(stopWindowOpen(devcycle(), "- stopped: 2026-10-30T10:00:00Z .devcycle/stop.json\n", T0), true);
  assert.equal(stopWindowOpen(devcycle(), "- stage: planning\n", T0), false);
});

test("only one plain stop-cycle invocation passes as the guard's Bash exemption", () => {
  for (const command of [
    "node scripts/stop-cycle.mjs",
    "node scripts/stop-cycle.mjs list",
    "rtk node scripts/stop-cycle.mjs list",
    "node /plugins/devcycle/0.29.0/scripts/stop-cycle.mjs request --state .devcycle/state.md",
    'node "/a dir/scripts/stop-cycle.mjs" finalize --state "/a dir/.devcycle/state.md"',
    "node '/a dir/scripts/stop-cycle.mjs' list",
  ]) assert.equal(isStopCycleCommand(command), true, command);
  for (const command of [
    "node scripts/stop-cycle.mjs list; rm -rf x",
    "node scripts/stop-cycle.mjs list && rm -rf x",
    "node scripts/stop-cycle.mjs list | sh",
    "node scripts/stop-cycle.mjs list & rm x",
    "node scripts/stop-cycle.mjs $(rm x)",
    "node scripts/stop-cycle.mjs `rm x`",
    "node scripts/stop-cycle.mjs list > x",
    "node scripts/stop-cycle.mjs list < x",
    "node scripts/stop-cycle.mjs list\nrm x",
    "node -e 'x' scripts/stop-cycle.mjs",
    "node scripts/stop-cycle.mjs.bak list",
    "node scripts/not-stop-cycle.mjs list",
    "node xscripts/stop-cycle.mjs list",
    "bash scripts/stop-cycle.mjs list",
    "rtk rm node scripts/stop-cycle.mjs",
    "rm -rf x", "", undefined, 7,
  ]) assert.equal(isStopCycleCommand(command), false, String(command));
});
