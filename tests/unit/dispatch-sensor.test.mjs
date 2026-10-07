import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { makeRepo, writeInto } from "./helpers.mjs";
import { repoSlug, gitToplevel } from "../../scripts/run-record.mjs";

const HOOK = new URL("../../hooks/dispatch-sensor.mjs", import.meta.url).pathname;
const SCHEMA = JSON.parse(readFileSync(new URL("../fixtures/run-record.schema.json", import.meta.url), "utf8"));
const ROW_SCHEMA = SCHEMA.oneOf.find((b) => b.title === "agent-depth").properties;
const RUN = "00000000000000a1";
const usage = (i, cc, cr, o) => ({ input_tokens: i, cache_creation_input_tokens: cc, cache_read_input_tokens: cr, output_tokens: o });

function fixture({ depth = 16149, stage = "planning", run = RUN, model = "claude-haiku-4-5-20251001" } = {}) {
  const repo = makeRepo();
  writeInto(repo, ".devcycle/state.md", `# devcycle state\n- stage: ${stage}\n- run: ${run}\n`);
  const runsDir = makeTempDir("dispatch-sensor-runs");
  const transcript = join(makeTempDir("dispatch-sensor-t"), "agent-a3382414bf84c15db.jsonl");
  writeFileSync(transcript, [
    { type: "user", timestamp: "2026-10-07T07:18:05.680Z", message: { content: "go" } },
    { type: "assistant", timestamp: "2026-10-07T07:18:12.261Z",
      message: { model, usage: usage(depth, 0, 0, 38), content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] } },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { repo, runsDir, transcript };
}

function callHook({ repo, runsDir, transcript }, extra = {}) {
  return spawnSync("node", [HOOK], {
    input: JSON.stringify({ hook_event_name: "SubagentStop", agent_id: "a3382414bf84c15db", agent_type: "devcycle:plan-researcher",
      agent_transcript_path: transcript, cwd: repo, stop_hook_active: false, ...extra }),
    encoding: "utf8", env: { ...process.env, DEVCYCLE_RUNS_DIR: runsDir } });
}

function rows(repo, runsDir) {
  const dir = join(runsDir, repoSlug(gitToplevel(repo)));
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
}

test("a finished subagent leaves one agent-depth row with its final depth", () => {
  const fx = fixture();
  const r = callHook(fx);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  const [row, ...rest] = rows(fx.repo, fx.runsDir);
  assert.equal(rest.length, 0);
  assert.equal(row.kind, "agent-depth");
  assert.equal(row.stage, "planning");
  assert.equal(row.agentType, "devcycle:plan-researcher");
  assert.equal(row.agentId, "a3382414bf84c15db");
  assert.equal(row.model, "claude-haiku-4-5-20251001");
  assert.equal(row.tokens, 16149);
  assert.equal(row.toolUses, 1);
  assert.equal(row.durationMs, 6581);
  assert.equal(row.depth, "ok");
});

test("above 150k the row says warn; above 200k it says breach and a depth-breach event follows", () => {
  const warn = fixture({ depth: 150_001 });
  callHook(warn);
  assert.equal(rows(warn.repo, warn.runsDir)[0].depth, "warn");
  const breach = fixture({ depth: 200_001 });
  callHook(breach);
  const all = rows(breach.repo, breach.runsDir);
  assert.equal(all.find((o) => o.kind === "agent-depth").depth, "breach");
  assert.deepEqual(all.filter((o) => o.kind === "event").map((o) => [o.event, o.stage]), [["depth-breach", "planning"]]);
});

test("no state file, a run of none, a stage outside the enum, malformed input: silent exit 0, nothing written", () => {
  const fx = fixture({ run: "none" });
  assert.equal(callHook(fx).status, 0);
  const done = fixture({ stage: "done" });
  assert.equal(callHook(done).status, 0);
  const bare = { ...fixture(), repo: makeTempDir("dispatch-sensor-norepo") };
  assert.equal(callHook(bare).status, 0);
  const junkRuns = makeTempDir("dispatch-sensor-junk-runs");
  const junk = spawnSync("node", [HOOK], { input: "{not json", encoding: "utf8", env: { ...process.env, DEVCYCLE_RUNS_DIR: junkRuns } });
  assert.equal(junk.status, 0);
  assert.equal(junk.stdout + junk.stderr, "");
  assert.deepEqual(readdirSync(junkRuns), []);
  for (const f of [fx, done]) assert.deepEqual(rows(f.repo, f.runsDir), []);
  assert.deepEqual(readdirSync(bare.runsDir), []);
});

test("model-authored strings are sanitized to the agent-depth schema: control characters stripped, length capped", () => {
  const fx = fixture({ model: "claude haiku/4\u001b[31m" + "m".repeat(200) });
  callHook(fx, { agent_type: "evil\u001b[31m\ntype" + "x".repeat(200), agent_id: "A3382414BF-x\u0007" + "f".repeat(60) });
  const row = rows(fx.repo, fx.runsDir)[0];
  for (const key of ["agentType", "agentId", "model"]) assert.match(row[key], new RegExp(ROW_SCHEMA[key].pattern), key);
  assert.ok(!row.agentType.includes("\u001b"));
});

test("an agent_id with nothing schema-valid left in it writes the row without an agentId", () => {
  const fx = fixture();
  callHook(fx, { agent_id: "--ABC--" });
  const [row, ...rest] = rows(fx.repo, fx.runsDir);
  assert.equal(rest.length, 0);
  assert.equal(row.kind, "agent-depth");
  assert.ok(!("agentId" in row));
});

test("importing the hook exposes depthOf without reading stdin or exiting the importer", () => {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e",
    `const m = await import(${JSON.stringify(HOOK)}); console.log(typeof m.depthOf, m.depthOf(m.DEPTH_BREACH + 1));`],
  { input: "", encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "function breach");
});
