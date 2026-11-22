#!/usr/bin/env node
// The recovery inventory /devcycle:continue shows after an uncontrolled stop (references/resume.md § The
// state file holds, its recovery gate): per item of the interrupted stage, done, re-verify or redo, with
// the evidence. It owns no stage's resume verdict -- each adapter renders the owner that stage's playbook
// already resumes from -- only the cross-stage pieces: the detection verdict, the label, the ignored
// list and the uncommitted paths. Read-only: it writes nothing.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseFlags, requireValue } from "./cli-flags.mjs";
import { orElse, uncommittedPaths, uncontrolledStop } from "./cycle-position.mjs";
import { isMain } from "./is-main.mjs";
import { field } from "./md-field.mjs";
import { pathInsideRoot, readPlanPosition } from "./plan-resume.mjs";
import { readStage } from "./stage-log.mjs";

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

// What a re-verify step reruns before it is trusted, so no re-verify item reaches the gate without one.
function stepCheck(id, { root, run, stateText }) {
  if (id === "plan-gate") return planGate(root, stateText).check;
  if (id === "plan-assembled")
    return `node "\${CLAUDE_PLUGIN_ROOT}/scripts/plan-assemble.mjs" .devcycle/plan-work/${run} --out ${field(stateText, "plan")} --state .devcycle/state.md`;
  if (/^checker-round-\d+$/.test(id)) return 'node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-resume.mjs" --state .devcycle/state.md';
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
  for (const { id, status } of position.steps) {
    if (status === "pending") continue;
    if (status === "ambiguous") {
      const resolved = resolveAmbiguous({ id, transcript });
      const check = resolved.status === "re-verify" ? stepCheck(id, { root, run, stateText }) : undefined;
      items.push({ id, ...resolved, ...(check ? { check } : {}) });
    }
    else if (status === "re-verify" && id === "plan-gate") items.push({ id, ...planGate(root, stateText) });
    else items.push({ id, status, evidence: `plan-resume: ${id} ${status}` });
  }
  return items;
}

// Items are the checklist's boxes in order, numbered as its report lines are (#<n>, references/checklist.md).
function onDevice({ root, devcycleDir, stateText, run, stage }) {
  const checklist = pathInsideRoot(root, field(stateText, "checklist"));
  const text = checklist ? orElse(() => readFileSync(checklist, "utf8"), "") : "";
  const count = text.split("\n").filter((line) => CHECKLIST_ITEM.test(line)).length;
  const verdicts = new Map();
  for (const { key, data } of stageRows({ root, devcycleDir, run, stage })) {
    if (key === "batch-answer") for (const [n, line] of Object.entries(data?.lines ?? {})) verdicts.set(Number(n), String(line));
    const item = key.match(ITEM_KEY);
    if (item) verdicts.set(Number(item[1]), String(data?.line ?? `stage-log ${key}`));
  }
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return verdicts.has(n) ? { id: `item-${n}`, status: "done", evidence: verdicts.get(n) } : { id: `item-${n}`, status: "redo", evidence: RELAUNCHED };
  });
}

const stageLogAdapter = (ctx) => stageRows(ctx).map(({ key }) => ({ id: key, status: "done", evidence: `stage-log ${key}` }));

export const ADAPTERS = { planning, "on-device": onDevice };
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
  const uncommitted = orElse(() => uncommittedPaths(root), []).map((path) => ({ path, task: null }));
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
