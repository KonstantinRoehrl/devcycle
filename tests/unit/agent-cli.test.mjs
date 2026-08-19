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
