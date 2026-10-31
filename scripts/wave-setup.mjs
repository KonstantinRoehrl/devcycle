#!/usr/bin/env node
// /devcycle:continue's execution resume path in one call (spec 4.A.3): the ownership check and
// resume-check, the knob comparison, the branch verdict, the depth probe, the plan's overview, the
// ledger slot and the drive action, then every current-wave task's position per references/resume.md
// § Resuming a wave's per-task position with its brief inputs until it is committed, and the next
// implementer dispatches — one JSON object on stdout. It never appends the run's session row: the
// hooks module (hooks/devcycle-mod.mjs) joins a session to its run only when it sees that append as a
// main-loop Bash call of its own, so commands/continue.md keeps it so.
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { isMain } from "./is-main.mjs";
import { field } from "./md-field.mjs";
import { describe } from "./find-state-files.mjs";
import { checkState } from "./resume-check.mjs";
import { parseHandoff } from "./handoff-mark.mjs";
import { compareKnobs, parseRecordedLine, resolveKnobs } from "./resolve-knobs.mjs";
import { resolveDepth } from "./depth-probe.mjs";
import { TEST_FILE_SUFFIXES, fieldValue, gateCommand, parseDispatchMap, taskBlocks, taskFileMap } from "./task-files.mjs";
import {
  isNoVerdict, ledgerPlan, nextReviewRound, noVerdictReason, parseLedgerLine, retryCount, runTaskScript, taskFlags, workTreeRoot,
} from "./task-ledger.mjs";
import { ledgerSlotState } from "./ledger-slot.mjs";
import { pendingReviewLoop, reviewLoopId } from "./review-loop.mjs";
import { driveTokenHash, readLiveDriveLock } from "./drive-lock.mjs";
import { classifyDrive } from "./drive-result.mjs";
import { isProtectedBranch } from "./branch-names.mjs";
import { DISPATCH_ENDED, deathRoute, endedRole } from "./dispatch-health.mjs";

const NONE = new Set(["none", "<tbd>", ""]);
// A recorded field's value without its annotation (`feat/x (cut from dev at abc1234)`), or null.
const known = (raw) => {
  const value = (raw ?? "").split(/\s+/)[0];
  return NONE.has(value) ? null : value;
};

// The loops their own text leaves uncapped get two retries per task (spec 4.A.2); the third such
// outcome is the user's decision.
export const RETRY_CAP = 2;
const CAPPED_OUTCOMES = ["rejected (intake bounce)", "rejected (missing report file)"];
const SWEEP_TOKEN = /\bsweep\b|\bapplied-none\b|\bdirty-targets\b/;
const IMPLEMENTER_NEXT = new Set(["dispatch-implementer", "redispatch-implementer", "fix"]);
// The stops continue's own gates compute and answer on the very call that reads the driver's result,
// so a driver that stopped on one needs no question of its own.
const SETTLED_REASONS = new Set(["knob-drift", "foreign-state", "resume-check", "branch", "depth-at-start", "no-driver", "not-opted-in"]);

// The position of an outcome a retry cap bounds, or null for any other outcome.
function cappedPosition(outcome, retries) {
  // Both no-verdict outcomes — an absent findings file and an unparseable one — spend one cap.
  const capped = isNoVerdict(outcome) ? isNoVerdict : CAPPED_OUTCOMES.find((prefix) => outcome.startsWith(prefix));
  if (!capped) return null;
  if (retries(capped) > RETRY_CAP) return { position: "retry-cap", next: "needs-user" };
  if (capped === isNoVerdict) return { position: "missing-findings", next: "redispatch-reviewer", reason: noVerdictReason(outcome) };
  if (capped === "rejected (missing report file)") return { position: "missing-report", next: "redispatch-implementer" };
  return { position: "intake-bounce", next: "fix" };
}

// references/resume.md § Resuming a wave's per-task position, most specific row first. `lines` are
// one task's parsed ledger lines in file order; `retries(match)` counts that task's lines whose
// outcome starts with a prefix or satisfies a predicate.
export function taskPosition(lines, { pendingLoop = null, retries = () => 0 } = {}) {
  if (pendingLoop) return { position: "exhausted-unresolved", next: "needs-user" };
  const last = lines.at(-1);
  if (!last) return { position: "not-dispatched", next: "dispatch-implementer" };
  const { event, outcome } = last;
  if (event === "committed") return { position: "committed", next: "done" };
  // references/sweep-execution.md logs a dirty target as a user-decision line before anyone answers it.
  if (outcome.startsWith("sweep dirty-targets")) return { position: "sweep-decision", next: "needs-user" };
  if (event === "user-decision") return { position: "user-decision", next: "follow-decision" };
  if (event === "dispatched" && outcome.startsWith("sweep")) return { position: "sweep-dispatched", next: "rerun-sweep" };
  if (SWEEP_TOKEN.test(outcome)) return { position: "sweep-decision", next: "needs-user" };
  if (event === DISPATCH_ENDED) {
    const role = endedRole(outcome);
    const next = deathRoute(lines, role);
    return next === "needs-user" ? { position: "death-cap", next } : { position: `dead-${role}`, next };
  }
  const cappedAt = cappedPosition(outcome, retries);
  if (cappedAt) return cappedAt;
  if (event === "report-received" && outcome.startsWith("blocked")) return { position: "blocked", next: "needs-user" };
  // A ledger from before the per-commit proof can end on a deferral. task-commit now proves the commit
  // in its own worktree, where a sibling's edit cannot reach, so the task is simply committed again.
  if (event === "review-verdict" && outcome.startsWith("deferred")) return { position: "deferred", next: "commit" };
  if (event === "review-verdict" && outcome.startsWith("accepted")) return { position: "accepted", next: "commit" };
  if (event === "review-verdict" && outcome.startsWith("rejected")) return { position: "rejected", next: "fix" };
  if (event === "review-round") return { position: "review-round", next: "redispatch-reviewer" };
  if (event === "report-received") return { position: "report-received", next: "dispatch-reviewer" };
  if (event === "dispatched") return { position: "dispatched", next: "redispatch-implementer" };
  return { position: "unknown", next: "needs-user" };
}

// This cycle's ledger lines. A stale slot, or a ledger whose `Plan:` preamble names another plan, is a
// previous cycle's (references/resume.md § The state file): none of its lines is this cycle's.
function readLedger(ledgerPath, plan, slot) {
  if (!plan || slot === "stale" || ledgerPlan(ledgerPath) !== plan) return [];
  return readFileSync(ledgerPath, "utf8").split("\n").map(parseLedgerLine).filter(Boolean);
}

// The declaration forms playbooks/planning-waves.md allows — `none (…)`, `Task 2 (…)`, `Tasks 1+4
// committed`: the numbers before any parenthesis are the tasks that must be committed first.
const dependenciesOf = (block) => [...(fieldValue(block, "Dependencies") ?? "").split("(")[0].matchAll(/\d+/g)].map((m) => m[0]);

// The task's own test run as its steps spell it: the last code span in a step that names one of its
// Test files and carries arguments. null when no step names one; the coordinator derives it then.
function testCommand(block, files) {
  const tests = files.filter((f) => TEST_FILE_SUFFIXES.some((suffix) => f.endsWith(suffix)));
  let command = null;
  for (const line of block.split("\n").filter((l) => /^\s*- \[[ x]\] /.test(l)))
    for (const [, span] of line.matchAll(/`([^`]+)`/g))
      if (/\s/.test(span.trim()) && tests.some((t) => span.includes(t))) command = span.trim();
  return command;
}

function depthNow(env, cwd) {
  try {
    const r = resolveDepth(env, cwd, {});
    return { band: r.band, tokens: r.depth };
  } catch (err) {
    return { band: "unknown", tokens: null, reason: err.message };
  }
}

function branchVerdict(root, recordedRaw) {
  const recorded = known(recordedRaw);
  const head = spawnSync("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" });
  const current = head.status === 0 ? head.stdout.trim() : null;
  // A recorded default or integration branch means the topic branch was never cut (references/resume.md
  // § Settle the branch first): branch discipline applies.
  const verdict = !recorded || isProtectedBranch(root, recorded) ? "integration" : current === recorded ? "ok" : "switch-needed";
  return { recorded, current, verdict };
}

const sameValues = (a, b) => {
  const x = parseRecordedLine(a);
  const y = parseRecordedLine(b);
  return [...new Set([...Object.keys(x), ...Object.keys(y)])].every((key) => x[key] === y[key]);
};

const realPath = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

// The fresh live knobs, resolved from the --knobs line; a missing or unknown value is the knob's fallback.
const liveKnobs = (knobsLine) => resolveKnobs(knobsLine ? parseRecordedLine(knobsLine) : {}).knobs;

// The reported drive status, and the live lock's token hash, which is never reported.
function driveStatus(root, statePath, stateText, lines, knobsLine) {
  const row = field(stateText, "drive") ?? "";
  const model = row.match(/\bmodel=(\S+)/)?.[1];
  // A row recorded before the knob existed carries no via=, and every such row was an answer.
  const via = row.match(/\bvia=(\S+)/)?.[1] ?? (row ? "answer" : undefined);
  const live = readLiveDriveLock(root);
  const holder = live && realPath(resolve(root, live.state ?? "")) === realPath(statePath) ? live : null;
  const optInLogged = lines.some((l) => l.task === "drive" && l.event === "user-decision");
  const lock = holder ? { pid: holder.pid, log: holder.log } : null;
  const { executionMode: mode, driveWatch: watch, drivePlugins: plugins } = liveKnobs(knobsLine);
  return {
    drive: { opted: /^auto\b/.test(row), ...(model ? { model } : {}), ...(via ? { via } : {}), lock, optInLogged, row: row.match(/^(auto|manual)\b/)?.[1] ?? null,
      mode, watch, plugins },
    tokenHash: holder?.tokenHash ?? null,
  };
}

// A recorded row decides whether the waves run unattended or are walked; with no row the live knob
// decides: `manual` writes a `manual` row, `unattended` writes an `auto` row and starts the driver
// (docs/decisions/README.md, 2026-10-29), `ask` asks. Under the unattended knob a start asks no
// confirm, and neither does a stop this session's own gates settled; a stop that waits on a person
// is always asked. A stop on the task whose review loop is pending is that decision: the gate
// carries it, so it is asked once.
function driveAction({ row, mode }, driver, pending) {
  const manual = row === "manual" || (row === null && mode === "manual");
  if (manual) return { action: "manual", writeRow: row === null ? "manual" : null, confirm: null, gate: null };
  const knob = mode === "unattended";
  if ((row === "auto" || knob) && driver.next === "answer-gate") {
    const { reason, detail, task } = driver;
    const settled = SETTLED_REASONS.has(reason);
    const pendingDecision = task !== null && task === pending?.task ? pending : null;
    const writeRow = settled && knob && row === null ? "auto" : null;
    return { action: "gate", writeRow, confirm: settled ? !knob : null, gate: { reason, detail, task, settled, pendingDecision } };
  }
  if (row === null && !knob) return { action: "ask", writeRow: null, confirm: null, gate: null };
  return { action: "start", writeRow: row === null ? "auto" : null, confirm: !knob, gate: null };
}

function readPlan(root, plan) {
  try {
    return plan ? readFileSync(isAbsolute(plan) ? plan : join(root, plan), "utf8") : "";
  } catch {
    // A plan that vanished reads as no waves; resume-check is what names it.
    return "";
  }
}

// Every Dispatch Map task's position, in Map wave order.
function mapPositions(root, planText, lines, ledgerPath) {
  const waves = [...(parseDispatchMap(planText) ?? new Map())].sort(([a], [b]) => a - b);
  const byTask = Map.groupBy(lines, (l) => l.task);
  const positions = new Map();
  for (const [, nums] of waves)
    for (const num of nums) {
      const task = String(num);
      const own = byTask.get(task) ?? [];
      positions.set(task, taskPosition(own, { pendingLoop: pendingReviewLoop(root, task, own), retries: (match) => retryCount(ledgerPath, task, match) }));
    }
  return { waves, positions };
}

function overviewOf({ waves, positions }) {
  const perWave = waves.map(([wave, nums]) => {
    const tasks = nums.map(String);
    return { wave, tasks, committed: tasks.filter((task) => positions.get(task).position === "committed").length };
  });
  return {
    waves: perWave.length, tasks: perWave.flatMap((w) => w.tasks).length, committed: perWave.reduce((n, w) => n + w.committed, 0),
    nextWave: perWave.find((w) => w.committed < w.tasks.length)?.wave ?? null, perWave,
  };
}

// The drive band's view of the plan (scripts/drive-progress.mjs): the overview and every Dispatch Map
// task's position with its ledger lines, read as waveSetup reads them. null when the state names no
// plan with a Dispatch Map, or the ledger slot is a previous cycle's.
export function planProgress({ root, statePath, ledgerPath = null }) {
  const stateText = readFileSync(resolve(statePath), "utf8");
  const plan = known(field(stateText, "plan"));
  const slot = ledgerSlotState({ root, plan, run: known(field(stateText, "run")) });
  const planText = readPlan(root, plan);
  if (!plan || slot === "stale" || !parseDispatchMap(planText)) return null;
  const ledger = ledgerPath ? resolve(ledgerPath) : join(root, ".devcycle", "ledger.md");
  const lines = readLedger(ledger, plan, slot);
  const map = mapPositions(root, planText, lines, ledger);
  const byTask = Map.groupBy(lines, (l) => l.task);
  return { overview: overviewOf(map), positions: map.positions, entries: new Map([...map.positions.keys()].map((task) => [task, byTask.get(task) ?? []])) };
}

function wavePosition(root, planText, { waves, positions }, lines) {
  const blocks = new Map(taskBlocks(planText).map(({ num, text }) => [String(num), text]));
  const files = taskFileMap(planText);
  const byTask = Map.groupBy(lines, (l) => l.task);
  const done =new Set([...positions].filter(([, p]) => p.position === "committed").map(([task]) => task));
  const current = waves.find(([, nums]) => nums.some((num) => !done.has(String(num))));
  if (!current) return { wave: null, tasks: [], dispatchable: [], pendingDecision: null };
  const [wave, nums] = current;
  const ready = (task) => dependenciesOf(blocks.get(task) ?? "").every((dep) => done.has(dep));
  const filesOf = (task) => [...(files.get(Number(task)) ?? [])];
  // What playbooks/executing-waves.md's per-task steps take from the plan. Every task still to commit
  // carries them, so one resumed at a reviewer dispatch, the commit or a re-gate has its evidence class,
  // test command and gate command too, with the round its next review takes.
  const briefInputs = (task) => {
    const block = blocks.get(task) ?? "";
    const taskFiles = filesOf(task);
    const evidence = fieldValue(block, "Evidence");
    return { files: taskFiles, evidence, evidenceClass: evidence?.split(/\s+/)[0] ?? null, testCmd: testCommand(block, taskFiles),
      gateCmd: gateCommand(planText, Number(task))?.cmd ?? null };
  };
  const withInputs = (task, position) => position.next === "done" ? { task, ...position }
    : { task, ...position, ...briefInputs(task), reviewRound: nextReviewRound(byTask.get(task) ?? []) };
  // playbooks/executing-waves.md § Wave formation runs by readiness, never by written order: a later
  // Map wave's task whose dependencies are committed joins the current one's.
  const early = waves.filter(([w]) => w > wave).flatMap(([, n]) => n.map(String)).filter((task) => !done.has(task) && ready(task));
  const tasks = [...nums.map(String), ...early].map((task) => withInputs(task, positions.get(task)));
  const rowOf = new Map(waves.flatMap(([w, n]) => n.map((num) => [String(num), { wave: w, tasks: n }])));
  // ...and never beside a task whose files overlap its own: an undispatched task waits while a task
  // in flight, or one picked before it, holds one of its files.
  const held = new Set(tasks.filter((t) => t.position !== "not-dispatched" && t.position !== "committed").flatMap((t) => filesOf(t.task)));
  const dispatchable = [];
  for (const { task, position, next } of tasks) {
    if (!IMPLEMENTER_NEXT.has(next) || !ready(task)) continue;
    const taskFiles = filesOf(task);
    if (position === "not-dispatched" && taskFiles.some((f) => held.has(f))) continue;
    for (const f of taskFiles) held.add(f);
    dispatchable.push({ task, ...briefInputs(task), dependencies: dependenciesOf(blocks.get(task) ?? ""), mapRow: rowOf.get(task) });
  }
  const pending = tasks.find((t) => t.position === "exhausted-unresolved");
  return { wave, tasks, dispatchable, pendingDecision: pending ? { task: pending.task, loopId: reviewLoopId(pending.task) } : null };
}

export function waveSetup({ statePath, drive = false, knobsLine = null, ledgerPath = null, env = process.env, cwd = process.cwd() }) {
  const abs = resolve(cwd, statePath);
  let stateText;
  try {
    stateText = readFileSync(abs, "utf8");
  } catch {
    throw new Error(`cannot read state file: ${abs}`);
  }
  // The checkout the state file belongs to: the directory holding its .devcycle/, where the ledger,
  // the findings and the drive lock live too.
  const root = dirname(dirname(abs));
  workTreeRoot(root); // throws `not a git repository: <root>` — an environment error, exit 3

  const summary = describe(abs);
  const plan = known(field(stateText, "plan"));
  const recordedKnobs = field(stateText, "knobs");
  const declined = field(stateText, "knobs-declined");
  const state = {
    stage: summary.stage, branch: summary.branch, request: summary.request, plan, run: known(field(stateText, "run")),
    knobsLine: recordedKnobs, knobsDeclined: Boolean(declined && knobsLine && sameValues(declined, knobsLine)), stopped: null,
  };
  const ledger = ledgerPath ? resolve(cwd, ledgerPath) : join(root, ".devcycle", "ledger.md");
  const slot = ledgerSlotState({ root, plan, run: state.run });
  const lines = readLedger(ledger, plan, slot);
  const driver = classifyDrive({ statePath: abs });
  // Beside a running driver nothing is acted on, so nothing is judged: not even the depth.
  const attach = !drive && driver.running;
  const depth = attach ? null : depthNow(env, cwd);
  const status = driveStatus(root, abs, stateText, lines, knobsLine);
  const result = {
    ok: true, action: "resume", state, knobDrift: [], branch: null, depth, wave: null, tasks: [], dispatchable: [],
    pendingDecision: null, drive: status.drive, entryLines: [], appended: [], depthBand: depth?.band ?? null,
    handoff: { ...parseHandoff(field(stateText, "handoff")), ask: false },
  };
  // A stop on one task's pending decision names it, so the answer is recorded as that task's.
  const stop = (stopReason, stopDetail, stopTask = null) => ({ ...result, action: "stop", stopReason, stopDetail, stopTask });

  // A live lock is not proof enough: only a session the lock's driver started carries the token
  // whose hash the lock holds, so `--drive` typed in any other session is refused (spec 4.B.3).
  const token = env.DEVCYCLE_DRIVE_TOKEN;
  if (drive && !(result.drive.lock && token && status.tokenHash === driveTokenHash(token)))
    return stop("no-driver", `no live driver lock names ${abs} with this session's drive token`);
  if (drive && !result.drive.opted) return stop("not-opted-in", "the state file carries no drive: auto row");
  const checked = checkState(abs);
  state.stopped = checked.stopped ?? null;
  if (checked.kind === "foreign") return stop("foreign-state", `its root: ${checked.recordedRoot} is not this checkout (${checked.actualRoot})`);

  const planText = readPlan(root, plan);
  const map = mapPositions(root, planText, lines, ledger);
  Object.assign(result, { overview: overviewOf(map), ledgerSlot: slot });
  const decided = (decision) => ({ ...result.drive, ...decision, result: driver });
  if (attach) return { ...result, drive: decided({ lock: { pid: driver.pid, log: driver.log }, action: "attach", writeRow: null, confirm: null, gate: null }) };
  if (!checked.ok) return stop("resume-check", checked.errors.join("; "));
  if (state.stage !== "execution") return stop("resume-check", `the state file is at stage ${state.stage}, not execution`);

  result.entryLines = checked.lines;
  result.knobDrift = recordedKnobs && knobsLine
    ? compareKnobs(parseRecordedLine(recordedKnobs), parseRecordedLine(knobsLine)).map((c) => `${c.key}: ${c.old} → ${c.new}`)
    : [];
  result.branch = branchVerdict(root, field(stateText, "branch"));
  Object.assign(result, wavePosition(root, planText, map, lines));
  if (!drive) {
    const decision = driveAction(result.drive, driver, result.pendingDecision);
    // A recorded driver end or stop asks its own question instead (references/resume.md § The state file).
    const ask = result.handoff.state === "pending" && !state.stopped && decision.action !== "gate" && !(decision.action === "start" && driver.next !== "none");
    return { ...result, handoff: { ...result.handoff, ask }, drive: decided(decision) };
  }

  // Drive mode: every gate continue would ask about is a stop (spec 4.B.3).
  result.drive = decided({ action: "none", writeRow: null, confirm: null, gate: null });
  if (result.knobDrift.length && !state.knobsDeclined) return stop("knob-drift", result.knobDrift.join("; "));
  if (result.branch.verdict !== "ok")
    return stop("branch", `recorded ${result.branch.recorded ?? "none"}, current ${result.branch.current ?? "unknown"}: ${result.branch.verdict}`);
  if (depth.band === "over-budget" || depth.band === "hard-stop") return stop("depth-at-start", `the session starts at ${depth.tokens} tokens (${depth.band})`);
  const sweep = result.tasks.find((t) => t.position === "sweep-decision");
  if (sweep) return stop("sweep-fallback", `task ${sweep.task}: sweep-decision`, sweep.task);
  const waiting = result.tasks.find((t) => t.next === "needs-user");
  if (waiting) return stop("needs-user", `task ${waiting.task}: ${waiting.position}`, waiting.task);
  return result;
}

const FLAGS = { "--state": "value", "--drive": "none", "--knobs": "value", "--ledger": "value" };

function cli(argv) {
  const flags = taskFlags(argv, FLAGS, ["--state"]);
  return waveSetup({ statePath: flags["--state"], drive: flags["--drive"] === true, knobsLine: flags["--knobs"] ?? null, ledgerPath: flags["--ledger"] ?? null });
}

if (isMain(import.meta.url, process.argv[1])) runTaskScript("wave-setup", () => cli(process.argv.slice(2)));
