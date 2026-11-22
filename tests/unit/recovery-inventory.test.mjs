import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

// Delegated planning over ten tasks, Tasks 2-10 each consuming Task 1: nine edges, so the edge checker's
// round 1 holds two batches. `batches` are the batch files already filled, with no checker-round-1 row.
function checkerCycle(batches) {
  const c = cycle({ stage: "planning", rows: ["- plan: docs/plan.md", "- spec: docs/spec.md"] });
  c.log("drafting-plan", { data: { strategy: "delegated", groups: 0, drafters: 0, est: 1 } });
  for (let num = 1; num <= 10; num++) {
    const deps = num === 1 ? "none" : "Task 1 (consumes f1)";
    writeInto(c.root, `${WORK}/tasks/task-${num}.md`, `### Task ${num}: T${num}\n\n**Files:**\n- Create: \`f${num}.mjs\`\n\n**Dependencies:** ${deps}\n`);
  }
  for (const n of batches) writeInto(c.root, `${WORK}/checker/round-1/batch-${n}.md`, "0 findings\n");
  return c;
}
const checkerRound = (c, calls) => ADAPTERS.planning(c.ctx(transcriptOf(calls))).find(({ id }) => id === "checker-round-1");
const BATCH_CALL = (n) => call("Agent", `plan-checker: round 1 — batch ${n}`);

test("a checker round with only some of its batch files is redo naming how many exist, never re-verify, whatever the transcript says", () => {
  const c = checkerCycle([1]);
  const round = checkerRound(c, [BATCH_CALL(1)]);
  assert.equal(round.status, "redo");
  assert.match(round.evidence, /1 of 2 batch files/);
  assert.equal(round.check, undefined);
});

test("a checker round with every batch file but no logged row stays re-verify, and its check fails once a batch file is gone", () => {
  const c = checkerCycle([1, 2]);
  const round = checkerRound(c, [BATCH_CALL(1), BATCH_CALL(2)]);
  assert.equal(round.status, "re-verify");
  const check = () => spawnSync("sh", ["-c", round.check], { cwd: c.root, encoding: "utf8", env: { ...process.env, CLAUDE_PLUGIN_ROOT: process.cwd() } });
  assert.equal(check().status, 0, check().stderr);
  rmSync(join(c.root, `${WORK}/checker/round-1/batch-2.md`));
  assert.notEqual(check().status, 0, "a passing check must mean the round is complete");
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

// An on-device cycle with two checklist items whose first walk logged #1 FAILED and #2 passed, the results
// report written, the user having decided to fix #1 (`decision` is another ledger outcome to use instead).
// `fixRound` adds the review-round line that opens the re-walk; `rewalk` logs #1's verdict for that round.
function walkedCycle({ fixRound = false, rewalk = null, decision = "fix" } = {}) {
  const c = cycle({ stage: "on-device", rows: ["- checklist: docs/checklist.md", "- spec: docs/spec.md", "- ledger: .devcycle/ledger.md"] });
  const failed = "- #1 the banner shows: FAILED — crashes — severity: high";
  writeInto(c.root, "docs/checklist.md", "- [ ] the banner shows\n- [ ] the list sorts\n");
  writeInto(c.root, "docs/on-device-results.md", `${failed}\n- #2 the list sorts: passed\n`);
  writeInto(c.root, ".devcycle/ledger.md", [
    `- [2026-11-21T15:00:00Z] task=on-device event=user-decision outcome=failed-item #1 the banner shows: ${decision} ref=docs/on-device-results.md`,
    ...(fixRound ? ["- [2026-11-21T15:01:00Z] task=on-device event=review-round outcome=round 1 ref=docs/spec.md"] : []), "",
  ].join("\n"));
  c.log("item-1", { data: { line: failed, round: 0 } });
  c.log("item-2", { data: { line: "- #2 the list sorts: passed", round: 0 } });
  if (rewalk) c.log("item-1", { data: { line: rewalk, round: 1 } });
  return c;
}
const statuses = (c) => Object.fromEntries(ADAPTERS["on-device"](c.ctx()).map(({ id, status }) => [id, status]));

test("an on-device item that failed in an earlier walk is redo once a fix round has started, until the re-walk logs it", () => {
  const items = ADAPTERS["on-device"](walkedCycle({ fixRound: true }).ctx());
  assert.deepEqual(items.map(({ id, status }) => `${id}=${status}`), ["item-1=redo", "item-2=done"]);
  assert.match(items[0].evidence, /earlier walk \(round 0\).*#1 the banner shows: FAILED/);
  assert.deepEqual(statuses(walkedCycle({ fixRound: true, rewalk: "- #1 the banner shows: passed (re-walk, round 1)" })), { "item-1": "done", "item-2": "done" });
});

test("an on-device failure stays done on the first walk, and when the user carried it over instead of fixing it", () => {
  assert.deepEqual(statuses(walkedCycle()), { "item-1": "done", "item-2": "done" });
  assert.deepEqual(statuses(walkedCycle({ fixRound: true, decision: "accept" })), { "item-1": "done", "item-2": "done" });
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

// The execution and branch-review adapters. Each cycle is a throwaway checkout whose state file, plan,
// ledger, per-task files and review rounds are written by hand; the transcript root is a fixture.
describe("the execution and branch-review adapters", () => {
  const RUN = "00000000000000a1";
  const SPEC = "docs/spec.md";
  const GATE = "node --test tests/unit/*.test.mjs";
  const INVENTORY_CLI = join(process.cwd(), "scripts/recovery-inventory.mjs");
  const LENS_CLI = join(process.cwd(), "scripts/lens-results.mjs");
  const EXECUTION_PLAN = [
    "# Fixture plan", "", `**Verification gate:** \`${GATE}\``, "",
    "### Task 1: First", "**Files:**", "- Modify: src/a.mjs", "**Evidence:** red-green", "",
    "### Task 2: Second", "**Files:**", "- Modify: src/b.mjs", "**Evidence:** red-green", "",
    "### Task 3: Third", "**Files:**", "- Modify: src/b.mjs", "**Evidence:** red-green", "",
    "### Task 4: Fourth", "**Files:**", "- Modify: src/d.mjs", "**Evidence:** red-green", "",
    "## Dispatch Map", "", "- Wave 1: Task 1, Task 2 (file-disjoint)", "- Wave 2: Task 3, Task 4 (needs Task 2 committed)", "",
  ].join("\n");
  const ledgerLine = (stamp, task, event, outcome, ref = "none") => `- [${stamp}] task=${task} event=${event} outcome=${outcome} ref=${ref}`;
  const stampAt = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  const AN_HOUR_AGO = stampAt(Date.now() - 3_600_000);

  // A cycle at `stage` with its plan, spec and sources committed, `.devcycle/` ignored, and — when
  // `ledger` is given — a ledger of those lines under a preamble naming `ledgerPlan` and `ledgerRun`.
  function recoveryCycle({ stage, ledger = null, plan = "docs/plan.md", ledgerPlan = "docs/plan.md", ledgerRun = RUN }) {
    const repo = realpathSync(makeRepo());
    writeInto(repo, ".gitignore", ".devcycle/\n");
    writeInto(repo, "docs/plan.md", EXECUTION_PLAN);
    writeInto(repo, SPEC, "# Spec\n");
    for (const file of ["src/a.mjs", "src/b.mjs", "src/d.mjs"]) writeInto(repo, file, "export {};\n");
    commitAll(repo, "fixture");
    const statePath = writeInto(repo, ".devcycle/state.md", [
      "# devcycle state", `- stage: ${stage}`, `- root: ${repo}`, "- branch: feat/x (cut from main at 0000000)",
      "- request: fixture cycle", `- plan: ${plan}`, `- spec: ${SPEC}`, "- ledger: .devcycle/ledger.md", `- run: ${RUN}`,
    ].join("\n") + "\n");
    if (ledger) writeInto(repo, ".devcycle/ledger.md", [`Plan: \`${ledgerPlan}\``, `Run: \`${ledgerRun}\``, "", ...ledger, ""].join("\n"));
    const devcycleDir = join(repo, ".devcycle");
    const ctx = { root: repo, devcycleDir, stateText: readFileSync(statePath, "utf8"), run: RUN, stage, transcript: null };
    return { repo, statePath, devcycleDir, ctx };
  }

  // The inventory as /devcycle:continue runs it: the CLI, from the cycle's root.
  function inventoryCli({ repo, statePath }) {
    const r = spawnSync(process.execPath, [INVENTORY_CLI, "--state", statePath], {
      cwd: repo, encoding: "utf8", env: { ...process.env, CLAUDE_CONFIG_DIR: makeTempDir("recovery-inventory-config-") },
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  }

  // A single-engine round directory: the lens set saved by lens-results.mjs, `recorded` lenses stored.
  function singleEngineRound(repo, { ref = "HEAD~1..HEAD", recorded = [] } = {}) {
    const payloads = makeTempDir("recovery-inventory-payloads-");
    const lens = (...args) => {
      const r = spawnSync(process.execPath, [LENS_CLI, ...args], { cwd: repo, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    };
    const payload = (name, value) => {
      const path = join(payloads, `${name}.json`);
      writeFileSync(path, JSON.stringify(value));
      return path;
    };
    const dir = ".devcycle/review/round-1";
    lens("save-lenses", "--dir", dir, "--ref", ref, "--from",
      payload("set", { lenses: [{ key: "alpha", charter: "alpha review." }, { key: "beta", charter: "beta review." }], specPath: SPEC }));
    for (const key of recorded) lens("record", "--dir", dir, "--lens", key, "--from", payload(key, { findings: [], strengths: [] }));
  }

  const OWN_ROUND = [ledgerLine(AN_HOUR_AGO, "branch", "review-round", "round 1 (single)", SPEC)];

  test("execution renders each task's ledger position: committed is done, an accepted review is re-verified by its green gate, the rest redo", () => {
    const { ctx } = recoveryCycle({ stage: "execution", ledger: [
      ledgerLine(AN_HOUR_AGO, 1, "committed", "accepted", "abc1234"),
      ledgerLine(AN_HOUR_AGO, 2, "review-verdict", "accepted"),
      ledgerLine(AN_HOUR_AGO, 3, "dispatched", "implementer retry 0", ".devcycle/briefs/3-implementer.md"),
    ] });
    assert.deepEqual(ADAPTERS.execution(ctx), [
      { id: "task-1", status: "done", evidence: "ledger: committed → done" },
      { id: "task-2", status: "re-verify", evidence: "ledger: accepted → commit", check: GATE },
      { id: "task-3", status: "redo", evidence: "ledger: dispatched → redispatch-implementer" },
      { id: "task-4", status: "redo", evidence: "ledger: not-dispatched → dispatch-implementer" },
    ]);
  });

  test("execution under a previous cycle's ledger slot lists each per-task directory present as ignored", () => {
    const { repo, ctx } = recoveryCycle({ stage: "execution", ledger: [ledgerLine(AN_HOUR_AGO, 1, "committed", "accepted", "abc1234")],
      ledgerPlan: "docs/old-plan.md" });
    writeInto(repo, ".devcycle/briefs/1-implementer.md", "old brief\n");
    writeInto(repo, ".devcycle/reports/1.md", "old report\n");
    assert.deepEqual(ADAPTERS.execution(ctx), [
      { id: ".devcycle/briefs/", status: "ignored", evidence: "previous cycle's slot" },
      { id: ".devcycle/reports/", status: "ignored", evidence: "previous cycle's slot" },
    ]);
  });

  test("execution fails open to one redo item when wave-setup cannot read the position", () => {
    const { repo, ctx } = recoveryCycle({ stage: "execution", ledger: [] });
    const [item, ...rest] = ADAPTERS.execution({ ...ctx, devcycleDir: join(repo, "no-such-dir") });
    assert.deepEqual(rest, []);
    assert.deepEqual([item.id, item.status], ["execution", "redo"]);
    assert.match(item.evidence, /^wave-setup could not read the position: /);
  });

  test("at execution each uncommitted path names the first task whose Files block holds it; elsewhere none is claimed", () => {
    const byPath = (a, b) => a.path.localeCompare(b.path);
    const dirty = (repo) => {
      writeInto(repo, "src/a.mjs", "export const a = 1;\n");
      writeInto(repo, "src/b.mjs", "export const b = 1;\n");
      writeInto(repo, "notes.txt", "scratch\n");
    };
    const execution = recoveryCycle({ stage: "execution", ledger: [] });
    dirty(execution.repo);
    const env = { CLAUDE_CONFIG_DIR: makeTempDir("recovery-inventory-config-") };
    assert.deepEqual(recoveryInventory({ statePath: execution.statePath, env }).uncommitted.sort(byPath), [
      { path: "notes.txt", task: null }, { path: "src/a.mjs", task: "1" }, { path: "src/b.mjs", task: "2" },
    ]);
    const scoping = recoveryCycle({ stage: "scoping" });
    dirty(scoping.repo);
    assert.deepEqual(recoveryInventory({ statePath: scoping.statePath, env }).uncommitted.sort(byPath), [
      { path: "notes.txt", task: null }, { path: "src/a.mjs", task: null }, { path: "src/b.mjs", task: null },
    ]);
  });

  test("a plan: path outside the cycle's root reads as no plan, so no uncommitted path is claimed", () => {
    const outside = writeInto(makeTempDir("recovery-inventory-outside-"), "plan.md", EXECUTION_PLAN);
    const c = recoveryCycle({ stage: "execution", plan: outside });
    writeInto(c.repo, "src/a.mjs", "export const a = 1;\n");
    const env = { CLAUDE_CONFIG_DIR: makeTempDir("recovery-inventory-config-") };
    assert.deepEqual(recoveryInventory({ statePath: c.statePath, env }).uncommitted, [{ path: "src/a.mjs", task: null }]);
  });

  test("branch review ignores a round directory no review-round line of this cycle's spec opened", () => {
    const { repo, ctx } = recoveryCycle({ stage: "branch-review",
      ledger: [ledgerLine(AN_HOUR_AGO, "branch", "review-round", "round 1 (single)", "docs/old-spec.md")] });
    writeInto(repo, ".devcycle/review/round-1/alpha.json", "{}\n");
    assert.deepEqual(ADAPTERS["branch-review"](ctx), [{ id: "review-round-1", status: "ignored", evidence: "not this cycle's round" }]);
  });

  test("branch review ignores a round directory whose lens files are older than the line that opened it", () => {
    const { repo, ctx } = recoveryCycle({ stage: "branch-review", ledger: OWN_ROUND });
    const file = writeInto(repo, ".devcycle/review/round-1/alpha.json", "{}\n");
    const before = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(file, before, before);
    assert.deepEqual(ADAPTERS["branch-review"](ctx), [{ id: "review-round-1", status: "ignored", evidence: "not this cycle's round" }]);
  });

  test("a single-engine round reports each lens done or redo as lens-results missing gives them", () => {
    const c = recoveryCycle({ stage: "branch-review", ledger: OWN_ROUND });
    singleEngineRound(c.repo, { recorded: ["alpha"] });
    assert.deepEqual(inventoryCli(c).items, [
      { id: "review-round-1-lens-alpha", status: "done", evidence: "round-1: a current result is stored" },
      { id: "review-round-1-lens-beta", status: "redo", evidence: "round-1: no current result; single dispatches it again" },
    ]);
  });

  test("a single-engine round whose saved ref no longer resolves is one redo item", () => {
    const c = recoveryCycle({ stage: "branch-review", ledger: OWN_ROUND });
    singleEngineRound(c.repo, { ref: "HEAD~1..gone-branch" });
    const items = inventoryCli(c).items;
    assert.deepEqual(items.map(({ id, status }) => ({ id, status })), [{ id: "review-round-1", status: "redo" }]);
    assert.match(items[0].evidence, /"gone-branch" does not resolve to a commit/);
  });

  test("a panel round is redo with its lens file count, a round opened after a verdict takes the next number, and a logged refutation is done", () => {
    const { repo, devcycleDir, ctx } = recoveryCycle({ stage: "branch-review", ledger: [
      ...OWN_ROUND,
      ledgerLine(AN_HOUR_AGO, "branch", "review-verdict", "rejected (2 blocking)", SPEC),
      ledgerLine(AN_HOUR_AGO, "branch", "review-round", "round 2 (panel)", SPEC),
    ] });
    for (const name of ["_args.json", "alpha.json", "_refutation.json"]) writeInto(repo, `.devcycle/review/round-1/${name}`, "{}\n");
    for (const name of ["_args.json", "alpha.json", "beta.json"]) writeInto(repo, `.devcycle/review/round-2/${name}`, "{}\n");
    mkdirSync(join(repo, ".devcycle/review/notes"));
    logStep(devcycleDir, { run: RUN, stage: "branch-review", key: "refutation-1", ref: ".devcycle/review/round-1" });
    assert.deepEqual(ADAPTERS["branch-review"](ctx), [
      { id: "review-round-1", status: "redo", evidence: "1 lens result file on disk; the panel resumes the missing lenses itself" },
      { id: "review-round-2", status: "redo", evidence: "2 lens result files on disk; the panel resumes the missing lenses itself" },
      { id: "refutation-1", status: "done", evidence: "stage-log refutation-1" },
    ]);
  });
});
