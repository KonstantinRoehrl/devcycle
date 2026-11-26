// scripts/drive-watcher.mjs: which session watches an unattended run, and that session's last usage record.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { processStartTime } from "../../scripts/file-lock.mjs";
import { WATCHER_FILE, driverTier, liveWatcher, registerWatcher, unregisterWatcher, watcherPath } from "../../scripts/drive-watcher.mjs";

const deadPid = () => Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
function cycle() {
  const root = makeTempDir("drive-watcher-");
  mkdirSync(join(root, ".devcycle"));
  const statePath = join(root, ".devcycle", "state.md");
  writeFileSync(statePath, "# devcycle state\n");
  return statePath;
}
const read = (statePath) => JSON.parse(readFileSync(watcherPath(statePath), "utf8"));
// Entries as written, minus the start time, which a fake pid may or may not have on this machine.
const entries = (statePath) => read(statePath).watchers.map(({ startTime, ...w }) => w);
const alive = (pids) => ({ pid }) => pids.includes(pid);
const at = (iso) => Date.parse(iso);
const usage = (model, effort, tokens) => JSON.stringify({ type: "assistant", timestamp: "2026-11-25T10:00:00.000Z", ...(effort ? { effort } : {}),
  message: { role: "assistant", model, content: [], usage: { input_tokens: tokens } } });
// A Claude config dir whose one project holds this session's main transcript, the lines joined with no trailing newline.
function transcript(sessionId, lines) {
  const config = makeTempDir("drive-watcher-config-");
  mkdirSync(join(config, "projects", "-w"), { recursive: true });
  writeFileSync(join(config, "projects", "-w", `${sessionId}.jsonl`), lines.join("\n"));
  return { ...process.env, CLAUDE_CONFIG_DIR: config };
}

test("the watcher file sits beside the state file", () => {
  const statePath = cycle();
  assert.equal(watcherPath(statePath), join(statePath, "..", WATCHER_FILE));
});

test("a registration replaces the same session's and prunes dead pids; the latest live one is the watcher", () => {
  const statePath = cycle();
  registerWatcher({ statePath, sessionId: "s-1", pid: 101, now: at("2026-11-25T10:00:00Z"), isAlive: alive([101, 102]) });
  registerWatcher({ statePath, sessionId: "s-2", pid: 102, now: at("2026-11-25T10:01:00Z"), isAlive: alive([101, 102]) });
  assert.deepEqual(entries(statePath), [
    { sessionId: "s-1", pid: 101, startedAt: "2026-11-25T10:00:00.000Z" },
    { sessionId: "s-2", pid: 102, startedAt: "2026-11-25T10:01:00.000Z" },
  ]);
  assert.deepEqual(liveWatcher({ statePath, isAlive: alive([101, 102]) }).sessionId, "s-2");
  registerWatcher({ statePath, sessionId: "s-1", pid: 103, now: at("2026-11-25T10:02:00Z"), isAlive: alive([103]) });
  assert.deepEqual(entries(statePath), [{ sessionId: "s-1", pid: 103, startedAt: "2026-11-25T10:02:00.000Z" }], "s-1 replaced, s-2's dead pid pruned");
  assert.equal(liveWatcher({ statePath, isAlive: alive([103]) }).pid, 103);
  assert.equal(liveWatcher({ statePath, isAlive: alive([]) }), null);
});

test("unregistering removes only this pid's entry, and the file once it is empty", () => {
  const statePath = cycle();
  const isAlive = alive([201, 202]);
  registerWatcher({ statePath, sessionId: "s-1", pid: 201, isAlive });
  registerWatcher({ statePath, sessionId: "s-2", pid: 202, isAlive });
  unregisterWatcher({ statePath, pid: 202 });
  assert.deepEqual(read(statePath).watchers.map((w) => w.sessionId), ["s-1"]);
  unregisterWatcher({ statePath, pid: 201 });
  assert.equal(existsSync(watcherPath(statePath)), false);
  unregisterWatcher({ statePath, pid: 201 });
  assert.equal(liveWatcher({ statePath }), null, "no file is no watcher");
});

test("a registration records the process's start time, and is live while that process runs", () => {
  const statePath = cycle();
  registerWatcher({ statePath, sessionId: "s-1" });
  const [entry] = read(statePath).watchers;
  assert.equal(entry.pid, process.pid);
  assert.equal(entry.startTime, processStartTime(process.pid));
  assert.equal(liveWatcher({ statePath })?.sessionId, "s-1");
});

test("an entry whose pid now belongs to a different process is not live", () => {
  const statePath = cycle();
  writeFileSync(watcherPath(statePath), JSON.stringify({ v: 1, watchers: [
    { sessionId: "s-1", pid: process.pid, startTime: "Mon Jan  1 00:00:00 2001", startedAt: "2001-01-01T00:00:00.000Z" },
  ] }));
  assert.equal(liveWatcher({ statePath }), null, "the pid is live but started long after the entry was written");
});

test("an entry written without a start time is live while its pid exists, and gone once it exits", () => {
  const statePath = cycle();
  writeFileSync(watcherPath(statePath), JSON.stringify({ v: 1, watchers: [{ sessionId: "s-1", pid: process.pid, startedAt: "2026-11-25T10:00:00.000Z" }] }));
  assert.equal(liveWatcher({ statePath })?.sessionId, "s-1");
  writeFileSync(watcherPath(statePath), JSON.stringify({ v: 1, watchers: [{ sessionId: "s-2", pid: deadPid(), startedAt: "2026-11-25T10:00:00.000Z" }] }));
  assert.equal(liveWatcher({ statePath }), null, "an exited child is not live");
});

test("driverTier reads the live watcher's last usage record, past a synthetic record and a torn tail", () => {
  const statePath = cycle();
  const env = transcript("watch-1", [usage("claude-opus-5-5", "high", 100), usage("claude-opus-5-5", "xhigh", 230_100), usage("<synthetic>", null, 0), '{"type":"assist']);
  registerWatcher({ statePath, sessionId: "watch-1" });
  assert.deepEqual(driverTier({ statePath, env }), { watcher: true, model: "claude-opus-5-5", effort: "xhigh", tokens: 230_100 });
  const bare = cycle();
  registerWatcher({ statePath: bare, sessionId: "watch-2" });
  assert.deepEqual(driverTier({ statePath: bare, env: transcript("watch-2", [usage("claude-opus-5-5", null, 7)]) }),
    { watcher: true, model: "claude-opus-5-5", effort: null, tokens: 7 }, "a record with no effort field");
});

test("driverTier is null with no live watcher, no transcript for it, or no usage record in it", () => {
  const statePath = cycle();
  const env = transcript("watch-1", [usage("claude-opus-5-5", "high", 100)]);
  assert.equal(driverTier({ statePath, env }), null, "nobody registered");
  registerWatcher({ statePath, sessionId: "watch-1", pid: deadPid() });
  assert.equal(driverTier({ statePath, env }), null, "its pid is dead");
  registerWatcher({ statePath, sessionId: "watch-9" });
  assert.equal(driverTier({ statePath, env }), null, "no transcript for the live watcher");
  const noUsage = cycle();
  registerWatcher({ statePath: noUsage, sessionId: "watch-3" });
  assert.equal(driverTier({ statePath: noUsage, env: transcript("watch-3", [JSON.stringify({ type: "user", message: { content: "hi" } })]) }), null);
});
