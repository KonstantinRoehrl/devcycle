import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { writeInto } from "./helpers.mjs";
import { fitRow, roleKey, fitRoles, readRows, ratesReport } from "../../scripts/cost-model-fit.mjs";

const SCRIPT = new URL("../../scripts/cost-model-fit.mjs", import.meta.url).pathname;

// A dispatch the model describes exactly: floor F, reads r, output o over t turns, so
// X = F + r + o and cacheRead = t * (F + (r + o) / 2).
const row = ({ F, r, o, t, ...over }) => ({
  kind: "agent-cost", stage: "planning", agentType: "general-purpose", agentId: "a1", model: "claude-opus-5-5",
  inputTokens: 10, cacheWriteTokens: F + r + o - 10, cacheReadTokens: t * (F + (r + o) / 2), outputTokens: o,
  usd: 1, turns: t, explicitModel: true, continuationOf: 0, ...over,
});

test("fitRow recovers F, t, r and o from a row the model describes exactly", () => {
  assert.deepEqual(fitRow(row({ F: 51000, r: 30000, o: 10000, t: 30 })), { F: 51000, t: 30, r: 30000, o: 10000 });
  assert.deepEqual(fitRow(row({ F: 14000, r: 6000, o: 2000, t: 4 })), { F: 14000, t: 4, r: 6000, o: 2000 });
});

test("fitRow refuses a continuation, a turnless row and a solve that goes negative", () => {
  assert.equal(fitRow(row({ F: 51000, r: 30000, o: 10000, t: 30, continuationOf: 1 })), null);
  assert.equal(fitRow(row({ F: 51000, r: 30000, o: 10000, t: 0 })), null);
  assert.equal(fitRow({ ...row({ F: 51000, r: 30000, o: 10000, t: 30 }), cacheReadTokens: 10 }), null, "F < 0");
  assert.equal(fitRow({ ...row({ F: 51000, r: 30000, o: 10000, t: 30 }), outputTokens: 900000 }), null, "r < 0");
});

test("roleKey is the planning role, else the agent type", () => {
  assert.equal(roleKey({ role: "drafter", agentType: "general-purpose" }), "drafter");
  assert.equal(roleKey({ agentType: "devcycle:implementer" }), "agent:devcycle:implementer");
});

test("fitRoles takes per-role medians over first stops, counting misfits apart", () => {
  const fit = fitRoles([
    row({ F: 50000, r: 20000, o: 8000, t: 20, role: "drafter" }),
    row({ F: 52000, r: 40000, o: 12000, t: 40, role: "drafter" }),
    { ...row({ F: 50000, r: 20000, o: 8000, t: 20, role: "drafter" }), cacheReadTokens: 1 },
    row({ F: 50000, r: 20000, o: 8000, t: 20, role: "drafter", continuationOf: 2 }),
    row({ F: 30000, r: 10000, o: 4000, t: 10, agentType: "devcycle:implementer", stage: "execution" }),
    { kind: "agent-depth", agentId: "a1" },
  ]);
  assert.deepEqual(fit, {
    "agent:devcycle:implementer": { n: 1, misfit: 0, F: 30000, t: 10, r: 10000, o: 4000 },
    drafter: { n: 2, misfit: 1, F: 51000, t: 30, r: 30000, o: 10000 },
  });
});

test("readRows collects every jsonl record under a runs directory, recursively", () => {
  const dir = makeTempDir("cost-model-fit-");
  writeInto(dir, "repo-1/a.jsonl", JSON.stringify({ kind: "run" }) + "\n" + JSON.stringify(row({ F: 1, r: 1, o: 1, t: 1 })) + "\n");
  writeInto(dir, "repo-2/b.jsonl", JSON.stringify({ kind: "session" }) + "\n");
  writeInto(dir, "repo-2/notes.txt", "ignored\n");
  assert.deepEqual(readRows(dir).map((r) => r.kind).sort(), ["agent-cost", "run", "session"]);
});

test("cli prints the per-role table, --json the object, and refuses a missing --runs", () => {
  const dir = makeTempDir("cost-model-fit-");
  writeInto(dir, "repo-1/a.jsonl", JSON.stringify(row({ F: 30000, r: 10000, o: 4000, t: 10, role: "spike" })) + "\n");
  const table = spawnSync(process.execPath, [SCRIPT, "--runs", dir], { encoding: "utf8" });
  assert.equal(table.status, 0, table.stderr);
  assert.match(table.stdout, /^\| Role \| n \| Misfit \| F \| t \| r \| o \|$/m);
  assert.match(table.stdout, /^\| spike \| 1 \| 0 \| 30000 \| 10 \| 10000 \| 4000 \|$/m);
  const json = spawnSync(process.execPath, [SCRIPT, "--runs", dir, "--json"], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(json.stdout), { spike: { n: 1, misfit: 0, F: 30000, t: 10, r: 10000, o: 4000 } });
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" }).status, 2);
});

// One results.json entry as plan-bench-score writes it: P1 is planning $ / task, and `projection` the
// breakdown's estimate-versus-actual. An undefined p1 scores the replay with `rubric: null`.
const result = (id, arm, p1, errorPct) => ({
  id, arm, outcome: "planned", usd: 1,
  rubric: p1 === undefined ? null : [{ id: "P1", value: p1, status: "pass" }, { id: "P2", value: 9, status: "fail" }],
  projection: errorPct === undefined ? null : { estUsd: 1, actualUsd: 1, errorPct },
});
const PASSES = [
  { id: "phase-a", results: [result("small-1", "inline", 1, 10), result("small-1", "grouped", 3, -30), result("medium-1", "inline", 2, 20)] },
  { id: "phase-b", results: [result("small-1", "inline", 4, 30), result("small-1", "status-quo", undefined, undefined), result("small-2", "inline", null, null)] },
];

test("ratesReport: per-arm median planning $/task over numeric P1 values, every replay's projection error, and per-pass worst replay error", () => {
  const report = ratesReport(PASSES);
  assert.deepEqual(report.arms, [
    { arm: "grouped", n: 1, planningUsdPerTask: 3 },
    { arm: "inline", n: 3, planningUsdPerTask: 2 },
    { arm: "status-quo", n: 0, planningUsdPerTask: null },
  ]);
  assert.deepEqual(report.replays, [
    { pass: "phase-a", id: "small-1", arm: "inline", errorPct: 10 },
    { pass: "phase-a", id: "small-1", arm: "grouped", errorPct: -30 },
    { pass: "phase-a", id: "medium-1", arm: "inline", errorPct: 20 },
    { pass: "phase-b", id: "small-1", arm: "inline", errorPct: 30 },
    { pass: "phase-b", id: "small-1", arm: "status-quo", errorPct: null },
    { pass: "phase-b", id: "small-2", arm: "inline", errorPct: null },
  ]);
  assert.deepEqual(report.passes, [{ id: "phase-a", errorPct: -30 }, { id: "phase-b", errorPct: 30 }]);
  assert.equal(report.calibrated, true);
});

test("ratesReport: calibrated needs two passes within the calibration bound, and a pass with no projection error does not count", () => {
  const passOf = (id, ...errors) => ({ id, results: errors.map((e, i) => result(`small-${i}`, "inline", 1, e)) });
  assert.equal(ratesReport([passOf("a", 10), passOf("b", 36)]).calibrated, false);
  assert.equal(ratesReport([passOf("a", 10), passOf("b", -35)]).calibrated, true);
  assert.equal(ratesReport([passOf("a", 10), passOf("b", null)]).calibrated, false);
  assert.deepEqual(ratesReport([passOf("a", 10), passOf("b", null)]).passes, [{ id: "a", errorPct: 10 }, { id: "b", errorPct: null }]);
  assert.equal(ratesReport([passOf("a", 10)]).calibrated, false);
  assert.deepEqual(ratesReport([]), { arms: [], replays: [], passes: [], calibrated: false });
});

test("ratesReport: a pass's error is its replay error of largest magnitude, sign kept, so opposite-sign misses cannot cancel", () => {
  const passOf = (id, ...errors) => ({ id, results: errors.map((e, i) => result(`small-${i}`, "inline", 1, e)) });
  // Tie rule: equal magnitudes of opposite sign (+60/-60) resolve to the positive one.
  const cancelling = ratesReport([passOf("a", 60, -60), passOf("b", 70, -70)]);
  assert.deepEqual(cancelling.passes, [{ id: "a", errorPct: 60 }, { id: "b", errorPct: 70 }]);
  assert.equal(cancelling.calibrated, false);
  const mixed = ratesReport([passOf("a", 10, -30), passOf("b", -5, 20)]);
  assert.deepEqual(mixed.passes, [{ id: "a", errorPct: -30 }, { id: "b", errorPct: 20 }]);
  assert.equal(mixed.calibrated, true);
  assert.deepEqual(ratesReport([passOf("a"), passOf("b", 10)]).passes, [{ id: "a", errorPct: null }, { id: "b", errorPct: 10 }]);
});

// A rates directory: each pass's results.json one level below, as .devcycle/plan-bench/passes holds them.
function ratesDir() {
  const dir = makeTempDir("cost-model-fit-rates-");
  for (const p of [...PASSES].reverse()) writeInto(dir, `${p.id}/results.json`, JSON.stringify(p.results, null, 2) + "\n");
  writeInto(dir, "phase-a/results.md", "| ignored |\n");
  return dir;
}

test("cli --rates prints the per-arm table, one projection error per replay and the calibration verdict", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--rates", ratesDir()], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, [
    "| Arm | n | planning $/task |",
    "| --- | --- | --- |",
    "| grouped | 1 | 3.00 |",
    "| inline | 3 | 2.00 |",
    "| status-quo | 0 | — |",
    "projection error: phase-a/small-1--inline +10.0%",
    "projection error: phase-a/small-1--grouped -30.0%",
    "projection error: phase-a/medium-1--inline +20.0%",
    "projection error: phase-b/small-1--inline +30.0%",
    "projection error: phase-b/small-1--status-quo unknown",
    "projection error: phase-b/small-2--inline unknown",
    "calibration: calibrated (2 of 2 passes within ±35%)",
    "",
  ].join("\n"));
});

test("cli --rates --json prints ratesReport over the passes found, in sorted path order, each named by its directory", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--rates", ratesDir(), "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ratesReport(PASSES));
});

test("cli --rates counts the passes within the bound, and names a directory with no results.json", () => {
  const dir = makeTempDir("cost-model-fit-rates-");
  writeInto(dir, "one/results.json", JSON.stringify([result("small-1", "inline", 1, 50)]));
  writeInto(dir, "two/results.json", JSON.stringify([result("small-1", "inline", 1, -35)]));
  writeInto(dir, "three/results.json", JSON.stringify([result("small-1", "inline", 1, undefined)]));
  const r = spawnSync(process.execPath, [SCRIPT, "--rates", dir], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^calibration: uncalibrated \(1 of 2 passes within ±35%\)$/m);
  const empty = makeTempDir("cost-model-fit-rates-");
  const none = spawnSync(process.execPath, [SCRIPT, "--rates", empty], { encoding: "utf8" });
  assert.equal(none.status, 0, none.stderr);
  assert.equal(none.stdout, `no results.json under ${empty}\n`);
});

test("cli --rates orders the passes by full path, so pass-2/results.json comes before pass/results.json", () => {
  const dir = makeTempDir("cost-model-fit-rates-");
  writeInto(dir, "pass/results.json", JSON.stringify([result("small-1", "inline", 1, 5)]));
  writeInto(dir, "pass-2/results.json", JSON.stringify([result("small-2", "inline", 1, 6)]));
  const r = spawnSync(process.execPath, [SCRIPT, "--rates", dir, "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).passes.map((p) => p.id), ["pass-2", "pass"]);
});

test("cli refuses --rates with --runs, neither and an unknown flag with exit 2, and an unreadable directory with exit 1", () => {
  const dir = makeTempDir("cost-model-fit-rates-");
  const usage = "usage: cost-model-fit.mjs --runs <dir> [--json] | --rates <dir> [--json]";
  for (const [args, reason] of [
    [["--rates", dir, "--runs", dir], "give exactly one of --runs and --rates"],
    [[], "give exactly one of --runs and --rates"],
    [["--bogus"], null],
  ]) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, /^cost-model-fit: .+\n/, args.join(" "));
    assert.ok(r.stderr.endsWith(usage + "\n"), args.join(" "));
    if (reason) assert.ok(r.stderr.startsWith(`cost-model-fit: ${reason}\n`), args.join(" "));
  }
  const missing = `${dir}/absent`;
  const r = spawnSync(process.execPath, [SCRIPT, "--rates", missing], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`^cost-model-fit: cannot read ${missing}: ENOENT`));
});

test("ratesReport: a tie between opposite-sign misses goes to the positive one, whichever comes first", () => {
  const passOf = (id, ...errors) => ({ id, results: errors.map((e, i) => result(`small-${i}`, "inline", 1, e)) });
  assert.deepEqual(ratesReport([passOf("negative-first", -25, 25)]).passes, [{ id: "negative-first", errorPct: 25 }]);
  assert.deepEqual(ratesReport([passOf("positive-first", 25, -25)]).passes, [{ id: "positive-first", errorPct: 25 }]);
});
