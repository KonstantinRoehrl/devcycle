import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, realpathSync } from "node:fs";
import { join, dirname, delimiter } from "node:path";
import { tmpdir } from "node:os";
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
  const argvLog = join(mkdtempSync(join(tmpdir(), "devcycle-agent-cli-")), "argv.json");
  const bin = makeFakeBin(
    "claude",
    `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
process.stdout.write(JSON.stringify({ is_error: false, structured_output: { ok: true } }));
`
  );
  const cwd = mkdtempSync(join(tmpdir(), "devcycle-agent-cli-cwd-"));
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
  assert.deepEqual(res, { ok: true, value: { ok: true } });

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
  const tries = join(mkdtempSync(join(tmpdir(), "devcycle-agent-cli-tries-")), "tries.log");
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
  const tries = join(mkdtempSync(join(tmpdir(), "devcycle-agent-cli-timeout-tries-")), "tries.log");
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
