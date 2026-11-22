import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { logStep } from "../../scripts/stage-log.mjs";
import { gitToplevel, hashSession, recordPath } from "../../scripts/run-record.mjs";
import { ADAPTERS, adapterFor, recoveryInventory, resolveAmbiguous } from "../../scripts/recovery-inventory.mjs";
import { commitAll, makeRepo, writeInto } from "./helpers.mjs";

const SCRIPT = new URL("../../scripts/recovery-inventory.mjs", import.meta.url).pathname;
const API_ERROR = new URL("../fixtures/dispatch-health/api-error.jsonl", import.meta.url).pathname;
const RUN = "00000000000000e6";
const OTHER_RUN = "00000000000000e7";
const WORK = `.devcycle/plan-work/${RUN}`;
const CUT = [1, 2, 3].map((num) => ({ num, wave: 1, deps: [], files: [`f${num}.mjs`], produces: 1 }));
const PLAN_GATE = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-check.mjs" docs/plan.md --spec docs/spec.md';
const RELAUNCHED = "no verdict logged; the app is relaunched";

// Run records and transcripts live under fixture dirs, never the real ~/.claude (child processes
// inherit DEVCYCLE_RUNS_DIR through process.env).
process.env.DEVCYCLE_RUNS_DIR = makeTempDir("recovery-runs-");
const CONFIG = makeTempDir("recovery-config-");
const ENV = { ...process.env, CLAUDE_CONFIG_DIR: CONFIG };

// A git checkout whose .devcycle/ is ignored, holding a state file at `stage`, and a logger for that stage.
function cycle({ stage, rows = [], handoff = "ready 2026-11-21T15:00:00Z", run = RUN }) {
  const root = makeRepo();
  writeInto(root, ".gitignore", ".devcycle/\n");
  commitAll(root, "ignore the cycle dir");
  const devcycleDir = join(root, ".devcycle");
  const stateText = ["# devcycle state", `- root: ${root}`, `- stage: ${stage}`, ...(run ? [`- run: ${run}`] : []),
    `- handoff: ${handoff}`, "- updated: 2026-11-21T15:00:00Z", ...rows, ""].join("\n");
  writeInto(root, ".devcycle/state.md", stateText);
  return {
    root,
    statePath: join(devcycleDir, "state.md"),
    log: (key, extra = {}, logRun = RUN) => logStep(devcycleDir, { run: logRun, stage, key, ...extra }),
    ctx: (transcript = null) => ({ root, devcycleDir, stateText, run, stage, transcript }),
  };
}

// Planning at an inline cut of three tasks: two drafted, the plan file on disk with no plan-assembled
// row (an ambiguous assembly), and a logged plan-gate row.
function planningCycle() {
  const c = cycle({ stage: "planning", rows: ["- plan: docs/plan.md", "- spec: docs/spec.md"] });
  writeInto(c.root, `${WORK}/task-cut.json`, JSON.stringify(CUT));
  c.log("drafting-plan", { data: { strategy: "checkpointed", groups: 0, drafters: 0, est: 1, cut: `${WORK}/task-cut.json` } });
  for (const num of [1, 2]) {
    writeInto(c.root, `${WORK}/tasks/task-${num}.md`, `### Task ${num}: T${num}\n\n**Files:**\n- Create: \`f${num}.mjs\`\n\n**Dependencies:** none\n`);
    c.log(`plan-draft-${num}`, { ref: `${WORK}/tasks/task-${num}.md` });
  }
  writeInto(c.root, "docs/plan.md", "# Plan\n");
  writeInto(c.root, "docs/spec.md", "# Spec\n");
  commitAll(c.root, "plan and spec");
  c.log("plan-gate", { data: { exit: 1 } });
  return c;
}

const call = (name, summary, completed = true) => ({ id: `toolu_${summary.length}`, name, summary, completed });
const transcriptOf = (calls) => {
  const open = calls.filter(({ completed }) => !completed).at(-1);
  return { calls, pendingCall: open ? { name: open.name, summary: open.summary } : null, apiError: null };
};
const ASSEMBLE = "node scripts/plan-assemble.mjs .devcycle/plan-work/x --out docs/plan.md";
const brief = (items) => items.map(({ id, status }) => `${id}=${status}`);

test("an ambiguous step resolves to redo when its call was running, re-verify when it completed, and redo when the transcript is silent", () => {
  const assembled = (transcript) => resolveAmbiguous({ id: "plan-assembled", transcript, matches: (c) => c.name === "Bash" && c.summary.includes("plan-assemble.mjs") });
  assert.deepEqual(assembled(transcriptOf([call("Bash", ASSEMBLE, false)])), { status: "redo", evidence: "its call was running when the session died" });
  assert.deepEqual(assembled(transcriptOf([call("Bash", ASSEMBLE)])),
    { status: "re-verify", evidence: "its call completed in the last session; the artifact is checked before it is trusted" });
  assert.deepEqual(assembled(transcriptOf([call("Bash", "git status")])), { status: "redo", evidence: "the transcript is silent about it" });
  assert.deepEqual(assembled(null), { status: "redo", evidence: "no transcript" });
});

test("a pending call outranks an earlier completed run of the same step", () => {
  const t = transcriptOf([call("Bash", ASSEMBLE), call("Bash", `${ASSEMBLE} --again`, false)]);
  assert.equal(resolveAmbiguous({ id: "plan-assembled", transcript: t }).status, "redo");
});

test("each planning step's own call matcher is the default, and an unknown step never matches", () => {
  const t = transcriptOf([call("Agent", "plan-checker: round 2 — batch 1"), call("Bash", "node scripts/plan-check.mjs docs/plan.md")]);
  assert.equal(resolveAmbiguous({ id: "checker-round-2", transcript: t }).status, "re-verify");
  assert.equal(resolveAmbiguous({ id: "checker-round-1", transcript: transcriptOf([call("Agent", "plan-checker: round 12 — batch 1")]) }).status, "redo");
  assert.equal(resolveAmbiguous({ id: "plan-gate", transcript: t }).status, "re-verify");
  assert.equal(resolveAmbiguous({ id: "item-4", transcript: t }).status, "redo");
});

test("the transcript never yields done", () => {
  const shapes = [null, transcriptOf([]), transcriptOf([call("Bash", ASSEMBLE)]), transcriptOf([call("Bash", ASSEMBLE, false)])];
  for (const id of ["plan-assembled", "checker-round-1", "plan-gate", "anything"])
    for (const transcript of shapes) assert.notEqual(resolveAmbiguous({ id, transcript }).status, "done", `${id}`);
});

test("planning renders plan-resume's drafts and steps, with the plan gate as a re-verify carrying its check", () => {
  const items = ADAPTERS.planning(planningCycle().ctx());
  assert.deepEqual(brief(items), ["plan-draft-1=done", "plan-draft-2=done", "plan-draft-3=redo", "plan-assembled=redo", "plan-gate=re-verify"]);
  assert.equal(items[0].evidence, "stage-log plan-draft-1 and its task file");
  assert.equal(items[3].evidence, "no transcript");
  assert.equal(items.at(-1).check, PLAN_GATE);
});

test("planning's ambiguous assembly follows the last session's transcript, never to done, and a re-verify carries its check", () => {
  const c = planningCycle();
  const assembly = (calls) => ADAPTERS.planning(c.ctx(transcriptOf(calls))).find(({ id }) => id === "plan-assembled");
  const status = (calls) => assembly(calls)?.status;
  assert.deepEqual(assembly([call("Bash", ASSEMBLE)]), {
    id: "plan-assembled", status: "re-verify",
    evidence: "its call completed in the last session; the artifact is checked before it is trusted",
    check: `node "\${CLAUDE_PLUGIN_ROOT}/scripts/plan-assemble.mjs" .devcycle/plan-work/${RUN} --out docs/plan.md --state .devcycle/state.md`,
  });
  assert.equal(status([call("Bash", ASSEMBLE)]), "re-verify");
  assert.equal(status([call("Bash", ASSEMBLE, false)]), "redo");
  assert.equal(status([call("Bash", "git status")]), "redo");
});

test("planning whose position cannot be read is one redo item naming why", () => {
  const items = ADAPTERS.planning(cycle({ stage: "planning", run: null }).ctx());
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "planning");
  assert.equal(items[0].status, "redo");
  assert.match(items[0].evidence, /^plan-resume could not read the position: .*names no run/);
});

test("on-device numbers the checklist's items and marks each logged or batch-answered one done", () => {
  const c = cycle({ stage: "on-device", rows: ["- checklist: docs/checklist.md"] });
  writeInto(c.root, "docs/checklist.md", "# Checklist\n\n- [ ] the banner shows\n      Tier: needs-eyes\n- [x] the list sorts\n- [ ] the dialog closes\nnot an item\n");
  c.log("item-1", { data: { line: "#1 passed", round: 0 } });
  c.log("batch-answer", { data: { lines: { 3: "#3 passed (confirmed from batch)" }, round: 0 } });
  assert.deepEqual(ADAPTERS["on-device"](c.ctx()), [
    { id: "item-1", status: "done", evidence: "#1 passed" },
    { id: "item-2", status: "redo", evidence: RELAUNCHED },
    { id: "item-3", status: "done", evidence: "#3 passed (confirmed from batch)" },
  ]);
});

test("every other stage falls back to the stage log: this run's logged keys are done, and another run's are not", () => {
  const c = cycle({ stage: "scoping" });
  c.log("scope-confirmed");
  c.log("areas-listed", { ref: "docs/areas.md" });
  c.log("from-another-run", {}, OTHER_RUN);
  assert.equal(adapterFor("planning"), ADAPTERS.planning);
  assert.equal(adapterFor("on-device"), ADAPTERS["on-device"]);
  assert.equal(adapterFor("scoping"), adapterFor("brainstorm"));
  assert.deepEqual(adapterFor("scoping")(c.ctx()), [
    { id: "scope-confirmed", status: "done", evidence: "stage-log scope-confirmed" },
    { id: "areas-listed", status: "done", evidence: "stage-log areas-listed" },
  ]);
});

test("a path outside the state's root is never read", () => {
  const elsewhere = makeTempDir("recovery-elsewhere-");
  writeInto(elsewhere, "checklist.md", "- [ ] an item of another checkout\n");
  const device = cycle({ stage: "on-device", rows: [`- checklist: ${join(elsewhere, "checklist.md")}`] });
  assert.deepEqual(ADAPTERS["on-device"](device.ctx()), []);
  const scoping = cycle({ stage: "scoping" });
  scoping.log("scope-confirmed");
  scoping.log("borrowed-notes", { ref: "../another-checkout/notes.md" });
  assert.deepEqual(brief(adapterFor("scoping")(scoping.ctx())), ["scope-confirmed=done"]);
});

test("the summary counts each status, then the uncommitted paths, then each re-verify item's check", () => {
  const c = cycle({ stage: "scoping" });
  c.log("scope-confirmed");
  c.log("areas-listed");
  const clean = recoveryInventory({ statePath: c.statePath, env: ENV });
  assert.deepEqual({ ...clean, items: undefined }, {
    uncontrolled: false, stage: "scoping", label: "unknown", since: null, items: undefined, uncommitted: [],
    summary: ["scoping: 2 done, 0 re-verify, 0 redo, 0 ignored"],
  });
  writeInto(c.root, "notes.txt", "unsaved\n");
  const dirty = recoveryInventory({ statePath: c.statePath, env: ENV });
  assert.deepEqual(dirty.uncommitted, [{ path: "notes.txt", task: null }]);
  assert.deepEqual(dirty.summary, ["scoping: 2 done, 0 re-verify, 0 redo, 0 ignored", "uncommitted: 1 path(s)"]);
  const planning = recoveryInventory({ statePath: planningCycle().statePath, env: ENV });
  assert.deepEqual(planning.summary, ["planning: 2 done, 1 re-verify, 2 redo, 0 ignored", `re-verify plan-gate: ${PLAN_GATE}`]);
});

const inventory = (args, env = ENV) => spawnSync("node", [SCRIPT, ...args], { encoding: "utf8", env });

test("the CLI prints the inventory of an uncontrolled stop, labelled from the last session's transcript", () => {
  const c = cycle({ stage: "on-device", rows: ["- checklist: docs/checklist.md"], handoff: "pending 2026-11-21T15:00:00Z" });
  writeInto(c.root, "docs/checklist.md", "- [ ] the banner shows\n- [ ] the list sorts\n");
  commitAll(c.root, "checklist");
  c.log("item-2", { data: { line: "#2 passed", round: 0 } });
  const record = recordPath(gitToplevel(c.root), RUN);
  mkdirSync(join(record, ".."), { recursive: true });
  appendFileSync(record, `${JSON.stringify({ kind: "session", sessionHash: hashSession("sid-old") })}\n`);
  const config = makeTempDir("recovery-config-");
  mkdirSync(join(config, "projects", "-repo"), { recursive: true });
  copyFileSync(API_ERROR, join(config, "projects", "-repo", "sid-old.jsonl"));
  const r = inventory(["--state", c.statePath], { ...process.env, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SESSION_ID: "sid-new" });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.uncontrolled, true);
  assert.equal(out.stage, "on-device");
  assert.equal(out.label, "usage-limit");
  assert.match(out.since, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.deepEqual(brief(out.items), ["item-1=redo", "item-2=done"]);
  assert.deepEqual(out.summary, ["on-device: 1 done, 0 re-verify, 1 redo, 0 ignored"]);
});

test("the CLI exits 2 with its usage line on bad flags, and 1 naming the error otherwise", () => {
  for (const args of [[], ["--bogus"], ["--state"]]) {
    const r = inventory(args);
    assert.equal(r.status, 2, `${args}`);
    assert.equal(r.stderr, "recovery-inventory: usage: recovery-inventory.mjs --state <path>\n");
  }
  const missing = inventory(["--state", join(makeTempDir("recovery-none-"), "state.md")]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^recovery-inventory: /);
});
