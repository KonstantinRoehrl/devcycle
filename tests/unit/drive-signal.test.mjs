// scripts/drive-signal.mjs: the only channel from a driven session to its driver. Each test signals
// into a throwaway .devcycle/ named by --state, or into a throwaway repo's.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { makeRepo } from "./helpers.mjs";

const ROOT = process.cwd();
const SCRIPT = join(ROOT, "scripts/drive-signal.mjs");

function devcycleDir(stage = "execution") {
  const dir = join(makeTempDir("drive-signal-"), ".devcycle");
  mkdirSync(dir);
  const statePath = join(dir, "state.md");
  writeFileSync(statePath, `# devcycle state\n- stage: ${stage}\n`);
  return { dir, statePath };
}
const signal = (args, { cwd = ROOT, sessionId = "sess-1", env = {} } = {}) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8", env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId, ...env } });
const stopFile = (dir) => JSON.parse(readFileSync(join(dir, "drive-stop.json"), "utf8"));

test("a stop lands in drive-stop.json with its reason, detail, stage, stamp and hashed session", () => {
  const { dir, statePath } = devcycleDir();
  const r = signal(["knob-drift", "--detail", "profile: standard → lean", "--state", statePath]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { ok: true, action: "signal", reason: "knob-drift", path: join(dir, "drive-stop.json") });
  const s = stopFile(dir);
  assert.deepEqual([s.reason, s.detail, s.stage], ["knob-drift", "profile: standard → lean", "execution"]);
  assert.match(s.stamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(s.sessionHash, createHash("sha256").update("sess-1").digest("hex"));
  assert.deepEqual(readdirSync(dir).sort(), ["drive-stop.json", "state.md"], "no temp file is left behind");
});

test("the detail is one line, capped; without a session id the hash is null; a later signal replaces an earlier one", () => {
  const { dir, statePath } = devcycleDir();
  assert.equal(signal(["needs-user", "--detail", "Which plan?\nA or B?", "--state", statePath]).status, 0);
  assert.equal(stopFile(dir).detail, "Which plan? A or B?");
  assert.equal(signal(["branch", "--detail", "x".repeat(800), "--state", statePath], { sessionId: "" }).status, 0);
  const s = stopFile(dir);
  assert.deepEqual([s.reason, s.detail.length, s.sessionHash], ["branch", 500, null]);
});

test("an unknown or missing reason, or a missing detail, is a usage error that writes nothing", () => {
  const { dir, statePath } = devcycleDir();
  for (const args of [["stalled", "--detail", "x", "--state", statePath], ["--detail", "x", "--state", statePath],
    ["needs-user", "--state", statePath], ["needs-user", "--detail", "--state", statePath], ["needs-user", "extra", "--detail", "x", "--state", statePath]]) {
    const r = signal(args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /^drive-signal: /);
  }
  assert.equal(existsSync(join(dir, "drive-stop.json")), false);
});

test("with no --state the signal goes to the repo's .devcycle; outside a repo it is an environment error", () => {
  const repo = makeRepo();
  const r = signal(["scope-change", "--detail", "task 4 needs a new file"], { cwd: repo });
  assert.equal(r.status, 0, r.stderr);
  const s = stopFile(join(repo, ".devcycle"));
  assert.deepEqual([s.reason, s.stage], ["scope-change", null]);
  const outside = makeTempDir("drive-signal-nogit-");
  const bare = signal(["needs-user", "--detail", "x"], { cwd: outside, env: { GIT_CEILING_DIRECTORIES: dirname(outside) } });
  assert.equal(bare.status, 3, bare.stderr);
});

// In drive mode continue passes wave-setup.mjs's stopReason straight to this script, so every reason
// wave-setup stops a driven session with must be one it accepts. driver-running is manual-only.
test("every reason wave-setup.mjs stops a driven session with is one drive-signal.mjs accepts", () => {
  const accepted = new Set(JSON.parse(readFileSync(SCRIPT, "utf8").match(/const STOP_REASONS = (\[[^\]]*\]);/)[1]));
  const driven = new Set([...readFileSync(join(ROOT, "scripts/wave-setup.mjs"), "utf8").matchAll(/\bstop\("([a-z-]+)"/g)]
    .map((m) => m[1]).filter((reason) => reason !== "driver-running"));
  assert.ok(driven.size >= 8, `expected wave-setup's drive-mode stops, found ${[...driven].join(", ")}`);
  for (const reason of driven) assert.ok(accepted.has(reason), `wave-setup.mjs stops a driven session with "${reason}", which drive-signal.mjs rejects`);
});
