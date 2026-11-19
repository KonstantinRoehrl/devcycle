import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { makeRepo, writeInto } from "./helpers.mjs";
import { RUBRIC_IDS, replayBreakdowns, scoreReplay, resultsMarkdown, scorePass, armCheck } from "../../scripts/plan-bench-score.mjs";

const SCRIPT = new URL("../../scripts/plan-bench.mjs", import.meta.url).pathname;
const RUN = "0f1e2d3c4b5a6978";
const SESSION = "sess-plan-bench-1";
const TS = "2026-10-07T07:05:00Z";
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

// One replay directory in the layout runPass writes, holding a planning run doctor can break down:
// the run record under runs/, one coordinator turn under corpus/.
// `knobs` is the knobs: line the replay's state.md carries; the default is the arm the replay was run as.
function replay(passDir, name, { outcome = "planned", planning = true, knobs } = {}) {
  const dir = join(passDir, name);
  const [id, arm] = name.split("--");
  if (knobs !== null) writeInto(dir, "state.md", `# devcycle state\n- stage: execution\n- knobs: ${knobs ?? `profile=standard planningStrategy=${arm} subagentBudget=warn`}\n`);
  writeInto(dir, "outcome.json", JSON.stringify({ id, size: "small", arm, outcome, usd: 1.5,
    legs: [{ phase: "plan", sessionId: SESSION, costUsd: 1, denials: 1, verdict: "question" }, { phase: "plan", sessionId: SESSION, costUsd: 0.5, denials: 0, verdict: "done" }],
    question: null, sessions: 1 }));
  writeInto(dir, `runs/repo-00000000/${RUN}.jsonl`, jsonl([
    { kind: "run", runId: RUN, schemaVersion: 1, pluginVersion: "0.33.0", repoSlug: "repo-00000000", startedAt: "2026-10-07T07:00:00Z" },
    { kind: "session", runId: RUN, sessionHash: createHash("sha256").update(SESSION).digest("hex") },
    ...(planning ? [
      { kind: "stage", runId: RUN, stage: "planning", startedAt: "2026-10-07T07:00:00Z", endedAt: "2026-10-07T07:10:00Z", outcome: "complete" },
      { kind: "plan-stats", runId: RUN, stage: "planning", specBytes: 10000, planBytes: 40000, fenceShare: 0.2, tasks: 4, waves: 2,
        strategy: "inline", drafters: 0, subagentUsd: 0, specReview: "pass", ts: TS },
    ] : []),
  ]));
  writeInto(dir, `corpus/-fake/${SESSION}.jsonl`, jsonl([{ sessionId: SESSION, isSidechain: false, type: "assistant", timestamp: "2026-10-07T07:05:00.000Z",
    message: { model: "claude-opus-5", usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 100000 } } }]));
  return dir;
}

test("replayBreakdowns runs doctor's summarizer and rubric over a replay's corpus and runs", () => {
  const found = replayBreakdowns(replay(makeTempDir("plan-bench-pass-"), "small-1--inline"));
  assert.equal(found.length, 1);
  assert.equal(found[0].runId, RUN);
  assert.deepEqual(found[0].breakdown.rubric.map((r) => r.id), RUBRIC_IDS);
  assert.equal(found[0].breakdown.rubric.find((r) => r.id === "P8").status, "pass");
});

test("scoreReplay joins the outcome with the rubric, and a replay with no planning breakdown scores null", () => {
  const pass = makeTempDir("plan-bench-pass-");
  const s = scoreReplay(replay(pass, "small-1--inline"));
  assert.deepEqual([s.id, s.arm, s.outcome, s.usd, s.legs, s.denials, s.runId], ["small-1", "inline", "planned", 1.5, 2, 1, RUN]);
  assert.equal(s.rubric.length, 12);
  const none = scoreReplay(replay(pass, "small-2--inline", { outcome: "unanswered", planning: false }));
  assert.deepEqual([none.outcome, none.rubric, none.byRole, none.runId], ["unanswered", null, null, null]);
});

test("armCheck reads the planningStrategy the replay's state.md knobs: line resolved and compares it to the arm", () => {
  const pass = makeTempDir("plan-bench-pass-");
  const check = (arm, opts) => armCheck(replay(pass, `${arm}-${Math.random().toString(36).slice(2)}--${arm}`, opts), arm);
  assert.deepEqual(check("inline", {}), { armCheck: "verified", armSeen: "inline" });
  assert.deepEqual(check("status-quo", {}), { armCheck: "verified", armSeen: "status-quo" });
  assert.deepEqual(check("inline", { knobs: "profile=standard planningStrategy=auto" }), { armCheck: "arm-mismatch", armSeen: "auto" });
  assert.deepEqual(check("inline", { knobs: "profile=standard" }), { armCheck: "arm-unverified", armSeen: null });
  assert.deepEqual(check("inline", { knobs: null }), { armCheck: "arm-unverified", armSeen: null });
});

test("scoreReplay carries the arm check, and the results table flags a mismatched or unverified arm beside its outcome, never silently", () => {
  const pass = makeTempDir("plan-bench-pass-");
  const bad = scoreReplay(replay(pass, "small-1--inline", { knobs: "planningStrategy=auto" }));
  assert.deepEqual([bad.armCheck, bad.armSeen], ["arm-mismatch", "auto"]);
  const unknown = scoreReplay(replay(pass, "small-2--inline", { knobs: null }));
  assert.equal(unknown.armCheck, "arm-unverified");
  const good = scoreReplay(replay(pass, "small-3--inline"));
  assert.equal(good.armCheck, "verified");
  const rows = resultsMarkdown([bad, unknown, good]).split("\n").slice(2);
  assert.match(rows[0], /^\| small-1 \| inline \| planned \(arm-mismatch: saw auto\) \| 1\.50 \|/);
  assert.match(rows[1], /^\| small-2 \| inline \| planned \(arm-unverified\) \| 1\.50 \|/);
  assert.match(rows[2], /^\| small-3 \| inline \| planned \| 1\.50 \|/);
});

test("resultsMarkdown tables each replay's P1-P12 as value and status, a dash where nothing was scored", () => {
  const rubric = RUBRIC_IDS.map((id) => ({ id, value: id === "P8" ? { bytesRatio: 4, fenceShare: 0.2 } : id === "P1" ? 0.0251 : null, status: id === "P1" || id === "P8" ? "pass" : "n/a" }));
  const md = resultsMarkdown([
    { id: "small-1", arm: "inline", outcome: "planned", usd: 1.5, rubric },
    { id: "small-1", arm: "status-quo", outcome: "error", usd: 0, rubric: null },
  ]);
  const lines = md.split("\n");
  assert.equal(lines[0], "| Entry | Arm | Outcome | $ | P1 | P2 | P3 | P4 | P5 | P6 | P7 | P8 | P9 | P10 | P11 | P12 |");
  assert.match(lines[2], /^\| small-1 \| inline \| planned \| 1\.50 \| 0\.025 pass \| — n\/a \| .* \| 4\/0\.2 pass \| /);
  assert.equal(lines[3], "| small-1 | status-quo | error | 0.00 | — | — | — | — | — | — | — | — | — | — | — | — |");
});

test("scorePass scores every replay in name order and writes results.json and results.md", () => {
  const pass = makeTempDir("plan-bench-pass-");
  replay(pass, "small-1--status-quo");
  replay(pass, "small-1--inline");
  const results = scorePass(pass);
  assert.deepEqual(results.map((r) => r.arm), ["inline", "status-quo"]);
  assert.equal(JSON.parse(readFileSync(join(pass, "results.json"), "utf8")).length, 2);
  assert.match(readFileSync(join(pass, "results.md"), "utf8"), /^\| Entry \| Arm \|/);
});

test("scorePass counts only the replays the pass was run with, never a stale outcome from an earlier run", () => {
  const pass = makeTempDir("plan-bench-pass-");
  replay(pass, "small-1--inline");
  replay(pass, "stale-9--inline");
  writeInto(pass, "pass.json", JSON.stringify({ replays: ["small-1--inline", "small-1--status-quo"] }));
  assert.deepEqual(scorePass(pass).map((r) => `${r.id}--${r.arm}`), ["small-1--inline"]);
});

test("cli score re-scores a pass without launching anything, and names a missing pass", () => {
  const root = makeRepo();
  replay(join(root, ".devcycle/plan-bench/passes/2"), "small-1--inline");
  const r = spawnSync(process.execPath, [SCRIPT, "score", "--pass", "2"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\| small-1 \| inline \| planned \| 1\.50 \| /m);
  assert.ok(existsSync(join(root, ".devcycle/plan-bench/passes/2/results.md")));
  const missing = spawnSync(process.execPath, [SCRIPT, "score", "--pass", "9"], { cwd: root, encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no pass 9 at /);
});
