import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { makeRepo, writeInto } from "./helpers.mjs";
import { gitToplevel, hashSession, recordPath } from "../../scripts/run-record.mjs";
import { AGENT_TYPE_CHARS, clean, joinedRun, runContext, sessionJoined } from "../../hooks/lib/run-context.mjs";

const RUN = "00000000000000a1";
const state = (stage, run) => `# devcycle state\n- stage: ${stage}\n- run: ${run}\n`;

// recordPath() reads DEVCYCLE_RUNS_DIR in this process, so the fixture sets it here, not in a child.
function withRunsDir(fn) {
  const saved = process.env.DEVCYCLE_RUNS_DIR;
  process.env.DEVCYCLE_RUNS_DIR = makeTempDir("run-context-runs");
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.DEVCYCLE_RUNS_DIR;
    else process.env.DEVCYCLE_RUNS_DIR = saved;
  }
}

test("runContext walks up from start to the state file and names its run, stage and repo root", () => {
  const repo = makeRepo();
  writeInto(repo, ".devcycle/state.md", state("execution", RUN));
  assert.deepEqual(runContext(join(repo, "src", "deep")),
    { run: RUN, stage: "execution", stateFile: join(repo, ".devcycle", "state.md"), repoRoot: repo });
});

test("runContext: a state file naming no active run is no context", () => {
  const repo = makeRepo();
  writeInto(repo, ".devcycle/state.md", state("done", RUN));
  assert.equal(runContext(repo), null);
  writeInto(repo, ".devcycle/state.md", state("execution", "none"));
  assert.equal(runContext(repo), null);
});

test("sessionJoined: a session row in the run joins it; a parallel session does not", () => withRunsDir(() => {
  const repo = makeRepo();
  writeInto(repo, ".devcycle/state.md", state("planning", RUN));
  const runFile = recordPath(gitToplevel(repo), RUN);
  mkdirSync(dirname(runFile), { recursive: true });
  writeFileSync(runFile, JSON.stringify({ kind: "session", runId: RUN, sessionHash: hashSession("joined-session") }) + "\n");
  const context = runContext(repo);
  assert.equal(sessionJoined(context, "joined-session"), true);
  assert.equal(sessionJoined(context, "parallel-session"), false);
  assert.equal(joinedRun(runFile, "parallel-session"), false);
}));

test("clean drops characters outside a schema charset and caps the length", () => {
  assert.equal(clean("devcycle:implementer\u0007\n", AGENT_TYPE_CHARS, 80), "devcycle:implementer");
  assert.equal(clean("x".repeat(100), AGENT_TYPE_CHARS, 80).length, 80);
  assert.equal(clean(undefined, AGENT_TYPE_CHARS, 80), "");
});
