import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { gitToplevel, hashSession, repoSlug } from "../../scripts/run-record.mjs";
import { makeFakeBin, makeRepo, writeInto } from "./helpers.mjs";

const HOOK = fileURLToPath(new URL("../../hooks/leftover-sensor.mjs", import.meta.url));
const RUN = "00000000000000a1";
const SESSION = "joined-session";
const FAKE_PS = makeFakeBin("ps", `process.stdout.write(process.env.FAKE_PS ?? "");`);
const FAILING_PS = makeFakeBin("ps", `process.exit(1);`);
const leak = (pgid) => `${pgid + 1} 1 ${pgid} ?? 05:00 98.0 /bin/zsh -c while :; do :; done`;

function fixture({ stage = "execution", run = RUN } = {}) {
  const repo = makeRepo();
  writeInto(repo, ".devcycle/state.md", `# devcycle state\n- stage: ${stage}\n- run: ${run}\n`);
  const runsDir = makeTempDir("leftover-sensor-runs-");
  const runFile = join(runsDir, repoSlug(gitToplevel(repo)), `${run}.jsonl`);
  mkdirSync(dirname(runFile), { recursive: true });
  writeFileSync(runFile, JSON.stringify({ kind: "session", runId: run, sessionHash: hashSession(SESSION) }) + "\n");
  return { repo, runsDir, stamp: join(repo, ".devcycle", "leftovers-reported.json") };
}
function fire(fx, { ps = "", bin = FAKE_PS, ...input } = {}) {
  const body = typeof input.raw === "string" ? input.raw
    : JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash", cwd: fx.repo, session_id: SESSION, ...input });
  const r = spawnSync("node", [HOOK], {
    input: body, encoding: "utf8",
    env: { ...process.env, DEVCYCLE_RUNS_DIR: fx.runsDir, FAKE_PS: ps, PATH: `${bin}${delimiter}${process.env.PATH}` },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
const contextOf = (stdout) => {
  const { hookSpecificOutput: out } = JSON.parse(stdout);
  assert.equal(out.hookEventName, "PostToolUse");
  return out.additionalContext;
};
const expireThrottle = ({ stamp }) => utimesSync(stamp, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

test("a leak is reported to the joined main thread as additional context", () => {
  const report = contextOf(fire(fixture(), { ps: leak(500) }));
  assert.match(report, /- group 500: 1 process, 98% CPU/);
  assert.match(report, /kill -- -500/);
});

test("nothing found prints nothing", () => {
  assert.equal(fire(fixture(), { ps: "" }), "");
});

test("no cycle, a closed cycle, a subagent and an unjoined session print nothing", () => {
  const bare = { repo: makeTempDir("leftover-sensor-bare-"), runsDir: makeTempDir("leftover-sensor-runs-") };
  assert.equal(fire(bare, { ps: leak(500) }), "");
  assert.equal(fire(fixture({ stage: "done" }), { ps: leak(500) }), "");
  assert.equal(fire(fixture(), { ps: leak(500), agent_type: "devcycle:implementer" }), "");
  assert.equal(fire(fixture(), { ps: leak(500), session_id: "someone-else" }), "");
});

test("a scan under thirty seconds after the last is skipped, leak or not", () => {
  const fx = fixture();
  assert.equal(fire(fx, { ps: "" }), "");
  assert.ok(existsSync(fx.stamp), "the first pass stamps");
  assert.equal(fire(fx, { ps: leak(500) }), "", "throttled");
  expireThrottle(fx);
  assert.match(contextOf(fire(fx, { ps: leak(500) })), /group 500/);
});

test("an unjoined session's pass still stamps, so it never pays for the join on every call", () => {
  const fx = fixture();
  assert.equal(fire(fx, { session_id: "someone-else" }), "");
  assert.ok(existsSync(fx.stamp));
});

test("each group is reported once per run, and a later group still is", () => {
  const fx = fixture();
  assert.match(contextOf(fire(fx, { ps: leak(500) })), /group 500/);
  expireThrottle(fx);
  assert.equal(fire(fx, { ps: leak(500) }), "");
  expireThrottle(fx);
  const report = contextOf(fire(fx, { ps: `${leak(500)}\n${leak(600)}` }));
  assert.match(report, /group 600/);
  assert.doesNotMatch(report, /group 500/);
});

test("a new run id discards the reported list", () => {
  const fx = fixture();
  fire(fx, { ps: leak(500) });
  writeFileSync(fx.stamp, JSON.stringify({ run: "00000000000000ff", reported: [500] }));
  expireThrottle(fx);
  assert.match(contextOf(fire(fx, { ps: leak(500) })), /group 500/);
});

test("no command line reaches the disk", () => {
  const fx = fixture();
  fire(fx, { ps: leak(500) });
  assert.deepEqual(JSON.parse(readFileSync(fx.stamp, "utf8")), { run: RUN, reported: [500] });
});

test("a corrupt state file reads as nothing reported", () => {
  const fx = fixture();
  writeFileSync(fx.stamp, "{not json");
  expireThrottle(fx);
  assert.match(contextOf(fire(fx, { ps: leak(500) })), /group 500/);
});

test("malformed input and a failing ps exit 0 with no output", () => {
  const fx = fixture();
  assert.equal(fire(fx, { raw: "{not json" }), "");
  assert.equal(fire(fx, { raw: "[]" }), "");
  assert.equal(fire(fixture(), { bin: FAILING_PS, ps: leak(500) }), "");
});

test("the sensor is registered on PostToolUse over Bash with a five-second timeout", () => {
  const hooks = JSON.parse(readFileSync(new URL("../../hooks/hooks.json", import.meta.url), "utf8")).hooks;
  const entry = hooks.PostToolUse.find((e) => e.hooks.some((h) => h.command.includes("hooks/leftover-sensor.mjs")));
  assert.equal(entry?.matcher, "Bash");
  assert.equal(entry.hooks[0].timeout, 5);
});
