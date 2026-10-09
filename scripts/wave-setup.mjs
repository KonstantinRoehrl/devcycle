#!/usr/bin/env node
// /devcycle:continue's execution resume path in one call (spec 4.A.3): the ownership check and
// resume-check, the knob comparison, the branch verdict, the depth probe and the drive status, then
// every current-wave task's position per references/resume.md § Resuming a wave's per-task position
// with its brief inputs until it is committed, and the next implementer dispatches — one JSON object
// on stdout. It never appends the run's session row: the hooks module (hooks/devcycle-mod.mjs) joins
// a session to its run only when it sees that append as a main-loop Bash call of its own, so
// commands/continue.md keeps it so.
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { isMain } from "./is-main.mjs";
import { field } from "./md-field.mjs";
import { describe } from "./find-state-files.mjs";
import { checkState } from "./resume-check.mjs";
import { compareKnobs, parseRecordedLine } from "./resolve-knobs.mjs";
import { resolveDepth } from "./depth-probe.mjs";
import { TEST_FILE_SUFFIXES, fieldValue, parseDispatchMap, taskBlocks, taskFileMap } from "./task-files.mjs";
import { nextReviewRound, parseLedgerLine, retryCount, runTaskScript, taskFlags, workTreeRoot } from "./task-ledger.mjs";
import { reviewLoopId } from "./task-verdict.mjs";
import { driveTokenHash, readLiveDriveLock } from "./drive-lock.mjs";
import { isProtectedBranch } from "./branch-names.mjs";

const NONE = new Set(["none", "<tbd>", ""]);
// A recorded field's value without its annotation (`feat/x (cut from dev at abc1234)`), or null.
const known = (raw) => {
  const value = (raw ?? "").split(/\s+/)[0];
  return NONE.has(value) ? null : value;
};

// The loops their own text leaves uncapped get two retries per task (spec 4.A.2); the third such
// outcome is the user's decision.
export const RETRY_CAP = 2;
const CAPPED_OUTCOMES = ["rejected (intake bounce)", "rejected (missing report file)", "rejected (missing findings file)"];
const SWEEP_TOKEN = /\bsweep\b|\bapplied-none\b|\bdirty-targets\b/;
const IMPLEMENTER_NEXT = new Set(["dispatch-implementer", "redispatch-implementer", "fix"]);

// references/resume.md § Resuming a wave's per-task position, most specific row first. `lines` are
// one task's parsed ledger lines in file order; `retries(prefix)` counts that task's lines whose
// outcome starts with prefix.
export function taskPosition(lines, { pendingLoop = null, retries = () => 0 } = {}) {
  if (pendingLoop) return { position: "exhausted-unresolved", next: "needs-user" };
  const last = lines.at(-1);
  if (!last) return { position: "not-dispatched", next: "dispatch-implementer" };
  const { event, outcome } = last;
  if (event === "committed") return { position: "committed", next: "done" };
  if (event === "user-decision") return { position: "user-decision", next: "follow-decision" };
  if (event === "dispatched" && outcome.startsWith("sweep")) return { position: "sweep-dispatched", next: "rerun-sweep" };
  if (SWEEP_TOKEN.test(outcome)) return { position: "sweep-decision", next: "needs-user" };
  const capped = CAPPED_OUTCOMES.find((prefix) => outcome.startsWith(prefix));
  if (capped && retries(capped) > RETRY_CAP) return { position: "retry-cap", next: "needs-user" };
  if (capped === "rejected (missing findings file)") return { position: "missing-findings", next: "redispatch-reviewer" };
  if (capped === "rejected (missing report file)") return { position: "missing-report", next: "redispatch-implementer" };
  if (capped === "rejected (intake bounce)") return { position: "intake-bounce", next: "fix" };
  if (event === "report-received" && outcome.startsWith("blocked")) return { position: "blocked", next: "needs-user" };
  if (event === "review-verdict" && outcome.startsWith("deferred")) return { position: "deferred", next: "regate-after-quiesce" };
  if (event === "review-verdict" && outcome.startsWith("accepted")) return { position: "accepted", next: "commit" };
  if (event === "review-verdict" && outcome.startsWith("rejected")) return { position: "rejected", next: "fix" };
  if (event === "review-round") return { position: "review-round", next: "redispatch-reviewer" };
  if (event === "report-received") return { position: "report-received", next: "dispatch-reviewer" };
  if (event === "dispatched") return { position: "dispatched", next: "redispatch-implementer" };
  return { position: "unknown", next: "needs-user" };
}

// This cycle's ledger lines. A ledger whose `Plan:` preamble names another plan is a previous
// cycle's slot (references/resume.md § The state file): none of its lines is this cycle's.
function readLedger(ledgerPath, plan) {
  let text;
  try {
    text = readFileSync(ledgerPath, "utf8");
  } catch {
    return [];
  }
  if (!plan || text.match(/^Plan: `([^`]+)`/m)?.[1] !== plan) return [];
  return text.split("\n").map(parseLedgerLine).filter(Boolean);
}

function pendingLoop(root, task, lines) {
  const loopId = reviewLoopId(task);
  let status;
  try {
    status = readFileSync(join(root, ".devcycle", "findings", `${loopId}-status.md`), "utf8");
  } catch {
    return null;
  }
  if (!/^status:\s*exhausted-unresolved\b/m.test(status)) return null;
  // Matched by id, never by order: the status file carries no timestamp.
  return lines.some((l) => l.event === "user-decision" && l.outcome.includes(loopId)) ? null : loopId;
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

// The reported drive status, and the live lock's token hash, which is never reported.
function driveStatus(root, statePath, stateText, lines) {
  const row = field(stateText, "drive") ?? "";
  const model = row.match(/\bmodel=(\S+)/)?.[1];
  const live = readLiveDriveLock(root);
  const holder = live && realPath(resolve(root, live.state ?? "")) === realPath(statePath) ? live : null;
  const optInLogged = lines.some((l) => l.task === "drive" && l.event === "user-decision");
  const lock = holder ? { pid: holder.pid, log: holder.log } : null;
  return { drive: { opted: /^auto\b/.test(row), ...(model ? { model } : {}), lock, optInLogged }, tokenHash: holder?.tokenHash ?? null };
}

function wavePosition(root, plan, lines, ledgerPath) {
  let planText = "";
  try {
    if (plan) planText = readFileSync(isAbsolute(plan) ? plan : join(root, plan), "utf8");
  } catch {
    // resume-check confirmed the plan a moment ago; one that vanished since reads as no waves.
  }
  const waves = [...(parseDispatchMap(planText) ?? new Map())].sort(([a], [b]) => a - b);
  const blocks = new Map(taskBlocks(planText).map(({ num, text }) => [String(num), text]));
  const files = taskFileMap(planText);
  const byTask = Map.groupBy(lines, (l) => l.task);
  const positions = new Map();
  for (const [, nums] of waves)
    for (const num of nums) {
      const task = String(num);
      const own = byTask.get(task) ?? [];
      positions.set(task, taskPosition(own, { pendingLoop: pendingLoop(root, task, own), retries: (prefix) => retryCount(ledgerPath, task, prefix) }));
    }
  const done = new Set([...positions].filter(([, p]) => p.position === "committed").map(([task]) => task));
  const current = waves.find(([, nums]) => nums.some((num) => !done.has(String(num))));
  if (!current) return { wave: null, tasks: [], dispatchable: [], pendingDecision: null };
  const [wave, nums] = current;
  const ready = (task) => dependenciesOf(blocks.get(task) ?? "").every((dep) => done.has(dep));
  const filesOf = (task) => [...(files.get(Number(task)) ?? [])];
  // What playbooks/executing-waves.md's per-task steps take from the plan. Every task still to commit
  // carries them, so one resumed at a reviewer dispatch, the commit or a re-gate has its evidence class
  // and test command too, with the round its next review takes.
  const briefInputs = (task) => {
    const block = blocks.get(task) ?? "";
    const taskFiles = filesOf(task);
    const evidence = fieldValue(block, "Evidence");
    return { files: taskFiles, evidence, evidenceClass: evidence?.split(/\s+/)[0] ?? null, testCmd: testCommand(block, taskFiles) };
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
    knobsLine: recordedKnobs, knobsDeclined: Boolean(declined && knobsLine && sameValues(declined, knobsLine)),
  };
  const ledger = ledgerPath ? resolve(cwd, ledgerPath) : join(root, ".devcycle", "ledger.md");
  const lines = readLedger(ledger, plan);
  const depth = depthNow(env, cwd);
  const status = driveStatus(root, abs, stateText, lines);
  const result = {
    ok: true, action: "resume", state, knobDrift: [], branch: null, depth, wave: null, tasks: [], dispatchable: [],
    pendingDecision: null, drive: status.drive, entryLines: [], appended: [], depthBand: depth.band,
  };
  const stop = (stopReason, stopDetail) => ({ ...result, action: "stop", stopReason, stopDetail });

  // A live lock is not proof enough: only a session the lock's driver started carries the token
  // whose hash the lock holds, so `--drive` typed in any other session is refused (spec 4.B.3).
  const token = env.DEVCYCLE_DRIVE_TOKEN;
  if (drive && !(result.drive.lock && token && status.tokenHash === driveTokenHash(token)))
    return stop("no-driver", `no live driver lock names ${abs} with this session's drive token`);
  if (drive && !result.drive.opted) return stop("not-opted-in", "the state file carries no drive: auto row");
  const checked = checkState(abs);
  if (checked.kind === "foreign") return stop("foreign-state", `its root: ${checked.recordedRoot} is not this checkout (${checked.actualRoot})`);
  if (!checked.ok) return stop("resume-check", checked.errors.join("; "));
  if (!drive && result.drive.lock)
    return stop("driver-running", `a driver (pid ${result.drive.lock.pid}) is running this cycle; its log: ${result.drive.lock.log}`);
  if (state.stage !== "execution") return stop("resume-check", `the state file is at stage ${state.stage}, not execution`);

  result.entryLines = checked.lines;
  result.knobDrift = recordedKnobs && knobsLine
    ? compareKnobs(parseRecordedLine(recordedKnobs), parseRecordedLine(knobsLine)).map((c) => `${c.key}: ${c.old} → ${c.new}`)
    : [];
  result.branch = branchVerdict(root, field(stateText, "branch"));
  Object.assign(result, wavePosition(root, plan, lines, ledger));
  if (!drive) return result;

  // Drive mode: every gate continue would ask about is a stop (spec 4.B.3).
  if (result.knobDrift.length && !state.knobsDeclined) return stop("knob-drift", result.knobDrift.join("; "));
  if (result.branch.verdict !== "ok")
    return stop("branch", `recorded ${result.branch.recorded ?? "none"}, current ${result.branch.current ?? "unknown"}: ${result.branch.verdict}`);
  if (depth.band === "over-budget" || depth.band === "hard-stop") return stop("depth-at-start", `the session starts at ${depth.tokens} tokens (${depth.band})`);
  const sweep = result.tasks.find((t) => t.position === "sweep-decision");
  if (sweep) return stop("sweep-fallback", `task ${sweep.task}: sweep-decision`);
  const waiting = result.tasks.find((t) => t.next === "needs-user");
  if (waiting) return stop("needs-user", `task ${waiting.task}: ${waiting.position}`);
  return result;
}

const FLAGS = { "--state": "value", "--drive": "none", "--knobs": "value", "--ledger": "value" };

function cli(argv) {
  const flags = taskFlags(argv, FLAGS, ["--state"]);
  return waveSetup({ statePath: flags["--state"], drive: flags["--drive"] === true, knobsLine: flags["--knobs"] ?? null, ledgerPath: flags["--ledger"] ?? null });
}

if (isMain(import.meta.url, process.argv[1])) runTaskScript("wave-setup", () => cli(process.argv.slice(2)));
