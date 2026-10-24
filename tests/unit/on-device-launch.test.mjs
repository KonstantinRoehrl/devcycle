import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { readRecord, startProcess, stopAll, waitReady } from "../../scripts/on-device-launch.mjs";

const SCRIPT = join(process.cwd(), "scripts/on-device-launch.mjs");
const RECORD = ".devcycle/on-device-launch.json";
// Async on purpose: a spawnSync would block this process's event loop, and with it the in-test
// HTTP server the CLI's ready poll is asking.
const run = (args) =>
  new Promise((resolve) =>
    execFile(process.execPath, [SCRIPT, ...args], { encoding: "utf8" }, (err, stdout, stderr) =>
      resolve({ status: err ? err.code : 0, stdout, stderr })));
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const gone = async (pid) => {
  for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
  return !alive(pid);
};
const listen = (handler) =>
  new Promise((resolve) => { const s = createServer(handler); s.listen(0, "127.0.0.1", () => resolve(s)); });
const shut = (server) => { server.closeAllConnections(); server.close(); };
const closedPort = async () => {
  const s = await listen(() => {});
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
};
const readPidFile = async (path) => {
  for (let i = 0; i < 50 && !(existsSync(path) && readFileSync(path, "utf8").trim()); i++) await sleep(50);
  return Number(readFileSync(path, "utf8"));
};

test("readRecord reads an absent record as no processes", () => {
  assert.deepEqual(readRecord(makeTempDir("on-device-launch-")), { processes: [] });
});

test("startProcess records a detached process group, and stopAll stops all of it and removes the record", async () => {
  const dir = makeTempDir("on-device-launch-");
  const cmd = "sleep 30 & echo $! > child.pid; wait";
  try {
    const { pid, log } = startProcess({ cmd, dir });
    assert.equal(log, ".devcycle/on-device-launch-1.log");
    assert.ok(existsSync(join(dir, log)), "the log file is created at start");
    const [entry] = readRecord(dir).processes;
    assert.deepEqual({ pid: entry.pid, cmd: entry.cmd, log: entry.log }, { pid, cmd, log });
    assert.match(entry.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const grandchild = await readPidFile(join(dir, "child.pid"));
    assert.deepEqual(await stopAll(dir), { stopped: 1, alreadyGone: 0 });
    assert.ok(await gone(pid), "the launched shell outlived stop");
    assert.ok(await gone(grandchild), "a process the launch command started outlived stop — the whole group must be signalled");
    assert.equal(existsSync(join(dir, RECORD)), false, "stop removes the record");
  } finally {
    await stopAll(dir);
  }
});

test("waitReady with logMatch is ready once any recorded log matches, and each start gets its own log", async () => {
  const dir = makeTempDir("on-device-launch-");
  try {
    startProcess({ cmd: "sleep 30", dir });
    const { log } = startProcess({ cmd: "echo 'Local: http://localhost:5173/'; sleep 30", dir });
    assert.equal(log, ".devcycle/on-device-launch-2.log");
    const r = await waitReady({ dir, logMatch: "Local:\\s+http", timeoutMs: 5000, intervalMs: 50 });
    assert.equal(r.ready, true);
    assert.match(r.detail, /on-device-launch-2\.log matched/);
    assert.deepEqual(await stopAll(dir), { stopped: 2, alreadyGone: 0 });
  } finally {
    await stopAll(dir);
  }
});

test("waitReady with url counts any HTTP response, a 500 included, as up", async () => {
  const server = await listen((req, res) => { res.statusCode = 500; res.end("boom"); });
  try {
    const url = `http://127.0.0.1:${server.address().port}/`;
    const r = await waitReady({ dir: makeTempDir("on-device-launch-"), url, timeoutMs: 5000, intervalMs: 50 });
    assert.equal(r.ready, true);
    assert.equal(r.detail, `${url} answered 500`);
  } finally {
    shut(server);
  }
});

test("waitReady gives up after its timeout and reports the last log lines", async () => {
  const dir = makeTempDir("on-device-launch-");
  try {
    startProcess({ cmd: "echo 'Error: port 5173 is already in use'; sleep 30", dir });
    const r = await waitReady({ dir, url: `http://127.0.0.1:${await closedPort()}/`, timeoutMs: 300, intervalMs: 50 });
    assert.equal(r.ready, false);
    assert.ok(r.waitedMs >= 300, `waited only ${r.waitedMs} ms`);
    assert.match(r.detail, /port 5173 is already in use/);
  } finally {
    await stopAll(dir);
  }
});

test("waitReady refuses both or neither of url and logMatch", async () => {
  const dir = makeTempDir("on-device-launch-");
  await assert.rejects(waitReady({ dir }), /exactly one of url and logMatch/);
  await assert.rejects(waitReady({ dir, url: "http://127.0.0.1:1/", logMatch: "x" }), /exactly one of url and logMatch/);
});

test("stopAll counts a recorded process that already exited as gone, and removes the record", async () => {
  const dir = makeTempDir("on-device-launch-");
  const { pid } = spawnSync("true");
  mkdirSync(join(dir, ".devcycle"));
  writeFileSync(join(dir, RECORD), JSON.stringify({
    processes: [{ pid, cmd: "true", log: ".devcycle/on-device-launch-1.log", startedAt: "2026-10-24T00:00:00Z" }],
  }));
  assert.deepEqual(await stopAll(dir), { stopped: 0, alreadyGone: 1 });
  assert.equal(existsSync(join(dir, RECORD)), false);
});

test("the CLI starts, reports readiness and stops; a second stop has nothing to stop", async () => {
  const dir = makeTempDir("on-device-launch-");
  const server = await listen((req, res) => res.end("ok"));
  try {
    const start = await run(["start", "--cmd", "sleep 30", "--dir", dir]);
    assert.equal(start.status, 0, start.stderr);
    assert.match(start.stdout, /^started \d+ \(log: \.devcycle\/on-device-launch-1\.log\)\n$/);
    const url = `http://127.0.0.1:${server.address().port}/`;
    const ready = await run(["ready", "--url", url, "--dir", dir]);
    assert.equal(ready.status, 0, ready.stderr);
    assert.match(ready.stdout, /^ready \(http:\/\/127\.0\.0\.1:\d+\/ answered 200, \d+s\)\n$/);
    const stop = await run(["stop", "--dir", dir]);
    assert.deepEqual([stop.status, stop.stdout], [0, "stopped 1 process(es)\n"]);
    const again = await run(["stop", "--dir", dir]);
    assert.deepEqual([again.status, again.stdout], [0, "nothing to stop\n"]);
  } finally {
    await stopAll(dir);
    shut(server);
  }
});

test("the CLI's ready exits 1 and says what to do when the app never comes up", async () => {
  const dir = makeTempDir("on-device-launch-");
  const r = await run(["ready", "--url", `http://127.0.0.1:${await closedPort()}/`, "--timeout", "1", "--dir", dir]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^on-device-launch: not ready after \d+s — no log output; start the app yourself or fix Launch:\n$/);
});

test("the CLI refuses an unknown subcommand, a start without --cmd, a ready without exactly one check, and an unknown flag", async () => {
  const dir = makeTempDir("on-device-launch-");
  for (const [args, message] of [
    [["launch"], /unknown subcommand "launch"/],
    [["start", "--dir", dir], /start needs --cmd/],
    [["ready", "--dir", dir], /ready needs exactly one of --url and --log-match/],
    [["stop", "--dir", dir, "--force"], /unrecognised flag --force/],
  ]) {
    const r = await run(args);
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.stderr, message);
    assert.match(r.stderr, /usage: on-device-launch\.mjs start --cmd/);
  }
});
