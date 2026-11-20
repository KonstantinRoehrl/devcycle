import { test } from "node:test";
import assert from "node:assert/strict";
import { planningBreakdown, corpusGateLegs, corpusGateLegsLine, reworkFails } from "../../scripts/doctor-planning.mjs";
import { loadTable } from "../../scripts/model-pool.mjs";

const cost = (agentId, role, usd, extra = {}) => ({
  kind: "agent-cost", stage: "planning", agentType: "devcycle:implementer", agentId, model: "claude-sonnet-5-5",
  role, usd, explicitModel: true, continuationOf: 0, turns: 3, ...extra,
});
const depth = (agentId, tokens, extra = {}) => ({ kind: "agent-depth", stage: "planning", agentId, tokens, ...extra });
const gate = (result, legs, stage = "planning") => ({ kind: "event", event: "gate-ran", stage, result, ...(legs ? { legs } : {}) });
const stats = (extra = {}) => ({ kind: "plan-stats", stage: "planning", specBytes: 10000, planBytes: 40000, fenceShare: 0.2,
  tasks: 4, waves: 2, strategy: "delegated", drafters: 2, subagentUsd: null, specReview: "pass", ...extra });

// A run that sits inside every bar: 4 tasks, $6 of planning against $12 of execution.
const healthy = (over = {}) => ({
  agentCosts: [cost("a1", "drafter", 1), cost("a2", "checker", 0.5)],
  planStats: stats(),
  events: [],
  agentDepths: [depth("a1", 90000), depth("a2", 60000)],
  planningUsd: 6,
  executionUsd: 12,
  planningMinutes: 8,
  blocked: 0, retried: 1,
  ...over,
});
const row = (b, id) => b.rubric.find((r) => r.id === id);

test("rubric: one row per P1..P12 in order, each with a status of pass, fail or n/a", () => {
  const { rubric } = planningBreakdown(healthy());
  assert.deepEqual(rubric.map((r) => r.id), Array.from({ length: 12 }, (_, i) => `P${i + 1}`));
  for (const r of rubric) assert.ok(["pass", "fail", "n/a"].includes(r.status), `${r.id}: ${r.status}`);
  for (const r of rubric.filter((x) => x.status === "n/a")) assert.ok(r.reason, `${r.id} n/a carries a reason`);
});

test("byRole: sums dollars per role, with an unrolled bucket and the coordinator remainder", () => {
  const b = planningBreakdown(healthy({
    agentCosts: [cost("a1", "drafter", 1), cost("a2", "drafter", 0.25), cost("a3", "checker", 0.5), cost("a4", undefined, 0.75),
      cost("x", "drafter", 9, { stage: "execution" })],
  }));
  assert.deepEqual(b.byRole, { spike: 0, research: 0, drafter: 1.25, checker: 0.5, repair: 0, unrolled: 0.75, coordinator: 3.5 });
});

test("byRole: coordinator is planning-stage dollars minus planning subagent dollars", () => {
  assert.equal(planningBreakdown(healthy({ planningUsd: 10 })).byRole.coordinator, 8.5);
});

test("byRole: null propagates, never a faked zero", () => {
  const noPlanning = planningBreakdown(healthy({ planningUsd: null }));
  assert.equal(noPlanning.byRole.coordinator, null);
  assert.equal(noPlanning.byRole.drafter, 1);

  const unpriced = planningBreakdown(healthy({ agentCosts: [cost("a1", "drafter", null), cost("a2", "checker", 0.5)] }));
  assert.equal(unpriced.byRole.drafter, null);
  assert.equal(unpriced.byRole.checker, 0.5);
  assert.equal(unpriced.byRole.coordinator, null);

  const noRows = planningBreakdown(healthy({ agentCosts: [] }));
  assert.deepEqual(Object.values(noRows.byRole), Array(7).fill(null));
});

test("byRole: a run with no cost rows whose plan-stats say the subagents cost $0 is known, not null", () => {
  const b = planningBreakdown(healthy({ agentCosts: [], agentDepths: [], planStats: stats({ strategy: "inline", drafters: 0, subagentUsd: 0 }) }));
  assert.equal(b.byRole.drafter, 0);
  assert.equal(b.byRole.coordinator, 6);
});

test("byRole: planning subagents that ran with no cost row are unknown, not $0, and the coordinator is unknown too", () => {
  // An older plan-stats row carries the 0 that planStats once derived from the missing rows.
  for (const subagentUsd of [null, 0]) {
    const b = planningBreakdown(healthy({ agentCosts: [], planStats: stats({ subagentUsd }) }));
    assert.deepEqual(Object.values(b.byRole), Array(7).fill(null), `subagentUsd ${subagentUsd}`);
  }
});

test("corpusGateLegs: sums failing legs across runs, by count then name, and is empty with none", () => {
  const run = (...legs) => ({ runId: "r", breakdown: { gateLegs: Object.fromEntries(legs) } });
  assert.deepEqual(corpusGateLegs([run(["Drift", 2], ["Blast", 1]), run(["Blast", 1], ["Zed", 3], ["Alpha", 1])]),
    [["Zed", 3], ["Blast", 2], ["Drift", 2], ["Alpha", 1]]);
  assert.deepEqual(corpusGateLegs([run(), run()]), []);
  assert.equal(corpusGateLegsLine([run(["Drift", 2]), run(["Blast", 1], ["Drift", 1])]), "Failing plan-check legs, all runs: Drift 3, Blast 1.");
  assert.equal(corpusGateLegsLine([run()]), null);
});

test("P1: planning dollars per task, bar <= 2.0", () => {
  assert.deepEqual(row(planningBreakdown(healthy({ planningUsd: 8 })), "P1"), { id: "P1", measure: "planning $ / task", value: 2, bar: "<= 2.0", status: "pass" });
  assert.equal(row(planningBreakdown(healthy({ planningUsd: 8.04 })), "P1").status, "fail");
  assert.equal(row(planningBreakdown(healthy({ planningUsd: 7.9 })), "P1").status, "pass");
  assert.equal(row(planningBreakdown(healthy({ planningUsd: null })), "P1").status, "n/a");
  assert.equal(row(planningBreakdown(healthy({ planStats: null })), "P1").status, "n/a");
  assert.equal(row(planningBreakdown(healthy({ planStats: stats({ tasks: 0 }) })), "P1").status, "n/a");
});

test("P2: planning over execution dollars, bar <= 1.0", () => {
  assert.equal(row(planningBreakdown(healthy({ planningUsd: 12, executionUsd: 12 })), "P2").status, "pass");
  assert.equal(row(planningBreakdown(healthy({ planningUsd: 12.1, executionUsd: 12 })), "P2").status, "fail");
  assert.equal(row(planningBreakdown(healthy({ executionUsd: null })), "P2").status, "n/a");
  assert.equal(row(planningBreakdown(healthy({ executionUsd: 0 })), "P2").status, "n/a");
});

test("P3: distinct planning dispatches per task, bar <= 0.5", () => {
  const dispatches = (n) => Array.from({ length: n }, (_, i) => depth(`d${i}`, 1000));
  assert.equal(row(planningBreakdown(healthy({ agentDepths: dispatches(2) })), "P3").status, "pass");
  assert.equal(row(planningBreakdown(healthy({ agentDepths: dispatches(3) })), "P3").status, "fail");
  // A continued subagent writes a second row under one id: one dispatch.
  assert.equal(row(planningBreakdown(healthy({ agentDepths: [depth("d0", 1), depth("d0", 2), depth("d1", 1)] })), "P3").value, 0.5);
  // No depth rows is the sensor gap, not zero dispatches.
  assert.equal(row(planningBreakdown(healthy({ agentDepths: [] })), "P3").status, "n/a");
  assert.equal(row(planningBreakdown(healthy({ planStats: null })), "P3").status, "n/a");
});

test("P4: p95 of each planning dispatch's final depth, bar <= 150000", () => {
  assert.equal(row(planningBreakdown(healthy({ agentDepths: [depth("a1", 150000)] })), "P4").status, "pass");
  assert.equal(row(planningBreakdown(healthy({ agentDepths: [depth("a1", 150001)] })), "P4").status, "fail");
  // Final depth: a continued subagent's last row stands for it.
  const continued = planningBreakdown(healthy({ agentDepths: [depth("a1", 200000), depth("a1", 90000)] }));
  assert.equal(row(continued, "P4").value, 90000);
  // Nearest rank: 20 dispatches put the p95 on the 19th.
  const twenty = Array.from({ length: 20 }, (_, i) => depth(`d${i}`, (i + 1) * 1000));
  assert.equal(row(planningBreakdown(healthy({ agentDepths: twenty })), "P4").value, 19000);
  // Execution depth rows are not planning dispatches.
  assert.equal(row(planningBreakdown(healthy({ agentDepths: [depth("e", 900000, { stage: "execution" })] })), "P4").status, "n/a");
});

test("P7: share of planning dispatches with an explicit model, bar 100%", () => {
  assert.equal(row(planningBreakdown(healthy()), "P7").status, "pass");
  const one = planningBreakdown(healthy({ agentCosts: [cost("a1", "drafter", 1), cost("a2", "checker", 1, { explicitModel: false })] }));
  assert.equal(row(one, "P7").value, 0.5);
  assert.equal(row(one, "P7").status, "fail");
  assert.equal(row(planningBreakdown(healthy({ agentCosts: [] })), "P7").status, "n/a");
});

test("P8: plan/spec bytes <= 5 and nonTestFenceShare <= 0.20, else fenceShare <= 0.30 on a row recorded without it", () => {
  const at = (extra) => row(planningBreakdown(healthy({ planStats: stats(extra) })), "P8");
  assert.equal(at({ specBytes: 10000, planBytes: 50000, fenceShare: 0.39, nonTestFenceShare: 0.2 }).status, "pass");
  assert.equal(at({ specBytes: 10000, planBytes: 50000, fenceShare: 0.1, nonTestFenceShare: 0.21 }).status, "fail");
  assert.equal(at({ specBytes: 10000, planBytes: 50001, fenceShare: 0.1, nonTestFenceShare: 0.1 }).status, "fail");
  assert.equal(at({ specBytes: 10000, planBytes: 50000, fenceShare: 0.3 }).status, "pass");
  assert.equal(at({ specBytes: 10000, planBytes: 50000, fenceShare: 0.31 }).status, "fail");
  assert.deepEqual(at({ specBytes: 10000, planBytes: 20000, fenceShare: 0.1 }).value, { bytesRatio: 2, fenceShare: 0.1, nonTestFenceShare: null });
  assert.deepEqual(at({ specBytes: 10000, planBytes: 20000, fenceShare: 0.3, nonTestFenceShare: 0.05 }).value, { bytesRatio: 2, fenceShare: 0.3, nonTestFenceShare: 0.05 });
  assert.equal(at({ specBytes: 0 }).status, "n/a");
  assert.equal(row(planningBreakdown(healthy({ planStats: null })), "P8").status, "n/a");
});

test("reworkFails drops a fail that re-runs the previous planning gate on the same plan with the same legs", () => {
  const g = (result, legs, planDigest, stage = "planning") => ({ ...gate(result, legs, stage), ...(planDigest ? { planDigest } : {}) });
  const events = [
    g("fail", "blastRadius", "aaaaaaaaaaaa"),
    g("fail", "blastRadius", "aaaaaaaaaaaa"), // identical re-run: dropped
    g("fail", "crossTask", "aaaaaaaaaaaa"), // same plan, different legs: kept
    g("fail", "crossTask", "bbbbbbbbbbbb"), // plan changed: kept
    g("fail", "crossTask", "bbbbbbbbbbbb", "execution"), // another stage: not planning
    g("pass", undefined, "cccccccccccc"),
    g("fail", "crossTask", "bbbbbbbbbbbb"), // previous planning gate passed on another plan: kept
    g("fail", "crossTask"), // no digest: never dropped
    g("fail", "crossTask"),
  ];
  assert.deepEqual(reworkFails(events).map((e) => [e.legs, e.planDigest ?? null]), [
    ["blastRadius", "aaaaaaaaaaaa"], ["crossTask", "aaaaaaaaaaaa"], ["crossTask", "bbbbbbbbbbbb"],
    ["crossTask", "bbbbbbbbbbbb"], ["crossTask", null], ["crossTask", null],
  ]);
});

test("P9 counts rework fails while gateLegs still counts every planning fail", () => {
  const twin = { ...gate("fail", "blastRadius"), planDigest: "aaaaaaaaaaaa" };
  const b = planningBreakdown(healthy({ events: [twin, twin, twin] }));
  assert.equal(row(b, "P9").value.gateFails, 1);
  assert.equal(b.gateLegs.blastRadius, 3);
});

test("P9: planning gate-ran fails <= 2 and checker rounds <= 1", () => {
  const events = (n) => Array.from({ length: n }, () => gate("fail", "Drift"));
  const fails = (n, costs) => row(planningBreakdown(healthy({ events: events(n), ...(costs ? { agentCosts: costs } : {}) })), "P9");
  assert.equal(fails(2).status, "pass");
  assert.equal(fails(3).status, "fail");
  assert.deepEqual(fails(2).value, { gateFails: 2, checkerRounds: 1 });
  // A passing gate, and a gate from another stage, are not planning fails.
  const mixed = planningBreakdown(healthy({ events: [gate("pass"), gate("fail", "Drift", "execution")] }));
  assert.equal(row(mixed, "P9").value.gateFails, 0);
  // Two distinct checkers fail the bar; two rows of one continued checker do not.
  assert.equal(fails(0, [cost("c1", "checker", 1), cost("c2", "checker", 1)]).status, "fail");
  assert.equal(fails(0, [cost("c1", "checker", 1), cost("c1", "checker", 1, { continuationOf: 1 })]).status, "pass");
  // Rows are absent and the plan was not inline: the checker count is unknown.
  assert.equal(fails(0, []).status, "n/a");
});

test("P10: plan-defect count is reported and never judged", () => {
  const events = [{ kind: "event", event: "review-reject", stage: "execution", culprit: "plan-defect" },
    { kind: "event", event: "gate-fail", stage: "planning", culprit: "plan-defect" },
    { kind: "event", event: "gate-fail", stage: "execution", culprit: "other" }];
  const b = planningBreakdown(healthy({ events }));
  assert.equal(b.planDefects, 2);
  assert.deepEqual({ ...row(b, "P10"), reason: undefined }, { id: "P10", measure: "plan-defect count", value: 2, bar: "baseline-relative", status: "n/a", reason: undefined });
  assert.ok(row(b, "P10").reason);
  assert.equal(planningBreakdown(healthy()).planDefects, 0);
});

test("P11: planning minutes per task, bar <= 3", () => {
  assert.equal(row(planningBreakdown(healthy({ planningMinutes: 12 })), "P11").status, "pass");
  assert.equal(row(planningBreakdown(healthy({ planningMinutes: 12.5 })), "P11").status, "fail");
  assert.equal(row(planningBreakdown(healthy({ planningMinutes: null })), "P11").status, "n/a");
  assert.equal(row(planningBreakdown(healthy({ planStats: null })), "P11").status, "n/a");
});

test("P12: every planning dispatch has a cost row and a role, and no sensor gaps", () => {
  assert.equal(row(planningBreakdown(healthy()), "P12").status, "pass");
  assert.deepEqual(row(planningBreakdown(healthy()), "P12").value, { share: 1, gaps: 0 });
  const missing = planningBreakdown(healthy({ agentDepths: [depth("a1", 1), depth("a2", 1), depth("a3", 1)] }));
  assert.equal(row(missing, "P12").status, "fail");
  assert.equal(row(missing, "P12").value.share, 2 / 3);
  assert.equal(row(planningBreakdown(healthy({ agentDepths: [] })), "P12").status, "n/a");
});

test("sensorGaps: a planning depth row with no cost row is no-cost-row", () => {
  const b = planningBreakdown(healthy({ agentDepths: [depth("a1", 1), depth("a2", 1), depth("ghost", 1), depth("ghost", 2)] }));
  assert.deepEqual(b.sensorGaps, [{ agentId: "ghost", cause: "no-cost-row" }]);
});

test("sensorGaps: a planning cost row with no role is no-role, once per agent", () => {
  const b = planningBreakdown(healthy({
    agentCosts: [cost("a1", "drafter", 1), cost("a2", undefined, 1), cost("a2", undefined, 1, { continuationOf: 1 })],
  }));
  assert.deepEqual(b.sensorGaps, [{ agentId: "a2", cause: "no-role" }]);
  assert.equal(row(b, "P12").status, "fail");
});

test("sensorGaps: another stage's rows are not planning gaps", () => {
  const b = planningBreakdown(healthy({
    agentCosts: [cost("a1", "drafter", 1), cost("a2", "checker", 1), cost("e1", undefined, 1, { stage: "execution" })],
    agentDepths: [depth("a1", 1), depth("a2", 1), depth("e9", 1, { stage: "execution" })],
  }));
  assert.deepEqual(b.sensorGaps, []);
});

test("gateLegs: histogram over the planning gate-ran fail rows' legs", () => {
  const b = planningBreakdown(healthy({
    events: [gate("fail", "Drift,Blast"), gate("fail", "Drift"), gate("pass"), gate("fail", "Other", "execution"), gate("fail")],
  }));
  assert.deepEqual(b.gateLegs, { Drift: 2, Blast: 1 });
  assert.deepEqual(planningBreakdown(healthy()).gateLegs, {});
});

test("raw: execution blocked, rejected and retried counts; null when unknown", () => {
  const events = [{ kind: "event", event: "review-reject", stage: "execution" }, { kind: "event", event: "review-reject", stage: "execution" }];
  assert.deepEqual(planningBreakdown(healthy({ events, blocked: 3, retried: 1 })).raw, { blocked: 3, rejected: 2, retried: 1 });
  assert.deepEqual(planningBreakdown(healthy({ blocked: null, retried: null })).raw, { blocked: null, rejected: 0, retried: null });
});

test("sensorGaps: a null-usd cost row names its measurement as the cause, once per agent; a priced row or one with no measurement adds none", () => {
  const b = planningBreakdown(healthy({
    agentCosts: [cost("a1", "drafter", 1), cost("a2", "checker", null, { measurement: "unpriced-model:claude-foo" }),
      cost("a2", "checker", null, { measurement: "unpriced-model:claude-foo", continuationOf: 1 }), cost("a3", "checker", null)],
  }));
  assert.deepEqual(b.sensorGaps, [{ agentId: "a2", cause: "null-usd:unpriced-model:claude-foo" }]);
});

const TIERS = loadTable();
const reading = (agentId, role, reads, extra = {}) =>
  cost(agentId, role, 0.1, { inputTokens: 4000, cacheWriteTokens: 1000, sourcePrints: 2, reads, ...extra });
const PACK = ".devcycle/plan-work/r/pack.md";

test("P6: tokens re-read from another planning dispatch over their input, the plan-work pack excluded, bar 20%", () => {
  const two = [reading("a1", "drafter", { "scripts/plan-check.mjs": 1000, [PACK]: 2000 }),
    reading("a2", "drafter", { "scripts/plan-check.mjs": 1000, [PACK]: 2000 })];
  const b = planningBreakdown(healthy({ agentCosts: two }));
  assert.equal(b.p6, 0.1);
  assert.equal(row(b, "P6").status, "pass");
  assert.equal(row(b, "P6").bar, "<= 20%");
  const three = [...two, reading("a3", "checker", { "scripts/plan-check.mjs": 3000 })];
  assert.equal(row(planningBreakdown(healthy({ agentCosts: three })), "P6").status, "fail");
  const own = [reading("a1", "drafter", { "a.mjs": 1000 }), reading("a1", "drafter", { "a.mjs": 1000 }, { continuationOf: 1 })];
  assert.equal(planningBreakdown(healthy({ agentCosts: own })).p6, 0, "an agent re-reading its own path is not shared context");
});

test("P6 is n/a when a planning dispatch row carries no reads; P5 stays n/a until Phase 3", () => {
  const b = planningBreakdown(healthy({ agentCosts: [reading("a1", "drafter", { "a.mjs": 10 }), cost("a2", "checker", 0.5)] }));
  assert.equal(b.p6, null);
  assert.equal(row(b, "P6").status, "n/a");
  assert.match(row(b, "P6").reason, /without reads/);
  assert.equal(row(b, "P5").status, "n/a");
  assert.match(row(b, "P5").reason, /Phase 3/);
});

test("drafterTurns and sourcePrints: turns summed per drafter in first-seen order; prints null unless every dispatch row has them", () => {
  const rows = [reading("a1", "drafter", {}, { turns: 2 }), reading("a2", "drafter", {}, { turns: 5, model: "claude-opus-5" }),
    reading("a1", "drafter", {}, { turns: 1, continuationOf: 1 }), reading("c1", "checker", {}, { model: "claude-haiku-4-5" })];
  const b = planningBreakdown(healthy({ agentCosts: rows }));
  assert.deepEqual(b.drafterTurns, [{ agentId: "a1", model: "claude-sonnet-5-5", turns: 3 }, { agentId: "a2", model: "claude-opus-5", turns: 5 }]);
  assert.equal(b.sourcePrints, 8);
  assert.equal(planningBreakdown(healthy()).sourcePrints, null);
});

test("tierFit: a spike, research or checker dispatch above the fast tier is flagged; drafters and unrankable models are not", () => {
  const rows = [cost("c1", "checker", 0.1, { model: "claude-opus-5" }), cost("c1", "checker", 0.1, { model: "claude-opus-5", continuationOf: 1 }),
    cost("c2", "checker", 0.1, { model: "claude-sonnet-5-5" }), cost("s1", "spike", 0.1, { model: "claude-haiku-4-5" }),
    cost("r1", "research", 0.1, { model: "gpt-unknown" }), cost("d1", "drafter", 0.1, { model: "claude-opus-5" })];
  assert.deepEqual(planningBreakdown(healthy({ agentCosts: rows }), { tierTable: TIERS }).tierFit,
    [{ role: "checker", agentId: "c1", model: "claude-opus-5" }]);
  assert.deepEqual(planningBreakdown(healthy({ agentCosts: rows })).tierFit, [], "no tier table ranks nothing");
});

test("P9: checker rounds count round tags, and each untagged checker as its own round", () => {
  const p9 = (costs) => row(planningBreakdown(healthy({ events: [], agentCosts: costs })), "P9");
  const pair = (id, round) => cost(id, "checker", 0.1, { round });
  assert.deepEqual(p9([pair("c1", 1), pair("c2", 1), pair("c3", 1)]).value, { gateFails: 0, checkerRounds: 1 });
  assert.equal(p9([pair("c1", 1), pair("c2", 1), pair("c3", 1)]).status, "pass");
  assert.deepEqual(p9([pair("c1", 1), pair("c2", 2)]).value, { gateFails: 0, checkerRounds: 2 });
  assert.deepEqual(p9([pair("c1", 1), cost("c9", "checker", 0.1)]).value, { gateFails: 0, checkerRounds: 2 });
});
