#!/usr/bin/env node
// The recovery inventory /devcycle:continue shows after an uncontrolled stop (references/resume.md § The
// state file holds, its recovery gate): per item of the interrupted stage, done, re-verify or redo, with
// the evidence. It owns no stage's resume verdict -- each adapter renders the owner that stage's playbook
// already resumes from -- only the cross-stage pieces: the detection verdict, the label, the ignored
// list and the uncommitted paths. Read-only: it writes nothing.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseFlags, requireValue } from "./cli-flags.mjs";
import { orElse, planOf, recordedValue, uncommittedPaths, uncontrolledStop } from "./cycle-position.mjs";
import { isMain } from "./is-main.mjs";
import { missing } from "./lens-results.mjs";
import { PER_TASK_DIRS, ledgerSlotState } from "./ledger-slot.mjs";
import { field } from "./md-field.mjs";
import { pathInsideRoot, readPlanPosition } from "./plan-resume.mjs";
import { readStage } from "./stage-log.mjs";
import { resultsPathFor, routing } from "./on-device-routing.mjs";
import { gateCommand, taskFileMap } from "./task-files.mjs";
import { parseLedgerLine } from "./task-ledger.mjs";
import { planProgress } from "./wave-setup.mjs";

const USAGE = "usage: recovery-inventory.mjs --state <path>";
const CHECKLIST_ITEM = /^- \[[ xX]\] /;
const ITEM_KEY = /^item-(\d+)$/;
const RELAUNCHED = "no verdict logged; the app is relaunched";

// Only this run's rows (the log file is named by the run id), and never one whose ref leaves the root.
const stageRows = ({ root, devcycleDir, run, stage }) =>
  orElse(() => readStage(devcycleDir, { run, stage }), []).filter(({ ref }) => ref === undefined || pathInsideRoot(root, ref) !== null);

const CALL_MATCHERS = [
  [/^plan-assembled$/, () => (call) => call.name === "Bash" && call.summary.includes("plan-assemble.mjs")],
  [/^checker-round-(\d+)$/, ([, n]) => (call) => new RegExp(`^plan-checker: round ${n}\\b`).test(call.summary)],
  [/^plan-gate$/, () => (call) => call.name === "Bash" && call.summary.includes("plan-check.mjs")],
];
function callMatcher(id) {
  for (const [pattern, make] of CALL_MATCHERS) {
    const m = id.match(pattern);
    if (m) return make(m);
  }
  return () => false;
}

// The transcript can only lower trust: a completed call earns a re-check, never done
// (docs/decisions/README.md, 2026-11-21 — After an uncontrolled stop, transcripts are a scoped fallback).
export function resolveAmbiguous({ id, transcript, matches = callMatcher(id) }) {
  if (!transcript) return { status: "redo", evidence: "no transcript" };
  if (transcript.pendingCall && matches(transcript.pendingCall)) return { status: "redo", evidence: "its call was running when the session died" };
  if ((transcript.calls ?? []).some((call) => call.completed && matches(call)))
    return { status: "re-verify", evidence: "its call completed in the last session; the artifact is checked before it is trusted" };
  return { status: "redo", evidence: "the transcript is silent about it" };
}

// The plan gate is cheap, so a logged one is rerun rather than trusted.
function planGate(root, stateText) {
  const plan = field(stateText, "plan");
  if (!plan || plan === "none" || !pathInsideRoot(root, plan)) return { status: "redo", evidence: "the state names no plan inside its root:" };
  const spec = field(stateText, "spec");
  const specFlag = spec && spec !== "none" && pathInsideRoot(root, spec) ? ` --spec ${spec}` : "";
  return { status: "re-verify", evidence: "stage-log plan-gate", check: `node "\${CLAUDE_PLUGIN_ROOT}/scripts/plan-check.mjs" ${plan}${specFlag}` };
}

// plan-resume prints its position and exits 0 whatever the round holds, so the check reads the round's batch
// counts from that output and fails unless every batch file is there.
const CHECKER_ROUND_CHECK = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-resume.mjs" --state .devcycle/state.md | node -e '
  + `'const s = JSON.parse(require("fs").readFileSync(0, "utf8")).steps.find((step) => step.id === "checker-round-1"); process.exit(s && s.filled === s.expected ? 0 : 1)'`;

// What a re-verify step reruns before it is trusted, so no re-verify item reaches the gate without one.
function stepCheck(id, { root, run, stateText }) {
  if (id === "plan-gate") return planGate(root, stateText).check;
  if (id === "plan-assembled")
    return `node "\${CLAUDE_PLUGIN_ROOT}/scripts/plan-assemble.mjs" .devcycle/plan-work/${run} --out ${field(stateText, "plan")} --state .devcycle/state.md`;
  if (/^checker-round-\d+$/.test(id)) return CHECKER_ROUND_CHECK;
  return undefined;
}

function planning({ root, devcycleDir, stateText, run, transcript }) {
  let position;
  try {
    position = readPlanPosition(join(devcycleDir, "state.md"));
  } catch (e) {
    return [{ id: "planning", status: "redo", evidence: `plan-resume could not read the position: ${e.message}` }];
  }
  const items = [
    ...position.drafted.map((n) => ({ id: `plan-draft-${n}`, status: "done", evidence: `stage-log plan-draft-${n} and its task file` })),
    ...position.missing.map((n) => ({ id: `plan-draft-${n}`, status: "redo", evidence: `no plan-draft-${n} row with its task file` })),
  ];
  for (const { id, status, expected, filled } of position.steps) {
    if (status === "pending") continue;
    if (status === "ambiguous" && filled < expected) {
      // A round with a batch still to run is unfinished whatever the transcript shows.
      items.push({ id, status: "redo", evidence: `${filled} of ${expected} batch files on disk; the round dispatches the rest` });
    } else if (status === "ambiguous") {
      const resolved = resolveAmbiguous({ id, transcript });
      const check = resolved.status === "re-verify" ? stepCheck(id, { root, run, stateText }) : undefined;
      items.push({ id, ...resolved, ...(check ? { check } : {}) });
    }
    else if (status === "re-verify" && id === "plan-gate") items.push({ id, ...planGate(root, stateText) });
    else items.push({ id, status, evidence: `plan-resume: ${id} ${status}` });
  }
  return items;
}

// The walk's round and the failed items it still owes, from on-device-routing.mjs, the owner of both:
// its `round` counts the fix rounds begun, which is the round a walk entered now logs its verdicts under
// (playbooks/verifying-on-device.md § Entering a walk). `open` holds the FAILED items not waived or accepted.
function walkState({ root, stateText, checklist, resultsText }) {
  const ledger = recordedValue(stateText, "ledger");
  const ledgerPath = ledger ? pathInsideRoot(root, ledger) : null;
  const entries = ledgerPath ? orElse(() => readFileSync(ledgerPath, "utf8"), "").split("\n").map(parseLedgerLine).filter(Boolean) : [];
  const { round, failed, carried } = routing({ resultsText, entries, specPath: recordedValue(stateText, "spec"), checklist, cap: null });
  const kept = new Set(carried.map(({ n }) => n));
  return { round, open: new Set(failed.map(({ n }) => n).filter((n) => !kept.has(n))) };
}

// Items are the checklist's boxes in order, numbered as its report lines are (#<n>, references/checklist.md).
// A verdict is kept only for the walk's own round (the playbook's rule), so an open failure logged under an
// earlier round is redo: the fix round re-walks it, or the user is asked again.
function onDevice({ root, devcycleDir, stateText, run, stage }) {
  const checklist = pathInsideRoot(root, field(stateText, "checklist"));
  const text = checklist ? orElse(() => readFileSync(checklist, "utf8"), "") : "";
  const count = text.split("\n").filter((line) => CHECKLIST_ITEM.test(line)).length;
  const verdicts = new Map();
  for (const { key, data } of stageRows({ root, devcycleDir, run, stage })) {
    const round = Number(data?.round ?? 0);
    if (key === "batch-answer") for (const [n, line] of Object.entries(data?.lines ?? {})) verdicts.set(Number(n), { line: String(line), round });
    const item = key.match(ITEM_KEY);
    if (item) verdicts.set(Number(item[1]), { line: String(data?.line ?? `stage-log ${key}`), round });
  }
  const resultsText = checklist ? orElse(() => readFileSync(resultsPathFor(checklist), "utf8"), "") : "";
  const walk = orElse(() => walkState({ root, stateText, checklist: field(stateText, "checklist"), resultsText }), { round: 0, open: new Set() });
  const current = Math.max(walk.round, ...[...verdicts.values()].map(({ round }) => round));
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const verdict = verdicts.get(n);
    if (!verdict) return { id: `item-${n}`, status: "redo", evidence: RELAUNCHED };
    if (verdict.round < current && walk.open.has(n))
      return { id: `item-${n}`, status: "redo", evidence: `from an earlier walk (round ${verdict.round}), still open: ${verdict.line}` };
    return { id: `item-${n}`, status: "done", evidence: verdict.line };
  });
}

const stageLogAdapter = (ctx) => stageRows(ctx).map(({ key }) => ({ id: key, status: "done", evidence: `stage-log ${key}` }));

const planTextOf = (root, plan) => {
  const path = pathInsideRoot(root, plan);
  return path ? orElse(() => readFileSync(path, "utf8"), "") : "";
};

// references/resume.md § Resuming a wave's per-task position decides each task's next step through
// wave-setup.mjs; this only renders it. An accepted review not yet committed is re-verified by the green
// gate its commit runs.
function execution({ root, devcycleDir, stateText, run }) {
  let progress;
  try {
    progress = planProgress({ root, statePath: join(devcycleDir, "state.md") });
  } catch (err) {
    return [{ id: "execution", status: "redo", evidence: `wave-setup could not read the position: ${err.message}` }];
  }
  const plan = planOf(stateText);
  if (!progress) {
    if (orElse(() => ledgerSlotState({ root, plan, run }), "fresh") !== "stale") return [];
    return PER_TASK_DIRS.filter((dir) => existsSync(join(devcycleDir, dir)))
      .map((dir) => ({ id: `.devcycle/${dir}/`, status: "ignored", evidence: "previous cycle's slot" }));
  }
  const planText = planTextOf(root, plan);
  return [...progress.positions].map(([task, { position, next }]) => {
    const item = { id: `task-${task}`, evidence: `ledger: ${position} → ${next}` };
    if (position === "committed") return { ...item, status: "done" };
    if (position !== "accepted") return { ...item, status: "redo" };
    const gate = gateCommand(planText, Number(task))?.cmd ?? "the task's own test command (the plan pins no gate for it)";
    return { ...item, status: "re-verify", check: gate };
  });
}

// At execution, the first task whose Files block holds each uncommitted path. A re-dispatched implementer
// reconciles its own uncommitted edits (the existing cut-off rule), so naming the task is all this adds.
function claimant(root, stateText, stage) {
  const plan = stage === "execution" ? planOf(stateText) : null;
  const files = plan ? [...orElse(() => taskFileMap(planTextOf(root, plan)), new Map())].sort(([a], [b]) => a - b) : [];
  return (path) => {
    const owner = files.find(([, paths]) => paths.has(path));
    return owner ? String(owner[0]) : null;
  };
}

// When each of this cycle's branch-review rounds opened. playbooks/reviewing-the-branch.md § Findings loop
// logs a round's review-round line before its reviewers run, and the round writes round-<d>, <d> being one
// more than the spec's review-verdict lines before that line. A dead round and the round finishing it share
// a directory, so the first line's stamp is the one its files postdate.
function roundOpenings(root, devcycleDir, stateText, run) {
  const spec = recordedValue(stateText, "spec");
  const opened = new Map();
  if (!spec || orElse(() => ledgerSlotState({ root, plan: planOf(stateText), run }), "stale") === "stale") return opened;
  let verdicts = 0;
  for (const text of orElse(() => readFileSync(join(devcycleDir, "ledger.md"), "utf8"), "").split("\n")) {
    const entry = parseLedgerLine(text);
    if (entry?.task !== "branch" || entry.ref !== spec) continue;
    if (entry.event === "review-verdict") verdicts++;
    else if (entry.event === "review-round" && !opened.has(verdicts + 1)) opened.set(verdicts + 1, Date.parse(entry.stamp));
  }
  return opened;
}

// The underscore files (_args.json, _lenses.json, _refutation.json) are a round's bookkeeping, not lens
// results: the rule scripts/cycle-position.mjs's branchReviewSummary counts by.
const lensFiles = (names) => names.filter((name) => !name.startsWith("_"));

function roundItems(dir, d, openedAt) {
  const id = `review-round-${d}`;
  const names = orElse(() => readdirSync(dir), []);
  const thisCycle = openedAt !== undefined && lensFiles(names).every((name) => orElse(() => statSync(join(dir, name)).mtimeMs, 0) >= openedAt);
  if (!thisCycle) return [{ id, status: "ignored", evidence: "not this cycle's round" }];
  if (names.includes("_lenses.json")) {
    let found;
    try {
      // missing() resolves the saved ref in this process's working directory: the cycle's checkout, where
      // /devcycle:continue runs the inventory.
      found = missing(dir);
    } catch (err) {
      return [{ id, status: "redo", evidence: `round-${d}: lens-results could not check the saved lenses (${err.message}); the round reruns` }];
    }
    return [
      ...found.results.map(({ lens }) => ({ id: `review-round-${d}-lens-${lens}`, status: "done", evidence: `round-${d}: a current result is stored` })),
      ...found.missing.map((lens) => ({ id: `review-round-${d}-lens-${lens}`, status: "redo", evidence: `round-${d}: no current result; single dispatches it again` })),
    ];
  }
  if (names.includes("_args.json")) {
    const count = lensFiles(names).length;
    return [{ id, status: "redo", evidence: `${count} lens result ${count === 1 ? "file" : "files"} on disk; the panel resumes the missing lenses itself` }];
  }
  return [{ id, status: "redo", evidence: `round-${d}: no saved lens set or panel arguments; the round reruns` }];
}

// A round directory counts only when this cycle's ledger opened it and its lens files postdate that line;
// the playbook removes any other before reuse. The stage log adds each logged refutation-<n>.
function branchReview(ctx) {
  const { root, devcycleDir, stateText, run } = ctx;
  const reviewDir = join(devcycleDir, "review");
  const opened = roundOpenings(root, devcycleDir, stateText, run);
  const rounds = orElse(() => readdirSync(reviewDir), [])
    .map((name) => Number(name.match(/^round-(\d+)$/)?.[1] ?? 0)).filter(Boolean).sort((a, b) => a - b);
  return [...rounds.flatMap((d) => roundItems(join(reviewDir, `round-${d}`), d, opened.get(d))), ...stageLogAdapter(ctx)];
}

export const ADAPTERS = { planning, "on-device": onDevice, execution, "branch-review": branchReview };
export const adapterFor = (stage) => ADAPTERS[stage] ?? stageLogAdapter;

function summaryLines(stage, items, uncommitted) {
  const count = (status) => items.filter((item) => item.status === status).length;
  return [
    `${stage}: ${count("done")} done, ${count("re-verify")} re-verify, ${count("redo")} redo, ${count("ignored")} ignored`,
    ...(uncommitted.length ? [`uncommitted: ${uncommitted.length} path(s)`] : []),
    ...items.filter(({ status }) => status === "re-verify").map(({ id, check, evidence }) => `re-verify ${id}: ${check ?? evidence}`),
  ];
}

export function recoveryInventory({ statePath, env = process.env, now = Date.now() }) {
  const abs = resolve(statePath);
  const stateText = readFileSync(abs, "utf8");
  const devcycleDir = dirname(abs);
  const root = dirname(devcycleDir);
  const run = field(stateText, "run");
  const stop = orElse(() => uncontrolledStop({ statePath: abs, env, now }), null);
  const stage = stop?.stage ?? field(stateText, "stage") ?? "unknown";
  let items;
  try {
    items = adapterFor(stage)({ root, devcycleDir, stateText, run, stage, transcript: stop?.transcript ?? null });
  } catch (e) {
    items = [{ id: stage, status: "redo", evidence: `the inventory could not read this stage's position: ${e.message}` }];
  }
  const claim = claimant(root, stateText, stage);
  const uncommitted = orElse(() => uncommittedPaths(root), []).map((path) => ({ path, task: claim(path) }));
  return {
    uncontrolled: stop !== null, stage, label: stop?.label ?? "unknown", since: stop?.since ?? null,
    items, uncommitted, summary: summaryLines(stage, items, uncommitted),
  };
}

function main(argv) {
  let statePath;
  try {
    statePath = requireValue(parseFlags(argv, { "--state": "value" }, { requireValues: "nonEmpty" }).flags, "--state");
  } catch {
    statePath = undefined;
  }
  if (statePath === undefined) {
    console.error(`recovery-inventory: ${USAGE}`);
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(recoveryInventory({ statePath }), null, 2));
  } catch (e) {
    console.error(`recovery-inventory: ${e.message}`);
    process.exit(1);
  }
}

if (isMain(import.meta.url, process.argv[1])) main(process.argv.slice(2));
