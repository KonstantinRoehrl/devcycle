// .devcycle/drive-progress.json, the drive band's one data file (docs/decisions/README.md, 2026-10-25):
// the driver writes it from scripts/wave-setup.mjs's planProgress before every log line and on a
// heartbeat, and hooks/devcycle-mod.mjs reads nothing else. Schema v 1.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./atomic-write.mjs";
import { now } from "./stamp.mjs";
import { MISSING_FINDINGS, nextReviewRound } from "./task-ledger.mjs";

export const PROGRESS_REL = ".devcycle/drive-progress.json";
const INTAKE_BOUNCE = "rejected (intake bounce)";

// A task's step on the band, from its wave-setup.mjs position. Every position missing here waits on
// a person: a decision, a block, a retry cap, a sweep.
const STEPS = {
  "not-dispatched": "pending", dispatched: "implementing", "missing-report": "implementing",
  "report-received": "reviewing", "review-round": "reviewing", "missing-findings": "reviewing",
  rejected: "fixing", "intake-bounce": "fixing", accepted: "committing", deferred: "committing", committed: "committed",
};

// An implementer dispatched after a rejection or an intake bounce is a fix pass: it writes a fresh
// `dispatched` line, so the rejection is only visible in the task's own ledger lines.
const IMPLEMENTER_POSITIONS = new Set(["dispatched", "missing-report"]);

// The round of the task's latest review-round line, read as nextReviewRound reads it; 0 before any.
function roundOf(entries) {
  const last = entries.findLastIndex((e) => e.event === "review-round");
  return last < 0 ? 0 : nextReviewRound(entries.slice(0, last + 1));
}

const rejectionsOf = (entries) => entries.filter((e) =>
  (e.event === "review-verdict" && e.outcome.startsWith("rejected") && !e.outcome.startsWith(MISSING_FINDINGS)) ||
  e.outcome.startsWith(INTAKE_BOUNCE)).length;

export function buildProgress({ run, plan }) {
  const { state, session, model, effort, startedAt, waitUntil, waitWhat, stopDetail, outcome } = run;
  const head = { v: 1, state, session, model, effort, startedAt, updatedAt: now(), waitUntil, waitWhat, stopDetail, outcome };
  if (!plan) return { ...head, currentWave: null, committed: 0, total: 0, waves: [] };
  const taskOf = (task) => {
    const entries = plan.entries.get(task) ?? [];
    const position = plan.positions.get(task)?.position;
    const rejections = rejectionsOf(entries);
    const step = rejections > 0 && IMPLEMENTER_POSITIONS.has(position) ? STEPS.rejected : STEPS[position] ?? "needs-user";
    return { task, step, round: roundOf(entries), rejections };
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
