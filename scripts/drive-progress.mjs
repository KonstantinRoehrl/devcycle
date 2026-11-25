// .devcycle/drive-progress.json, the drive band's one data file (docs/decisions/README.md, 2026-10-25):
// the driver writes it from scripts/wave-setup.mjs's planProgress before every log line and on a
// heartbeat, the beat adding each in-flight dispatch's health from scripts/dispatch-health.mjs, and
// hooks/devcycle-mod.mjs reads nothing else.
// Schema v 2: the driver session, the driven session and each running dispatch are their own tiers (docs/decisions/README.md).
import { rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./atomic-write.mjs";
import { windowFor } from "./depth-bands.mjs";
import { now } from "./stamp.mjs";
import { isNoVerdict, nextReviewRound } from "./task-ledger.mjs";

export const PROGRESS_REL = ".devcycle/drive-progress.json";
const INTAKE_BOUNCE = "rejected (intake bounce)";

// A task's step on the band, from its wave-setup.mjs position. Every position missing here waits on
// a person: a decision, a block, a retry cap, a sweep.
const STEPS = {
  "not-dispatched": "pending", dispatched: "implementing", "missing-report": "implementing",
  "report-received": "reviewing", "review-round": "reviewing", "missing-findings": "reviewing",
  "dead-implementer": "implementing", "dead-reviewer": "reviewing",
  rejected: "fixing", "intake-bounce": "fixing", accepted: "committing", deferred: "committing", committed: "committed",
};

// An implementer dispatched after a rejection or an intake bounce is a fix pass: it writes a fresh
// `dispatched` line, so the rejection is only visible in the task's own ledger lines.
const IMPLEMENTER_POSITIONS = new Set(["dispatched", "missing-report", "dead-implementer"]);

// The round of the task's latest review-round line, read as nextReviewRound reads it; 0 before any.
function roundOf(entries) {
  const last = entries.findLastIndex((e) => e.event === "review-round");
  return last < 0 ? 0 : nextReviewRound(entries.slice(0, last + 1));
}

const rejectionsOf = (entries) => entries.filter((e) =>
  (e.event === "review-verdict" && e.outcome.startsWith("rejected") && !isNoVerdict(e.outcome)) ||
  e.outcome.startsWith(INTAKE_BOUNCE)).length;

// The band's routing label for a ledger `outcome=` text. Producers: scripts/model-pool.mjs (pinned,
// pooled, ceiling), scripts/task-intake.mjs (the reviewer's auto forms) and the coordinator's
// implementer decision, passed verbatim through task-dispatch.mjs --model-decision. Released plugins up
// to 0.34.0 write the prefix twice ("model model fast…"), so every leading "model " is stripped, and any
// form that is not a routing decision reads as null: the band then draws no routing.
const ROUTING_FORMS = [
  [/^fast(?::\S+)? \(auto\b.*\)$/, () => "fast"],
  [/^session \(auto: escalated on (.+)\)$/, (m) => `esc ${m[1]}`],
  [/^session \(auto(?:: no file list)?\)$/, () => "session"],
  [/^session \(ceiling: .*\)$/, () => "ceiling"],
  [/^\S+ \(pinned\)$/, () => "pinned"],
  [/^\S+ \(pinned, clamped from \S+\)$/, () => "pinned, clamped"],
  [/^\S+ \(pooled: rung (\d+\/\d+)\)$/, (m) => `pool ${m[1]}`],
  [/^\S+ \(pooled: rung (\d+\/\d+), clamped from \S+\)$/, (m) => `pool ${m[1]} + clamped`],
];

export function routingLabel(outcome) {
  if (typeof outcome !== "string") return null;
  const decision = outcome.replace(/^(?:model )+/, "");
  for (const [form, label] of ROUTING_FORMS) {
    const m = form.exec(decision);
    if (m) return label(m);
  }
  return null;
}

// The ledger event that records each role's routing decision.
const ROUTING_EVENT = { implementer: "dispatched", reviewer: "review-round" };
const LIVE_DISPATCH = new Set(["running", "quiet"]);
// The role whose dispatch a step is: the beat's health lags the ledger by up to one heartbeat, so a task
// that moved on keeps the last beat's role until the step, not the health, says the dispatch has ended.
// hooks/devcycle-mod.mjs repeats this map, as it may import nothing that imports a node: module.
const STEP_ROLE = { implementing: "implementer", fixing: "implementer", reviewing: "reviewer" };

// One tier's fields with every empty one dropped, an effort of "default" counted as empty, and the
// model's window added once `tokens` says how deep it is: the one home of the window rule for all tiers.
function tier({ model, effort, tokens, ...rest }) {
  const fields = { ...rest, model, effort: effort === "default" ? null : effort, tokens };
  const known = typeof tokens === "number" && typeof model === "string" ? windowFor(model) : null;
  if (known) {
    fields.window = known.window;
    if (known.windowAssumed) fields.windowAssumed = true;
  }
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value != null));
}

export function buildProgress({ run, plan, health = null, tiers = null }) {
  const { state, session, model, effort, startedAt, waitUntil, waitWhat, stopDetail, outcome } = run;
  const driver = tiers?.driver ? tier(tiers.driver) : tier({ model, effort, watcher: false });
  const driven = tiers?.session
    ? tier({ n: session, startedAt: tiers.session.startedAt, model: tiers.session.model ?? model,
      effort: tiers.session.effort ?? effort, tokens: tiers.session.tokens })
    : null;
  const head = { v: 2, state, startedAt, updatedAt: now(), waitUntil, waitWhat, stopDetail, outcome, driver, session: driven };
  if (!plan) return { ...head, currentWave: null, committed: 0, total: 0, waves: [] };
  const dispatchOf = (live, entries) => {
    const event = ROUTING_EVENT[live.role];
    const routing = event ? routingLabel(entries.findLast((e) => e.event === event)?.outcome) : null;
    const dispatch = tier({ role: live.role, model: live.model, effort: live.effort, tokens: live.tokens, routing });
    return Object.keys(dispatch).length > 0 ? dispatch : null;
  };
  const taskOf = (task) => {
    const entries = plan.entries.get(task) ?? [];
    const position = plan.positions.get(task)?.position;
    const rejections = rejectionsOf(entries);
    const step = rejections > 0 && IMPLEMENTER_POSITIONS.has(position) ? STEPS.rejected : STEPS[position] ?? "needs-user";
    const live = health?.get(task);
    const dispatch = live && LIVE_DISPATCH.has(live.state) && STEP_ROLE[step] === live.role ? dispatchOf(live, entries) : null;
    return {
      task, step, round: roundOf(entries), rejections,
      ...(live ? { health: { state: live.state, elapsedMs: live.elapsedMs, toolUses: live.toolUses, sinceActivityMs: live.sinceActivityMs } } : {}),
      ...(dispatch ? { dispatch } : {}),
    };
  };
  const { overview } = plan;
  return {
    ...head, currentWave: overview.nextWave, committed: overview.committed, total: overview.tasks,
    waves: overview.perWave.map(({ wave, tasks, committed }) => ({ wave, committed, tasks: tasks.map(taskOf) })),
  };
}

export function writeProgress(root, progress) {
  atomicWrite(join(root, PROGRESS_REL), JSON.stringify(progress) + "\n");
}

export function removeProgress(root) {
  rmSync(join(root, PROGRESS_REL), { force: true });
}
