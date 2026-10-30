import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile, spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { processFingerprint, readRecord, startProcess, stopAll, waitReady } from "../../scripts/on-device-launch.mjs";

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
    assert.equal(entry.fingerprint, processFingerprint(pid), "the record carries the process's start-time fingerprint");
    assert.ok(entry.fingerprint, "the fingerprint is not empty");
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

const writeRecord = (dir, processes) => {
  mkdirSync(join(dir, ".devcycle"), { recursive: true });
  writeFileSync(join(dir, RECORD), JSON.stringify({ processes }));
};
const errno = (code) => Object.assign(new Error(code), { code });
const FINGERPRINT = "Sat Oct 24 10:00:00 2026";

test("stopAll reads EPERM while a group is dying as still exiting, not as a failure", async () => {
  const dir = makeTempDir("on-device-launch-");
  writeRecord(dir, [{ pid: 424242, cmd: "x", log: ".devcycle/on-device-launch-1.log", startedAt: "2026-10-24T00:00:00Z", fingerprint: FINGERPRINT }]);
  const sent = [];
  let probes = 0;
  const kill = (target, signal) => {
    sent.push(signal);
    if (signal !== 0) return;
    if (++probes === 1) throw errno("EPERM");
    throw errno("ESRCH");
  };
  assert.deepEqual(await stopAll(dir, { kill, fingerprint: () => FINGERPRINT, leaderAlive: () => true }), { stopped: 1, alreadyGone: 0 });
  assert.equal(sent[0], "SIGTERM");
  assert.ok(probes >= 2, "the EPERM probe was followed by another one");
  assert.ok(!sent.includes("SIGKILL"), "the group left on its own, so nothing was force-killed");
  assert.equal(existsSync(join(dir, RECORD)), false);
});

test("stopAll still refuses a group it cannot signal at SIGTERM (EPERM: someone else's group)", async () => {
  const dir = makeTempDir("on-device-launch-");
  writeRecord(dir, [{ pid: 424242, cmd: "x", log: ".devcycle/on-device-launch-1.log", startedAt: "2026-10-24T00:00:00Z", fingerprint: FINGERPRINT }]);
  const kill = (target, signal) => { if (signal === "SIGTERM") throw errno("EPERM"); };
  await assert.rejects(stopAll(dir, { kill, fingerprint: () => FINGERPRINT, leaderAlive: () => true }), /cannot signal process group 424242 \(EPERM\)/);
  assert.ok(existsSync(join(dir, RECORD)), "the record stays so the user can see what was left");
});

test("stopAll leaves alone a live process whose start time is not the recorded one, and says it is a mismatch", async () => {
  const dir = makeTempDir("on-device-launch-");
  const stranger = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  try {
    writeRecord(dir, [{ pid: stranger.pid, cmd: "x", log: ".devcycle/on-device-launch-1.log", startedAt: "2026-10-24T00:00:00Z", fingerprint: "Thu Jan  1 00:00:00 1970" }]);
    const skipped = [];
    assert.deepEqual(await stopAll(dir, { onSkipped: (pid, reason) => skipped.push([pid, reason]) }), { stopped: 0, alreadyGone: 1 });
    assert.deepEqual(skipped, [[stranger.pid, "mismatch"]]);
    assert.ok(alive(stranger.pid), "a process that is not the recorded one must not be signalled");
    assert.equal(existsSync(join(dir, RECORD)), false);
  } finally {
    process.kill(-stranger.pid, "SIGKILL");
  }
});

test("stopAll never signals blind: a live leader whose start time cannot be read is left alone as unconfirmed", async () => {
  const dir = makeTempDir("on-device-launch-");
  writeRecord(dir, [{ pid: 424242, cmd: "x", log: ".devcycle/on-device-launch-1.log", startedAt: "2026-10-24T00:00:00Z", fingerprint: FINGERPRINT }]);
  const sent = [];
  const skipped = [];
  const kill = (target, signal) => { sent.push(signal); };
  assert.deepEqual(
    await stopAll(dir, { kill, fingerprint: () => null, leaderAlive: () => true, onSkipped: (pid, reason) => skipped.push([pid, reason]) }),
    { stopped: 0, alreadyGone: 1 });
  assert.deepEqual(skipped, [[424242, "unconfirmed"]]);
  assert.deepEqual(sent, [], "nothing was signalled");
});

test("stopAll leaves alone a live leader whose record has no fingerprint (an older record), as unconfirmed", async () => {
  const dir = makeTempDir("on-device-launch-");
  writeRecord(dir, [{ pid: 424242, cmd: "x", log: ".devcycle/on-device-launch-1.log", startedAt: "2026-10-24T00:00:00Z" }]);
  const sent = [];
  const skipped = [];
  const kill = (target, signal) => { sent.push(signal); };
  assert.deepEqual(
    await stopAll(dir, { kill, fingerprint: () => FINGERPRINT, leaderAlive: () => true, onSkipped: (pid, reason) => skipped.push([pid, reason]) }),
    { stopped: 0, alreadyGone: 1 });
  assert.deepEqual(skipped, [[424242, "unconfirmed"]]);
  assert.deepEqual(sent, [], "nothing was signalled");
});

test("stopAll signals the group of a recorded leader that is gone but whose group still runs, and says nothing about a reused pid", async () => {
  const dir = makeTempDir("on-device-launch-");
  writeRecord(dir, [{ pid: 424242, cmd: "x", log: ".devcycle/on-device-launch-1.log", startedAt: "2026-10-24T00:00:00Z" }]);
  const sent = [];
  let groupUp = true;
  const kill = (target, signal) => {
    sent.push([target, signal]);
    if (!groupUp) throw errno("ESRCH");
    if (signal === "SIGTERM") groupUp = false;
  };
  const skipped = [];
  assert.deepEqual(
    await stopAll(dir, { kill, fingerprint: () => null, leaderAlive: () => false, onSkipped: (pid) => skipped.push(pid) }),
    { stopped: 1, alreadyGone: 0 });
  assert.deepEqual(sent.find(([, signal]) => signal === "SIGTERM"), [-424242, "SIGTERM"]);
  assert.deepEqual(skipped, []);
});

test("stopAll stops what a launch left running after its shell leader exited (a backgrounded server)", async () => {
  const dir = makeTempDir("on-device-launch-");
  let sleeper;
  try {
    const { pid } = startProcess({ cmd: "sleep 300 & echo $! > child.pid", dir });
    sleeper = await readPidFile(join(dir, "child.pid"));
    assert.ok(await gone(pid), "the launch leader should have exited");
    assert.ok(alive(sleeper), "the backgrounded process is still running");
    const skipped = [];
    assert.deepEqual(await stopAll(dir, { onSkipped: (p) => skipped.push(p) }), { stopped: 1, alreadyGone: 0 });
    assert.deepEqual(skipped, []);
    assert.ok(await gone(sleeper), "stop abandoned a process the launch left running");
  } finally {
    if (sleeper) try { process.kill(sleeper, "SIGKILL"); } catch { /* already gone */ }
  }
});

test("stopAll does not mention a recorded pid that is simply gone", async () => {
  const dir = makeTempDir("on-device-launch-");
  writeRecord(dir, [{ pid: 424242, cmd: "x", log: ".devcycle/on-device-launch-1.log", startedAt: "2026-10-24T00:00:00Z", fingerprint: FINGERPRINT }]);
  const skipped = [];
  const kill = () => { throw errno("ESRCH"); };
  assert.deepEqual(await stopAll(dir, { kill, fingerprint: () => null, onSkipped: (pid) => skipped.push(pid) }), { stopped: 0, alreadyGone: 1 });
  assert.deepEqual(skipped, []);
});

test("waitReady fails at once when the launched process exited, even if another server answers the url", async () => {
  const dir = makeTempDir("on-device-launch-");
  const server = await listen((req, res) => res.end("the older server"));
  try {
    const { pid } = startProcess({ cmd: "echo 'Error: listen EADDRINUSE :::5173'; exit 1", dir });
    assert.ok(await gone(pid));
    const r = await waitReady({ dir, url: `http://127.0.0.1:${server.address().port}/`, timeoutMs: 10000, intervalMs: 50 });
    assert.equal(r.ready, false);
    assert.ok(r.waitedMs < 2000, `took ${r.waitedMs} ms`);
    assert.match(r.detail, /launched process exited/);
    assert.match(r.detail, /EADDRINUSE/);
  } finally {
    shut(server);
  }
});

test("waitReady fails fast with the log tail when the launched process crashes before it is ready", async () => {
  const dir = makeTempDir("on-device-launch-");
  startProcess({ cmd: "echo 'TypeError: cannot read config'; exit 3", dir });
  const r = await waitReady({ dir, url: `http://127.0.0.1:${await closedPort()}/`, timeoutMs: 10000, intervalMs: 50 });
  assert.equal(r.ready, false);
  assert.ok(r.waitedMs < 2000, `took ${r.waitedMs} ms of a 10000 ms timeout`);
  assert.match(r.detail, /launched process exited — TypeError: cannot read config/);
});

test("processFingerprint reads the same start time whatever TZ the session runs in", () => {
  const savedTz = process.env.TZ;
  try {
    process.env.TZ = "Pacific/Auckland";
    const auckland = processFingerprint(process.pid);
    process.env.TZ = "America/Los_Angeles";
    assert.ok(auckland);
    assert.equal(processFingerprint(process.pid), auckland);
  } finally {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  }
});

test("stopAll matches a start time to the second, tolerates a 1s drift and rejects an hour's difference", async () => {
  for (const [current, ours] of [
    ["Sat Oct 24 10:00:01 2026", true],
    ["Sat Oct 24 09:59:59 2026", true],
    ["Sat Oct 24 11:00:00 2026", false],
  ]) {
    const dir = makeTempDir("on-device-launch-");
    writeRecord(dir, [{ pid: 424242, cmd: "x", log: ".devcycle/on-device-launch-1.log", startedAt: "2026-10-24T00:00:00Z", fingerprint: FINGERPRINT }]);
    let termSent = false;
    const kill = (target, signal) => {
      if (termSent) throw errno("ESRCH");
      if (signal === "SIGTERM") termSent = true;
    };
    const skipped = [];
    const result = await stopAll(dir, { kill, fingerprint: () => current, leaderAlive: () => true, onSkipped: (pid, reason) => skipped.push(reason) });
    assert.deepEqual(result, ours ? { stopped: 1, alreadyGone: 0 } : { stopped: 0, alreadyGone: 1 }, current);
    assert.deepEqual(skipped, ours ? [] : ["mismatch"], current);
  }
});

test("waitReady keeps polling after a launcher that exited 0 handed off, and is ready once the url answers", async () => {
  const dir = makeTempDir("on-device-launch-");
  const port = await closedPort();
  let server;
  const later = setTimeout(async () => {
    server = createServer((req, res) => res.end("up"));
    server.listen(port, "127.0.0.1");
  }, 600);
  try {
    const { pid } = startProcess({ cmd: "exit 0", dir });
    assert.ok(await gone(pid));
    const r = await waitReady({ dir, url: `http://127.0.0.1:${port}/`, timeoutMs: 10000, intervalMs: 50 });
    assert.equal(r.ready, true, r.detail);
    assert.ok(server, `reported ready after ${r.waitedMs} ms, before the app was up`);
  } finally {
    clearTimeout(later);
    if (server) shut(server);
    await stopAll(dir);
  }
});

test("waitReady keeps polling after a hand-off until its timeout when nothing ever answers", async () => {
  const dir = makeTempDir("on-device-launch-");
  try {
    const { pid } = startProcess({ cmd: "echo handed off; exit 0", dir });
    assert.ok(await gone(pid));
    const r = await waitReady({ dir, url: `http://127.0.0.1:${await closedPort()}/`, timeoutMs: 400, intervalMs: 50 });
    assert.equal(r.ready, false);
    assert.ok(r.waitedMs >= 400, `gave up after ${r.waitedMs} ms of a 400 ms timeout`);
    assert.equal(r.detail, "handed off");
  } finally {
    await stopAll(dir);
  }
});

test("waitReady fails at once, with the log tail, when the launcher exited non-zero", async () => {
  const dir = makeTempDir("on-device-launch-");
  try {
    const { pid } = startProcess({ cmd: "echo 'Error: missing env'; exit 3", dir });
    assert.ok(await gone(pid));
    const r = await waitReady({ dir, url: `http://127.0.0.1:${await closedPort()}/`, timeoutMs: 10000, intervalMs: 50 });
    assert.equal(r.ready, false);
    assert.ok(r.waitedMs < 2000, `took ${r.waitedMs} ms of a 10000 ms timeout`);
    assert.match(r.detail, /launched process exited — Error: missing env/);
  } finally {
    await stopAll(dir);
  }
});

test("waitReady fails at once when the launch leader is gone and left no exit status (killed by a signal)", async () => {
  const dir = makeTempDir("on-device-launch-");
  const { pid } = spawnSync("true");
  writeRecord(dir, [{ pid, cmd: "x", log: ".devcycle/on-device-launch-1.log", exit: ".devcycle/on-device-launch-1.exit", startedAt: "2026-10-24T00:00:00Z" }]);
  const r = await waitReady({ dir, url: `http://127.0.0.1:${await closedPort()}/`, timeoutMs: 10000, intervalMs: 50 });
  assert.equal(r.ready, false);
  assert.ok(r.waitedMs < 2000, `took ${r.waitedMs} ms of a 10000 ms timeout`);
  assert.match(r.detail, /launched process exited — no log output/);
});

test("stopAll removes a launch's exit-status file with the record, and keeps the log", async () => {
  const dir = makeTempDir("on-device-launch-");
  const { pid, log } = startProcess({ cmd: "echo hi", dir });
  assert.ok(await gone(pid));
  const [{ exit }] = readRecord(dir).processes;
  assert.ok(exit, "the record names the exit-status file");
  assert.equal(readFileSync(join(dir, exit), "utf8").trim(), "0");
  await stopAll(dir);
  assert.equal(existsSync(join(dir, exit)), false);
  assert.ok(existsSync(join(dir, log)), "the log stays");
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

test("the CLI's stop names a recorded pid it left alone because it is not the process the launch started", async () => {
  const dir = makeTempDir("on-device-launch-");
  const stranger = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  try {
    writeRecord(dir, [{ pid: stranger.pid, cmd: "x", log: ".devcycle/on-device-launch-1.log", startedAt: "2026-10-24T00:00:00Z", fingerprint: "Thu Jan  1 00:00:00 1970" }]);
    const stop = await run(["stop", "--dir", dir]);
    assert.deepEqual([stop.status, stop.stdout], [0, `nothing to stop\nleft ${stranger.pid} alone: it is not the process the launch started\n`]);
    assert.ok(alive(stranger.pid));
  } finally {
    process.kill(-stranger.pid, "SIGKILL");
  }
});

test("the CLI's stop says it cannot confirm a live leader whose record has no fingerprint, and leaves it running", async () => {
  const dir = makeTempDir("on-device-launch-");
  const stranger = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  try {
    writeRecord(dir, [{ pid: stranger.pid, cmd: "x", log: ".devcycle/on-device-launch-1.log", startedAt: "2026-10-24T00:00:00Z" }]);
    const stop = await run(["stop", "--dir", dir]);
    assert.deepEqual([stop.status, stop.stdout], [0, `nothing to stop\nleft ${stranger.pid} alone: cannot confirm it is the process the launch started\n`]);
    assert.ok(alive(stranger.pid));
  } finally {
    process.kill(-stranger.pid, "SIGKILL");
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
