import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { makeRepo, writeInto } from "./helpers.mjs";
import { repoSlug, gitToplevel, hashSession } from "../../scripts/run-record.mjs";

const SINK = new URL("../../hooks/mod-sink.mjs", import.meta.url).pathname;
const RUN = "00000000000000a1";
const SESSION = "cycle-session-mod";
const RECORD = {
  agentId: "a3382414bf84c15db", agentType: "devcycle:implementer", requestedModel: null, resolvedModel: "claude-haiku-4-5-20251001",
  parentAgentId: null, background: false, fork: false, steps: 3, peakDepth: 32000, window: 200000, windowAssumed: false,
  peakBand: "over-budget", toolResultChars: 4096, warned: 1, refused: 0, reason: "answer", isAborted: false,
};

function fixture({ stage = "execution", run = RUN, sessions = [SESSION] } = {}) {
  const repo = makeRepo();
  writeInto(repo, ".devcycle/state.md", `# devcycle state\n- stage: ${stage}\n- run: ${run}\n`);
  const runsDir = makeTempDir("mod-sink-runs");
  const runFile = join(runsDir, repoSlug(gitToplevel(repo)), `${run}.jsonl`);
  mkdirSync(dirname(runFile), { recursive: true });
  writeFileSync(runFile, sessions.map((id) => JSON.stringify({ kind: "session", runId: run, sessionHash: hashSession(id) }) + "\n").join(""));
  return { repo, runsDir };
}

const sink = ({ runsDir }, args, input = "") =>
  spawnSync("node", [SINK, ...args], { input, encoding: "utf8", env: { ...process.env, DEVCYCLE_RUNS_DIR: runsDir } });
const envelope = (fx, extra = {}) => JSON.stringify({ run: RUN, session: SESSION, cwd: join(fx.repo, "src"), record: RECORD, ...extra });

function rows({ repo, runsDir }) {
  const dir = join(runsDir, repoSlug(gitToplevel(repo)));
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)))
    .filter((o) => o.kind !== "session");
}

test("check-joined: joined only for a session with a session row in the run the state file names", () => {
  const fx = fixture();
  const ask = (run, session, cwd = fx.repo) => sink(fx, ["check-joined", "--run", run, "--session", session, "--cwd", cwd]);
  assert.equal(ask(RUN, SESSION).stdout, "joined\n");
  assert.equal(ask(RUN, SESSION, join(fx.repo, "src", "deep")).stdout, "joined\n");
  assert.equal(ask(RUN, "parallel-session").stdout, "not-joined\n");
  assert.equal(ask("00000000000000b2", SESSION).stdout, "not-joined\n");
  assert.equal(ask(RUN, SESSION, makeTempDir("mod-sink-elsewhere")).stdout, "not-joined\n");
  for (const r of [ask(RUN, SESSION), ask(RUN, "parallel-session")]) assert.equal(r.status, 0);
});

test("append writes one agent-trace row carrying the stage at stop, the record's fields, and null where null", () => {
  const fx = fixture({ stage: "execution" });
  writeInto(fx.repo, ".devcycle/state.md", `# devcycle state\n- stage: branch-review\n- run: ${RUN}\n`);
  const r = sink(fx, ["append"], envelope(fx));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  const [row, ...rest] = rows(fx);
  assert.deepEqual(rest, []);
  const { ts, ...fields } = row;
  assert.match(ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(fields, { kind: "agent-trace", runId: RUN, stage: "branch-review", ...RECORD });
});

test("append by a session that never joined, or for a run the state file no longer names, writes nothing", () => {
  const fx = fixture();
  assert.equal(sink(fx, ["append"], envelope(fx, { session: "parallel-session" })).status, 0);
  assert.equal(sink(fx, ["append"], envelope(fx, { run: "00000000000000b2" })).status, 0);
  assert.deepEqual(rows(fx), []);
});

test("malformed input, a record the schema refuses, or an unknown mode: exit 0, nothing written, nothing printed", () => {
  const fx = fixture();
  for (const [args, input] of [
    [["append"], "not json"],
    [["append"], ""],
    [["append"], JSON.stringify({ run: RUN, session: SESSION, cwd: fx.repo })],
    [["append"], envelope(fx, { record: { ...RECORD, reason: "unheard-of" } })],
    [["append"], envelope(fx, { record: { ...RECORD, steps: -1 } })],
    [["check-joined", "--bogus", "x"], ""],
    [["refresh"], ""],
  ]) {
    const r = sink(fx, args, input);
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
    assert.ok(r.stdout === "" || r.stdout === "not-joined\n", `${args.join(" ")} printed ${JSON.stringify(r.stdout)}`);
  }
  assert.deepEqual(rows(fx), []);
});

test("model-adjacent strings are cleaned to the schema's charsets; one with nothing left becomes null", () => {
  const fx = fixture();
  sink(fx, ["append"], envelope(fx, { record: { ...RECORD, agentType: "devcycle:impl\u0007ementer", requestedModel: "\u0001\u0002" } }));
  const [row] = rows(fx);
  assert.equal(row.agentType, "devcycle:implementer");
  assert.equal(row.requestedModel, null);
});
