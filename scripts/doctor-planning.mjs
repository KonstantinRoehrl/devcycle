// The planning-cost breakdown doctor prints per run: where the planning dollars went by role, and
// the P1-P12 rubric of spec §10 scored against its bars. Pure: it reads the rows doctor.mjs already
// loaded and returns one object, never a file, a clock or the environment.
import { usd, markdownTable } from "./doctor-format.mjs";

/**
 * One run's planning rows and dollars, joined across the run's sessions by planningBreakdowns.
 * A figure doctor could not establish is null, never 0.
 * @typedef {object} PlanningRun
 * @property {object[]} agentCosts     `agent-cost` rows of every stage; only stage "planning" is read.
 * @property {object|null} planStats   the run's `plan-stats` row (the last one written), or null.
 * @property {object[]} events         the run's journal events: explicit rows plus the derived ones.
 * @property {object[]} agentDepths    `agent-depth` rows of every stage; only stage "planning" is read.
 * @property {number|null} planningUsd planning-stage dollars off the transcripts, subagent turns included.
 * @property {number|null} executionUsd execution-stage dollars off the transcripts.
 * @property {number|null} planningMinutes minutes the run's planning stage windows span.
 * @property {number|null} blocked     dispatches whose outcome is "blocked".
 * @property {number|null} retried     dispatches with a retryIndex above 0.
 */

/**
 * @typedef {object} PlanningBreakdown
 * @property {Record<string, number|null>} byRole planning subagent dollars per role (spike, research,
 *   drafter, checker, repair), `unrolled` for rows with no role, and `coordinator`: planning-stage
 *   dollars minus planning subagent dollars.
 * @property {{id: string, measure: string, value: *, bar: string, status: "pass"|"fail"|"n/a", reason?: string}[]} rubric
 * @property {number} planDefects rows attributing culprit `plan-defect`
 * @property {{blocked: number|null, rejected: number, retried: number|null}} raw execution counts
 * @property {Record<string, number>} gateLegs failing plan-check leg to the number of planning gate fails naming it
 * @property {{agentId: string|null, cause: string}[]} sensorGaps `no-cost-row`, `no-role`, or `null-usd:<measurement>`
 */

const ROLES = ["spike", "research", "drafter", "checker", "repair"];

const inPlanning = (rows) => (rows ?? []).filter((r) => r.stage === "planning");

// Null as soon as one row is unpriced: a partial sum would read as the whole figure.
const sumUsd = (rows) => (rows.some((r) => r.usd === null || r.usd === undefined) ? null : rows.reduce((n, r) => n + r.usd, 0));

// Nearest-rank percentile over integer-valued inputs, so the rank never rides a float product.
const percentile95 = (values) => [...values].sort((a, b) => a - b)[Math.ceil((values.length * 95) / 100) - 1];

const ratio = (num, den) => (num === null || den === null || den === 0 ? null : num / den);

function row(id, measure, bar, value, pass, reason) {
  if (reason) return { id, measure, value, bar, status: "n/a", reason };
  return { id, measure, value, bar, status: pass ? "pass" : "fail" };
}

/**
 * @param {PlanningRun} run
 * @returns {PlanningBreakdown}
 */
export function planningBreakdown(run) {
  const costs = inPlanning(run.agentCosts);
  const depths = inPlanning(run.agentDepths);
  const stats = run.planStats ?? null;
  const events = run.events ?? [];
  const tasks = stats && stats.tasks > 0 ? stats.tasks : null;

  // Without cost rows the subagent dollars are known only when plan-stats says there were none.
  const subagentKnown = costs.length > 0 || stats?.subagentUsd === 0;
  const subagentUsd = costs.length > 0 ? sumUsd(costs) : stats?.subagentUsd ?? null;
  const planningUsd = run.planningUsd ?? null;
  const byRole = Object.fromEntries(ROLES.map((r) => [r, subagentKnown ? sumUsd(costs.filter((c) => c.role === r)) : null]));
  byRole.unrolled = subagentKnown ? sumUsd(costs.filter((c) => !c.role)) : null;
  byRole.coordinator = planningUsd !== null && subagentUsd !== null ? planningUsd - subagentUsd : null;

  const costIds = (pick) => new Set(costs.filter(pick).map((c) => c.agentId).filter(Boolean));
  const rolledIds = costIds((c) => c.role);
  const allCostIds = costIds(() => true);
  // A depth row without an agentId cannot be matched to anything, so each one stands alone.
  const depthKey = (d, i) => d.agentId ?? `depth-row-${i}`;
  const finalDepth = new Map();
  depths.forEach((d, i) => finalDepth.set(depthKey(d, i), d));

  const sensorGaps = [];
  for (const d of finalDepth.values())
    if (!d.agentId || !allCostIds.has(d.agentId)) sensorGaps.push({ agentId: d.agentId ?? null, cause: "no-cost-row" });
  for (const id of new Set(costs.map((c) => c.agentId)))
    if (!rolledIds.has(id)) sensorGaps.push({ agentId: id ?? null, cause: "no-role" });
  // A row the sensor could not price names why in its `measurement`; one without it adds no gap.
  const unpricedIds = new Set();
  for (const c of costs) {
    if (c.usd !== null || !c.measurement || unpricedIds.has(c.agentId)) continue;
    unpricedIds.add(c.agentId);
    sensorGaps.push({ agentId: c.agentId ?? null, cause: `null-usd:${c.measurement}` });
  }

  const planningGateFails = events.filter((e) => e.event === "gate-ran" && e.stage === "planning" && e.result === "fail");
  const gateLegs = {};
  for (const e of planningGateFails)
    for (const leg of (e.legs ?? "").split(",").filter(Boolean)) gateLegs[leg] = (gateLegs[leg] ?? 0) + 1;

  const planDefects = events.filter((e) => e.culprit === "plan-defect").length;
  const dispatches = finalDepth.size;
  const checkerAgents = new Set(costs.filter((c) => c.role === "checker").map((c) => c.agentId ?? c));
  const checkerKnown = costs.length > 0 || stats?.strategy === "inline";

  const explicitByAgent = new Map();
  for (const c of costs) {
    const key = c.agentId ?? c;
    explicitByAgent.set(key, (explicitByAgent.get(key) ?? true) && c.explicitModel === true);
  }
  const matched = [...finalDepth.values()].filter((d) => d.agentId && rolledIds.has(d.agentId)).length;

  const noStats = "no plan-stats row (planning has not reached its handoff)";
  const p1 = ratio(planningUsd, tasks);
  const p2 = ratio(planningUsd, run.executionUsd ?? null);
  const p3 = dispatches > 0 ? ratio(dispatches, tasks) : null;
  const p4 = dispatches > 0 ? percentile95([...finalDepth.values()].map((d) => d.tokens)) : null;
  const p7 = explicitByAgent.size > 0 ? [...explicitByAgent.values()].filter(Boolean).length / explicitByAgent.size : null;
  const p8 = stats && stats.specBytes > 0 ? { bytesRatio: stats.planBytes / stats.specBytes, fenceShare: stats.fenceShare } : null;
  const p9 = checkerKnown ? { gateFails: planningGateFails.length, checkerRounds: checkerAgents.size } : null;
  const p11 = ratio(run.planningMinutes ?? null, tasks);
  const p12 = dispatches > 0 ? { share: matched / dispatches, gaps: sensorGaps.length } : null;

  const rubric = [
    row("P1", "planning $ / task", "<= 2.0", p1, p1 <= 2, p1 === null && (stats ? "planning-stage dollars unknown" : noStats)),
    row("P2", "planning $ / execution $", "<= 1.0", p2, p2 <= 1, p2 === null && "planning or execution dollars unknown, or no execution spend yet"),
    row("P3", "planning dispatches / task", "<= 0.5", p3, p3 <= 0.5, p3 === null && (stats ? "no planning agent-depth rows" : noStats)),
    row("P4", "p95 final depth of planning dispatches (tokens)", "<= 150000", p4, p4 <= 150000, p4 === null && "no planning agent-depth rows"),
    row("P5", "coordinator depth at handoff", "<= 15%", null, false, "not recorded until Phase 3"),
    row("P6", "shared-context duplication", "n/a until Phase 1", null, false, "not measured until Phase 1"),
    row("P7", "planning dispatches with explicitModel", "100%", p7, p7 === 1, p7 === null && "no planning agent-cost rows"),
    row("P8", "plan/spec bytes and fenceShare", "plan/spec <= 5 and fenceShare <= 0.30", p8,
      p8 && p8.bytesRatio <= 5 && p8.fenceShare <= 0.3, p8 === null && (stats ? "spec is empty" : noStats)),
    row("P9", "planning gate-ran fails and checker rounds", "fails <= 2 and checker rounds <= 1", p9,
      p9 && p9.gateFails <= 2 && p9.checkerRounds <= 1, p9 === null && "no planning agent-cost rows to count checker rounds from"),
    row("P10", "plan-defect count", "baseline-relative", planDefects, false, "the bar is relative to a baseline, so the count is not judged"),
    row("P11", "planning minutes / task", "<= 3", p11, p11 <= 3, p11 === null && "planning stage timestamps or task count unknown"),
    row("P12", "dispatches with a cost row and a role, and sensor gaps", "100% and 0 gaps", p12,
      p12 && p12.share === 1 && p12.gaps === 0, p12 === null && "no planning agent-depth rows"),
  ];

  return {
    byRole,
    rubric,
    planDefects,
    // blocked and retried come off the run's dispatch rows, which doctor reads only from a run record.
    raw: { blocked: run.blocked ?? null, rejected: events.filter((e) => e.event === "review-reject").length, retried: run.retried ?? null },
    gateLegs,
    sensorGaps,
  };
}

const sumKnown = (values) => (values.some((v) => v !== null && v !== undefined) ? values.reduce((n, v) => n + (v ?? 0), 0) : null);

/**
 * Joins the summaries of one run's sessions into a PlanningRun, one per run that has a planning stage.
 * Planning and execution run in different sessions, so no single summary holds both.
 * @param {object[]} summaries summarizeSession results carrying `planningRows` and `costByStage`
 * @returns {{runId: string, breakdown: PlanningBreakdown}[]}
 */
export function planningBreakdowns(summaries) {
  const byRun = new Map();
  for (const s of summaries)
    if (s.runId && s.planningRows) byRun.set(s.runId, [...(byRun.get(s.runId) ?? []), s]);
  const out = [];
  for (const [runId, members] of byRun) {
    if (!members.some((m) => m.planningRows.hasPlanning)) continue;
    const minutes = sumKnown(members.map((m) => m.planningRows.planningMs));
    out.push({ runId, breakdown: planningBreakdown({
      agentCosts: members.flatMap((m) => m.planningRows.agentCosts),
      planStats: members.flatMap((m) => m.planningRows.planStats).at(-1) ?? null,
      events: members.flatMap((m) => m.planningRows.events),
      agentDepths: members.flatMap((m) => m.agentDepths ?? []),
      planningUsd: sumKnown(members.map((m) => m.costByStage?.planning)),
      executionUsd: sumKnown(members.map((m) => m.costByStage?.execution)),
      planningMinutes: minutes === null || minutes === 0 ? null : minutes / 60000,
      blocked: sumKnown(members.map((m) => m.planningRows.blocked)),
      retried: sumKnown(members.map((m) => m.planningRows.retried)),
    }) });
  }
  return out.sort((a, b) => a.runId.localeCompare(b.runId));
}

const valueText = (v) => (v !== null && typeof v === "object"
  ? Object.entries(v).map(([k, n]) => `${k} ${+n.toFixed(3)}`).join(", ")
  : typeof v === "number" ? +v.toFixed(3) : v);
const countText = (n) => (n === null ? "unknown" : n);

/** The report lines under the section heading, one block per run. */
export function planningBreakdownLines(entries) {
  const L = [];
  for (const { runId, breakdown: b } of entries) {
    L.push(`**Run ${runId.slice(0, 8)}**`, "");
    L.push(...markdownTable(["Role", "Cost (observed)"],
      Object.entries(b.byRole).map(([role, dollars]) => [role, dollars === null ? null : usd(dollars)]), "no roles"), "");
    L.push(...markdownTable(["Id", "Measure", "Value", "Bar", "Status", "Note"],
      b.rubric.map((r) => [r.id, r.measure, valueText(r.value), r.bar, r.status, r.reason]), "no rubric"), "");
    const legs = Object.entries(b.gateLegs).map(([leg, n]) => `${leg} ${n}`).join(", ");
    L.push(`Failing plan-check legs: ${legs || "none"}.`);
    L.push(`Plan defects: ${b.planDefects}. Execution (observed): blocked ${countText(b.raw.blocked)}, ` +
      `rejected ${b.raw.rejected}, retried ${countText(b.raw.retried)}.`);
    L.push(`Sensor gaps: ${b.sensorGaps.map((g) => `${g.agentId ?? "(no agentId)"} (${g.cause})`).join(", ") || "none"}.`, "");
  }
  return L;
}
