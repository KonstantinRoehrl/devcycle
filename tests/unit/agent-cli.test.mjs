import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, realpathSync, existsSync } from "node:fs";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import agentCli from "../../workflows/lib/agent-cli.js";
import { makeFakeBin } from "./helpers.mjs";

const { run, claudeStructured, makeLogger } = agentCli;

// A PATH with no `claude` on it anywhere. Prepending a deliberately broken fake
// does NOT work: PATH lookup skips a non-executable file and falls through to
// the developer's real CLI, which then makes a live model call.
function isolatedPath(binDirs = []) {
  return [...binDirs, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter);
}

async function withPath(value, fn) {
  const saved = process.env.PATH;
  process.env.PATH = value;
  try {
    return await fn();
  } finally {
    process.env.PATH = saved;
  }
}

// claudeStructured pins its own agent timeout — a 15-minute module constant with
// no parameter — so a test cannot pass it a short timeoutMs the way the `run`
// test below does. Shortening the clock the shared runner reads is the same
// technique from the other side, and keeps a production knob out of agent-cli.js.
// Nothing else in these tests schedules a timer while `fn` runs.
async function withShortAgentTimeout(ms, fn) {
  const saved = globalThis.setTimeout;
  globalThis.setTimeout = (cb, delay, ...rest) => saved(cb, Math.min(delay ?? 0, ms), ...rest);
  try {
    return await fn();
  } finally {
    globalThis.setTimeout = saved;
  }
}

// A fake `claude` that never answers: `body` runs first, then it sleeps far past
// any timeout under test and is SIGKILLed. It is exec'd once with a flag it exits
// on before being handed out, because the very first run of a freshly written
// executable costs 200-400ms of one-time OS work here — a cold first attempt
// would be killed before `body` could record that it ran.
async function makeStalledClaude(body = "") {
  const dir = makeFakeBin(
    "claude",
    `if (process.argv.includes("--warmup")) process.exit(0);\n${body}\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);`
  );
  await run(join(dir, "claude"), ["--warmup"]);
  return dir;
}

test("run surfaces a missing binary as spawnError instead of rejecting", async () => {
  const res = await run("devcycle-no-such-binary", []);
  assert.ok(res.spawnError, "a missing binary must land on the resolved value, not as a throw");
  assert.match(res.stderr, /ENOENT/);
  assert.equal(res.code, null);
});

test("run kills a child that outlives timeoutMs and reports timedOut", async () => {
  const bin = makeFakeBin("sleeper", `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);`);
  const res = await run(join(bin, "sleeper"), [], { timeoutMs: 100 });
  assert.equal(res.timedOut, true);
  assert.ok(!res.spawnError, "a timeout is not a spawn failure");
});

test("run() resolves overflow:true and kills a child that exceeds maxBufferBytes", async () => {
  // Child writes 5000 bytes; cap is 1000 → overflow.
  const res = await run(process.execPath, ["-e", "process.stdout.write('x'.repeat(5000))"], {
    maxBufferBytes: 1000,
  });
  assert.equal(res.overflow, true);
  assert.equal(res.timedOut, false);
  assert.ok(res.stdout.length <= 1000 + 64, "buffered output is bounded near the cap");
});

test("run() completes normally under the cap with no overflow flag", async () => {
  const res = await run(process.execPath, ["-e", "process.stdout.write('hello')"], {
    maxBufferBytes: 1000,
  });
  assert.equal(res.overflow, undefined);
  assert.equal(res.code, 0);
  assert.equal(res.stdout, "hello");
});

test("claudeStructured pins --tools with the equals form and plumbs cwd, model and permission mode", async () => {
  const argvLog = join(makeTempDir("devcycle-agent-cli-"), "argv.json");
  const bin = makeFakeBin(
    "claude",
    `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
process.stdout.write(JSON.stringify({ is_error: false, structured_output: { ok: true } }));
`
  );
  const cwd = makeTempDir("devcycle-agent-cli-cwd-");
  const res = await withPath(isolatedPath([bin]), () =>
    claudeStructured({
      prompt: "the prompt",
      tools: "Read,Edit",
      schema: { type: "object" },
      model: "some-model",
      cwd,
      permissionMode: "acceptEdits",
      attempts: 1,
      errors: { agent: "test agent", output: "test", cap: 100 },
    })
  );
  assert.deepEqual(res, { ok: true, value: { ok: true }, cost: null });

  const seen = JSON.parse(readFileSync(argvLog, "utf8"));
  assert.ok(seen.argv.includes("--tools=Read,Edit"), `--tools must be the equals form; got: ${seen.argv.join(" ")}`);
  assert.ok(!seen.argv.includes("--tools"), "the two-element form swallows the prompt and must never come back");
  assert.equal(seen.argv[seen.argv.length - 1], "the prompt", "the prompt stays the final positional");
  assert.deepEqual(seen.argv.slice(-3), ["--model", "some-model", "the prompt"]);
  assert.ok(seen.argv.includes("--permission-mode"));
  assert.ok(seen.argv.includes("acceptEdits"));
  assert.equal(realpathSync(seen.cwd), realpathSync(cwd), "the subagent runs in the cwd it was given");
});

test("claudeStructured makes exactly `attempts` calls and labels the failure with the caller's vocabulary", async () => {
  const tries = join(makeTempDir("devcycle-agent-cli-tries-"), "tries.log");
  const bin = makeFakeBin(
    "claude",
    `
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(tries)}, "x");
process.stdout.write(JSON.stringify({ is_error: true, result: "refused" }));
`
  );
  const res = await withPath(isolatedPath([bin]), () =>
    claudeStructured({
      prompt: "p",
      tools: "Read",
      schema: { type: "object" },
      attempts: 2,
      errors: { agent: "claude subagent", output: "claude", cap: 500 },
    })
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /^claude subagent error: refused/);
  assert.equal(readFileSync(tries, "utf8").length, 2, "attempts: 2 means exactly two calls, no more");
});

test("claudeStructured reports an unreachable CLI with the shared not-runnable message", async () => {
  const res = await withPath(isolatedPath([]), () =>
    claudeStructured({
      prompt: "p",
      tools: "Read",
      schema: { type: "object" },
      attempts: 1,
      errors: { agent: "editor agent", output: "editor", cap: 400 },
    })
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /^claude CLI not runnable: .*ENOENT/);
});

test("claudeStructured reports an agent that outlives its timeout in the caller's vocabulary", async () => {
  const bin = await makeStalledClaude();
  const res = await withPath(isolatedPath([bin]), () =>
    withShortAgentTimeout(50, () =>
      claudeStructured({
        prompt: "p",
        tools: "Read",
        schema: { type: "object" },
        attempts: 1,
        errors: { agent: "editor agent", output: "editor", cap: 400 },
      })
    )
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, "editor agent timed out", "the sweep surfaces this string verbatim; a generic one would hide which agent hung");
});

// 1500ms, not the 50ms above: here the number of attempts is the assertion, so
// every attempt has to survive long enough to spawn a fresh Node, run its
// shebang and append its line (~30-50ms measured). Each retry gets its own
// independent timer, so the window is per attempt, not a shared budget. The
// margin is deliberately ~30x that baseline rather than a snug one: a loaded
// runner that misses the window makes a correct retry loop fail the count. The
// cost of that headroom is ~3s of suite time, two attempts of 1500ms each.
test("claudeStructured retries a timed-out agent and reports the timeout after the last attempt", async () => {
  const tries = join(makeTempDir("devcycle-agent-cli-timeout-tries-"), "tries.log");
  const bin = await makeStalledClaude(`require("node:fs").appendFileSync(${JSON.stringify(tries)}, "x");`);
  const res = await withPath(isolatedPath([bin]), () =>
    withShortAgentTimeout(1500, () =>
      claudeStructured({
        prompt: "p",
        tools: "Read",
        schema: { type: "object" },
        attempts: 2,
        errors: { agent: "claude subagent", output: "claude", cap: 500 },
      })
    )
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, "claude subagent timed out");
  assert.equal(readFileSync(tries, "utf8").length, 2, "a timeout is retried, and only the last attempt returns the error");
});

test("claudeStructured surfaces total_cost_usd from the envelope as cost", async () => {
  const bin = makeFakeBin(
    "claude",
    `process.stdout.write(JSON.stringify({ is_error: false, structured_output: { ok: true }, total_cost_usd: 0.0123 }));`
  );
  const res = await withPath(isolatedPath([bin]), () =>
    claudeStructured({
      prompt: "p",
      tools: "Read",
      schema: { type: "object" },
      attempts: 1,
      errors: { agent: "a", output: "a", cap: 100 },
    })
  );
  assert.deepEqual(res, { ok: true, value: { ok: true }, cost: 0.0123 });
});

// Polls until `pid` is gone (ESRCH) or `ms` elapses; a SIGKILLed process can sit un-reaped for a
// few milliseconds after the kill, during which kill(pid, 0) still succeeds.
async function waitForExit(pid, ms) {
  const until = Date.now() + ms;
  for (;;) {
    try { process.kill(pid, 0); } catch (e) { if (e.code === "ESRCH") return true; throw e; }
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

// Audit 2026-09-05 H5: run() killed only the direct child and resolved on `close`, which waits for
// every holder of the stdio pipes — a grandchild that inherited them kept the promise pending past
// the timeout. The child here spawns a 4s sleeper with stdio: "inherit", prints its pid, and sleeps.
test("run kills the whole process group on timeout and settles without waiting for a grandchild holding the pipes", async () => {
  const child = `
const { spawn } = require("node:child_process");
const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 4000)"], { stdio: "inherit" });
process.stdout.write(String(g.pid) + "\\n");
setTimeout(() => {}, 4000);
`;
  const started = Date.now();
  const res = await run(process.execPath, ["-e", child], { timeoutMs: 200 });
  const elapsed = Date.now() - started;
  assert.equal(res.timedOut, true);
  assert.ok(elapsed < 200 + agentCli.DRAIN_GRACE_MS + 1000, `settled after ${elapsed}ms; the grandchild must not hold the promise`);
  const pid = Number(res.stdout.trim());
  assert.ok(Number.isInteger(pid) && pid > 0, `grandchild pid must be on stdout, got ${JSON.stringify(res.stdout)}`);
  assert.equal(await waitForExit(pid, 500), true, "the grandchild must be dead after the group kill");
});

// A child that backgrounds a process and exits — `sh -c "sleep 10 & echo $!; exit 0"`, the everyday
// shape of a verify command that starts a server — hands its inherited pipes to a grandchild that
// outlives it. This is the path H5's own symptom runs on, and the one the timeout tests never touch:
// there the group dies, so `close` fires at once and the drain window never matters.
const BACKGROUNDS_A_GRANDCHILD = "sleep 10 & echo $!; exit 0";

// Branch review round 1: settling resolved the promise but never released the child, so the
// surviving grandchild kept the PARENT's event loop alive on the still-ref'd pipe handles — the
// engine wrote its report and then hung until the grandchild died. Asserting that the promise
// settled passes against that bug; only the parent's own exit discriminates it.
test("the parent process exits promptly once run() settles, even with a grandchild still holding the pipes", async () => {
  const agentCliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "workflows", "lib", "agent-cli.js");
  const runner = `
const { run } = require(${JSON.stringify(agentCliPath)});
run("/bin/sh", ["-c", ${JSON.stringify(BACKGROUNDS_A_GRANDCHILD)}]).then((res) => {
  process.stdout.write("SETTLED " + res.stdout.trim() + "\\n");
});
`;
  const { spawn } = await import("node:child_process");
  const parent = spawn(process.execPath, ["-e", runner], { stdio: ["ignore", "pipe", "inherit"] });
  const started = Date.now();
  let out = "";
  parent.stdout.on("data", (d) => { out += d; });
  // 5s is half the grandchild's life: comfortably past node's boot plus DRAIN_GRACE_MS on a loaded
  // box, and comfortably short of the grandchild's death, which is what the buggy build waited for.
  const exited = await new Promise((resolve) => {
    const deadline = setTimeout(() => resolve(false), 5000);
    parent.once("exit", () => { clearTimeout(deadline); resolve(true); });
  });
  const elapsed = Date.now() - started;
  const grandchildPid = Number((out.match(/SETTLED (\d+)/) ?? [])[1]);
  if (!exited) parent.kill("SIGKILL");
  if (Number.isInteger(grandchildPid) && grandchildPid > 0) {
    try { process.kill(grandchildPid, "SIGKILL"); } catch { /* already gone */ }
  }
  assert.match(out, /^SETTLED \d+/, `run() must settle and report the grandchild pid; got ${JSON.stringify(out)}`);
  assert.ok(exited, `the parent was still running ${elapsed}ms after run() settled: settling must release the child instead of leaving a grandchild holding the parent's event loop open`);
});

test("run() leaves nothing alive in the child's group once it has settled, and still returns the buffered output", async () => {
  const res = await run("/bin/sh", ["-c", BACKGROUNDS_A_GRANDCHILD]);
  const pid = Number(res.stdout.trim());
  try {
    assert.equal(res.code, 0);
    assert.ok(Number.isInteger(pid) && pid > 0, `output buffered before the drain must still come back; got ${JSON.stringify(res.stdout)}`);
    assert.equal(await waitForExit(pid, 1000), true, "the grandchild must be dead once run() has settled — the call is over by contract");
  } finally {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
});

// Branch review round 2: settling group-killed unconditionally, but on the normal path the leader
// has already exited and been reaped, so `-pid` addresses a process group this run no longer owns.
// A pid the kernel has since handed to an unrelated group leader would take that SIGKILL. POSIX does
// not recycle a pid while it is still an existing group's pgid, so the case where the target may be
// a stranger is exactly the case where the group is empty and the kill buys nothing. The difference
// between "signalled a pgid we no longer own" and "signalled nothing" is invisible on the resolved
// value, so a spy on process.kill is the only faithful instrument for it.
//
// Round 4: the round-3 guard asked the kernel instead — `process.kill(-pid, 0)` before the SIGKILL.
// That question is "does SOME group have this pgid", which a stranger who became their own group
// leader on the recycled pid answers just as well, so the settle path must not address the pgid at
// all unless this run holds its own evidence the group is still non-empty.
async function recordKills(fn) {
  const saved = process.kill;
  const calls = [];
  process.kill = (pid, signal) => {
    calls.push({ pid, signal });
    return saved.call(process, pid, signal);
  };
  try {
    await fn();
  } finally {
    process.kill = saved;
  }
  return calls;
}

test("run() sends no group kill when the child exited on its own and left an empty group", async () => {
  let res;
  const calls = await recordKills(async () => {
    res = await run(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
  });
  const pid = Number(res.stdout.trim());
  assert.equal(res.code, 0);
  assert.ok(Number.isInteger(pid) && pid > 0, `the child must report its own pid; got ${JSON.stringify(res.stdout)}`);
  const groupSignals = calls.filter((c) => c.pid < 0);
  assert.deepEqual(
    groupSignals,
    [],
    `settling a cleanly exited child must not address its pgid at all, probes included: its leader is reaped and its group empty, so -${pid} may already be a stranger's group and no signal — 0 or otherwise — can tell the two apart. Sent ${JSON.stringify(groupSignals)}`
  );
});

// The hazard the round-3 probe left open, made deterministic: process.kill is stubbed so every
// negative pid answers as if a group with that pgid existed (which is what a recycled pid handed to
// a stranger looks like) and so no signal actually leaves the test. A settle that has seen `close`
// has no evidence the group is its own, so a probe that answers must not escalate into a SIGKILL.
test("run() does not escalate to a group SIGKILL when a cleanly exited child's pgid answers a liveness probe", async () => {
  const saved = process.kill;
  const calls = [];
  let res;
  process.kill = (pid, signal) => {
    if (pid < 0) {
      calls.push({ pid, signal });
      return true; // the pgid "exists"; nothing is forwarded, so a stranger's group is never signalled for real
    }
    return saved.call(process, pid, signal);
  };
  try {
    res = await run(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
  } finally {
    process.kill = saved;
  }
  assert.equal(res.code, 0);
  assert.equal(res.stdout.trim().length > 0, true, "the child must have run and reported its pid");
  const kills = calls.filter((c) => c.signal === "SIGKILL");
  assert.deepEqual(
    kills,
    [],
    `a pgid that answers a probe is not evidence the group is still this run's, so the probe must never license the SIGKILL. Sent ${JSON.stringify(calls)}`
  );
});

test("run() still kills the group at settle while a grandchild is holding it open", async () => {
  let res;
  const calls = await recordKills(async () => {
    res = await run("/bin/sh", ["-c", BACKGROUNDS_A_GRANDCHILD]);
  });
  const pid = Number(res.stdout.trim());
  try {
    assert.ok(
      calls.some((c) => c.pid < 0 && c.signal === "SIGKILL"),
      `a group that still has a live member cannot have had its pgid recycled, so the H5 sweep must still fire; sent ${JSON.stringify(calls)}`
    );
    assert.equal(await waitForExit(pid, 1000), true, "the grandchild must still be dead once run() has settled");
  } finally {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
});

// The timeout timer used to be cleared only inside settle, so a child that exited on its own but
// whose `close` was delayed into the drain window had the timeout fire mid-drain and flip the
// resolved value to timedOut: true — a timeout reported for a child that exited cleanly.
test("a child that exits cleanly is never reported as timedOut when its timeout falls inside the drain window", async () => {
  const timeoutMs = agentCli.DRAIN_GRACE_MS - 300;
  const res = await run("/bin/sh", ["-c", BACKGROUNDS_A_GRANDCHILD], { timeoutMs });
  const pid = Number(res.stdout.trim());
  try {
    assert.equal(res.timedOut, false, "the child exited on its own well inside the timeout; only the delayed close ran past it");
    assert.equal(res.code, 0);
  } finally {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
});

// A detached child no longer receives the terminal's Ctrl-C, so the parent's own SIGTERM must reach
// every live group before the parent dies — otherwise a killed panel leaves claude subprocesses
// orphaned. The runner is a separate node process so the signal can be sent for real.
test("a parent taking SIGTERM kills every live child group before exiting", async () => {
  const pidFile = join(makeTempDir("devcycle-agent-cli-signal-"), "child.pid");
  const runner = `
const { run } = require(${JSON.stringify(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "workflows", "lib", "agent-cli.js"))});
run(process.execPath, ["-e", 'require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 10000)'], { timeoutMs: 10000 });
`;
  const { spawn } = await import("node:child_process");
  const parent = spawn(process.execPath, ["-e", runner], { stdio: "ignore" });
  const until = Date.now() + 3000;
  while (!existsSync(pidFile) && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  assert.ok(existsSync(pidFile), "the child never started");
  const childPid = Number(readFileSync(pidFile, "utf8"));
  parent.kill("SIGTERM");
  await new Promise((r) => parent.once("exit", r));
  assert.equal(await waitForExit(childPid, 1000), true, "the child group must die with its parent");
});

// Audit 2026-09-05 L3: a `structured_output: null` envelope came back { ok: true, value: null } and the
// panel reconciler dereferenced it. Every schema both engines pass is an object schema, so a
// non-object is a validation failure and takes the retry path.
test("claudeStructured rejects a null structured_output as a validation failure after the last attempt", async () => {
  const tries = join(makeTempDir("devcycle-agent-cli-null-"), "tries.log");
  const bin = makeFakeBin(
    "claude",
    `
require("node:fs").appendFileSync(${JSON.stringify(tries)}, "x");
process.stdout.write(JSON.stringify({ is_error: false, structured_output: null }));
`
  );
  const res = await withPath(isolatedPath([bin]), () =>
    claudeStructured({ prompt: "p", tools: "Read", schema: { type: "object" }, attempts: 2, errors: { agent: "editor agent", output: "editor", cap: 400 } })
  );
  assert.deepEqual(res, { ok: false, error: "editor agent returned a non-object structured output" });
  assert.equal(readFileSync(tries, "utf8").length, 2, "a non-object output is retried like any validation failure");
});

test("claudeStructured rejects array and primitive structured_output the same way, and keeps accepting objects", async () => {
  for (const bad of ["[1,2]", '"text"', "42"]) {
    const bin = makeFakeBin("claude", `process.stdout.write(JSON.stringify({ is_error: false, structured_output: ${bad} }));`);
    const res = await withPath(isolatedPath([bin]), () =>
      claudeStructured({ prompt: "p", tools: "Read", schema: { type: "object" }, attempts: 1, errors: { agent: "a", output: "a", cap: 100 } })
    );
    assert.deepEqual(res, { ok: false, error: "a returned a non-object structured output" }, `structured_output ${bad} must be rejected`);
  }
  const good = makeFakeBin("claude", `process.stdout.write(JSON.stringify({ is_error: false, structured_output: { summary: "ok" } }));`);
  const res = await withPath(isolatedPath([good]), () =>
    claudeStructured({ prompt: "p", tools: "Read", schema: { type: "object" }, attempts: 1, errors: { agent: "a", output: "a", cap: 100 } })
  );
  assert.deepEqual(res, { ok: true, value: { summary: "ok" }, cost: null });
});

test("makeLogger tags every line with its engine's name", () => {
  const { log } = makeLogger("mechanical-sweep");
  const written = [];
  const saved = process.stderr.write;
  process.stderr.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    log("editing a.js...");
  } finally {
    process.stderr.write = saved;
  }
  assert.deepEqual(written, ["[mechanical-sweep] editing a.js...\n"]);
});

// makeLogger's `fatal` calls process.exit(1), so it is not callable in-process.
// Its exit code and stderr shape are pinned end to end by the fatal test in
// tests/unit/mechanical-sweep.test.mjs.
