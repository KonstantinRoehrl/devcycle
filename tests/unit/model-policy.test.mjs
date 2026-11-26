import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  POLICY_PATH, ROLES, ceilingFrom, dispatchAlias, fastTierId, implementerSignals, loadPolicy, resolveRole, reviewerSignals,
} from "../../scripts/model-policy.mjs";

const SCRIPT = new URL("../../scripts/model-policy.mjs", import.meta.url).pathname;
const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const HAIKU = "claude-haiku-5-5";
const FABLE = "claude-fable-5-2";
const policy = loadPolicy();
const quiet = { files: 3, deps: "none", stepsUnspecified: false, priorRejected: false };
const role = (name, opts) => resolveRole(name, { policy, ...opts });
const shape = (r) => [r.model, r.dispatch, r.tier, r.outcome];

test("the policy file holds every role, moves today's limits verbatim and dispatches by alias", () => {
  assert.ok(existsSync(POLICY_PATH));
  assert.deepEqual(Object.keys(policy.roles).sort(), [...ROLES].sort());
  assert.equal(policy.dispatchForm, "alias");
  assert.equal(policy.fastFamily, "sonnet");
  assert.deepEqual(policy.roles.implementer.limits, { maxFiles: 5 });
  assert.deepEqual(policy.roles["task-reviewer"].limits, { maxLines: 400, maxFiles: 5 });
  assert.deepEqual(policy.roles.drafter.limits, { maxFiles: 5 });
  const knobs = Object.fromEntries(ROLES.map((r) => [r, policy.roles[r].knob]));
  assert.deepEqual(Object.entries(knobs).filter(([, k]) => k), [
    ["implementer", "implementerModel"], ["task-reviewer", "taskReviewerModel"],
    ["branch-review", "branchReviewModel"], ["walkthrough", "walkthroughModel"],
  ]);
  for (const r of ROLES) {
    assert.equal(typeof policy.roles[r].layer, "string", r);
    assert.equal(typeof policy.roles[r].default, "string", r);
    assert.doesNotMatch(policy.roles[r].layer + policy.roles[r].default, /\|/, `${r}: a pipe breaks the rendered table`);
    assert.equal(policy.roles[r].effort, ["starter", "driver"].includes(r) ? null : "inherit", r);
  }
});

test("fastTierId: the newest priced Sonnet at or below the ceiling, the ceiling itself below Sonnet, null when unranked", () => {
  assert.equal(fastTierId(OPUS), SONNET);
  assert.equal(fastTierId("claude-sonnet-5"), SONNET);
  assert.equal(fastTierId(HAIKU), HAIKU);
  assert.equal(fastTierId(FABLE), null);
  assert.equal(fastTierId("unknown"), null);
});

test("dispatchAlias names the family word the Agent tool accepts", () => {
  assert.equal(dispatchAlias(OPUS), "opus");
  assert.equal(dispatchAlias("us.anthropic.claude-sonnet-5-5-v1:0"), "sonnet");
  assert.equal(dispatchAlias(HAIKU), "haiku");
  assert.equal(dispatchAlias(FABLE), "fable");
  assert.equal(dispatchAlias("claude-mythos-1"), null);
  assert.equal(dispatchAlias("unknown"), null);
  assert.equal(dispatchAlias(null), null);
});

test("ceilingFrom: an auto drive row's model, then --orchestrator, then the transcript, else unknown", () => {
  const row = `auto model=${OPUS} effort=high opted=2026-11-26T00:00:00Z via=answer`;
  assert.deepEqual(ceilingFrom({ driveRow: row, orchestrator: SONNET, transcriptModel: () => HAIKU }), { ceiling: OPUS, driven: true });
  assert.deepEqual(ceilingFrom({ driveRow: `manual model=${OPUS}`, orchestrator: SONNET, transcriptModel: () => HAIKU }), { ceiling: SONNET, driven: false });
  assert.deepEqual(ceilingFrom({ driveRow: "auto opted=2026-11-26T00:00:00Z via=knob", transcriptModel: () => HAIKU }), { ceiling: HAIKU, driven: false });
  assert.deepEqual(ceilingFrom({ transcriptModel: () => { throw new Error("no transcript"); } }), { ceiling: "unknown", driven: false });
  assert.deepEqual(ceilingFrom({ transcriptModel: () => "" }), { ceiling: "unknown", driven: false });
  assert.deepEqual(ceilingFrom(), { ceiling: "unknown", driven: false });
});

test("signals: an implementer's fire past its limits; a reviewer's are null without a stat", () => {
  assert.deepEqual(implementerSignals(quiet, policy), []);
  assert.deepEqual(implementerSignals({}, policy), []);
  assert.deepEqual(implementerSignals({ files: 6, deps: "Tasks 1+3 committed", stepsUnspecified: true, priorRejected: true }, policy),
    ["files=6", "deps=Tasks 1+3 committed", "steps=unspecified", "retry=prior-rejection"]);
  assert.equal(reviewerSignals(null, policy), null);
  assert.deepEqual(reviewerSignals({ lines: 400, files: 5 }, policy), []);
  assert.deepEqual(reviewerSignals({ lines: 401, files: 6 }, policy), ["lines=401", "files=6"]);
});

test("the Node driver resolves to no model and the starter to the user's own; neither carries an effort", () => {
  assert.deepEqual(role("driver", { ceiling: OPUS }), { role: "driver", model: null, dispatch: null, effort: null, tier: "none", outcome: "model none (driver: model-free)" });
  assert.deepEqual(role("starter", { ceiling: OPUS }), { role: "starter", model: null, dispatch: null, effort: null, tier: "user", outcome: "model user (starter)" });
});

test("the coordinator runs the fast tier under an Opus-class ceiling and the ceiling itself at or below it", () => {
  assert.deepEqual(role("coordinator", { ceiling: OPUS, driven: true }),
    { role: "coordinator", model: SONNET, dispatch: null, effort: "inherit", tier: "fast", outcome: `model ${SONNET} (coordinator: fast tier under ${OPUS})` });
  for (const ceiling of [SONNET, "claude-sonnet-5", HAIKU, FABLE])
    assert.deepEqual(role("coordinator", { ceiling, driven: true }),
      { role: "coordinator", model: ceiling, dispatch: null, effort: "inherit", tier: "session", outcome: `model ${ceiling} (coordinator: ceiling)` }, ceiling);
});

test("an implementer with no signal runs the fast tier, named, in both modes", () => {
  for (const driven of [false, true])
    assert.deepEqual(role("implementer", { ceiling: OPUS, driven, facts: quiet }),
      { role: "implementer", model: SONNET, dispatch: "sonnet", effort: "inherit", tier: "fast", outcome: `model fast:${SONNET} (auto: files=3, deps=none, steps=specified)` });
  assert.equal(role("implementer", { ceiling: OPUS, facts: { ...quiet, stepsUnspecified: false } }).outcome, `model fast:${SONNET} (auto: files=3, deps=none, steps=specified)`);
});

test("an escalated implementer: no override interactive, the ceiling named when driven", () => {
  const facts = { files: 9, deps: "Task 2", stepsUnspecified: true, priorRejected: true };
  assert.deepEqual(shape(role("implementer", { ceiling: OPUS, facts })),
    [null, null, "session", "model session (auto: escalated on files=9, deps=Task 2, steps=unspecified, retry=prior-rejection)"]);
  assert.deepEqual(shape(role("implementer", { ceiling: OPUS, driven: true, facts: { ...quiet, files: 9 } })),
    [OPUS, "opus", "session", `model session:${OPUS} (auto: escalated on files=9)`]);
});

test("where the session tier is the fast tier's family, an escalation records no escalated text", () => {
  for (const driven of [false, true]) {
    const r = role("implementer", { ceiling: SONNET, driven, facts: { ...quiet, files: 9 } });
    assert.deepEqual(shape(r), [SONNET, "sonnet", "fast", `model fast:${SONNET} (auto: session tier is the fast tier; signals files=9)`]);
    assert.doesNotMatch(r.outcome, /escalated/);
  }
  const reviewer = role("task-reviewer", { ceiling: SONNET, facts: { stat: { lines: 401, files: 2 } } });
  assert.equal(reviewer.outcome, `model fast:${SONNET} (auto: session tier is the fast tier; signals lines=401)`);
  assert.equal(role("implementer", { ceiling: HAIKU, facts: { ...quiet, files: 9 } }).outcome,
    `model fast:${HAIKU} (auto: session tier is the fast tier; signals files=9)`);
});

test("an unrankable ceiling has no fast tier: a dispatch falls to the session tier as model-routing.md says", () => {
  assert.deepEqual(shape(role("implementer", { ceiling: FABLE, facts: quiet })), [null, null, "session", `model session (ceiling: ${FABLE} unranked)`]);
  assert.deepEqual(shape(role("implementer", { ceiling: FABLE, driven: true, facts: quiet })), [FABLE, "fable", "session", `model session (ceiling: ${FABLE} unranked)`]);
  assert.deepEqual(shape(role("task-reviewer", { ceiling: "unknown", facts: { stat: { lines: 1, files: 1 } } })),
    [null, null, "session", "model session (ceiling: unknown unranked)"]);
  assert.equal(role("task-reviewer", { ceiling: "unknown", facts: { stat: null } }).outcome, "model session (auto: no file list)");
});

test("a task reviewer: fast within 400 lines and 5 files, session past either, session with no file list", () => {
  assert.deepEqual(role("task-reviewer", { ceiling: OPUS, facts: { stat: { lines: 400, files: 5 } } }),
    { role: "task-reviewer", model: SONNET, dispatch: "sonnet", effort: "inherit", tier: "fast", outcome: `model fast:${SONNET} (auto: lines=400, files=5)` });
  assert.deepEqual(shape(role("task-reviewer", { ceiling: OPUS, facts: { stat: { lines: 520, files: 7 } } })),
    [null, null, "session", "model session (auto: escalated on lines=520, files=7)"]);
  assert.deepEqual(shape(role("task-reviewer", { ceiling: OPUS, facts: { stat: null } })), [null, null, "session", "model session (auto: no file list)"]);
  assert.deepEqual(shape(role("task-reviewer", { ceiling: OPUS, driven: true, facts: { stat: null } })),
    [OPUS, "opus", "session", `model session:${OPUS} (auto: no file list)`]);
  assert.deepEqual(shape(role("task-reviewer", { ceiling: OPUS, driven: true, facts: { stat: { lines: 401, files: 1 } } })),
    [OPUS, "opus", "session", `model session:${OPUS} (auto: escalated on lines=401)`]);
});

test("a set knob resolves through model-pool under the ceiling, its outcome verbatim", () => {
  assert.deepEqual(role("implementer", { ceiling: OPUS, knob: SONNET, facts: quiet }),
    { role: "implementer", model: SONNET, dispatch: "sonnet", effort: "inherit", tier: "knob", outcome: `model ${SONNET} (pinned)` });
  assert.equal(role("implementer", { ceiling: SONNET, knob: OPUS, facts: quiet }).outcome, `model ${SONNET} (pinned, clamped from ${OPUS})`);
  assert.equal(role("task-reviewer", { ceiling: OPUS, knob: `${HAIKU},${SONNET}`, facts: { stat: { lines: 401, files: 1 } } }).outcome, `model ${SONNET} (pooled: rung 2/2)`);
  assert.equal(role("task-reviewer", { ceiling: OPUS, knob: `${HAIKU},${SONNET}`, facts: { stat: null } }).outcome, `model ${SONNET} (pooled: rung 2/2)`);
  assert.equal(role("branch-review", { ceiling: OPUS, knob: `${HAIKU},${SONNET},${OPUS}` }).outcome, `model ${OPUS} (pooled: rung 3/3)`);
  assert.deepEqual(shape(role("walkthrough", { ceiling: FABLE, knob: SONNET })), [null, null, "knob", `model session (ceiling: ${FABLE} unranked)`]);
  assert.deepEqual(shape(role("walkthrough", { ceiling: FABLE, driven: true, knob: SONNET })), [FABLE, "fable", "knob", `model session (ceiling: ${FABLE} unranked)`]);
  assert.equal(role("implementer", { ceiling: OPUS, knob: "auto", facts: quiet }).tier, "fast");
  assert.equal(role("implementer", { ceiling: OPUS, knob: "${user_config.implementerModel}", facts: quiet }).tier, "fast");
});

test("branch review and walkthrough take the session tier, named when driven", () => {
  assert.deepEqual(role("branch-review", { ceiling: OPUS }),
    { role: "branch-review", model: null, dispatch: null, effort: "inherit", tier: "session", outcome: "model session (auto)" });
  assert.deepEqual(shape(role("walkthrough", { ceiling: OPUS, driven: true })), [OPUS, "opus", "session", `model session:${OPUS} (auto)`]);
});

test("planning roles always name their model: research, spike and checker fast; the planning session the ceiling", () => {
  for (const name of ["research", "spike", "checker"])
    assert.deepEqual(role(name, { ceiling: OPUS }),
      { role: name, model: SONNET, dispatch: "sonnet", effort: "inherit", tier: "fast", outcome: `model fast:${SONNET} (${name}: fast tier)` });
  assert.deepEqual(shape(role("planning-session", { ceiling: OPUS })), [OPUS, "opus", "session", `model ${OPUS} (planning-session: session tier)`]);
  assert.deepEqual(shape(role("spike", { ceiling: FABLE })), [FABLE, "fable", "session", `model ${FABLE} (spike: session tier, no fast tier under ${FABLE})`]);
  assert.deepEqual(shape(role("checker", { ceiling: "unknown" })), [null, null, "session", "model unknown (checker: session tier, no fast tier under unknown)"]);
});

test("a drafter escalates on a code-pinned task, a new abstraction, Files > 5 or cross-package scope; a repair keeps its drafter's tier", () => {
  const plain = { codePinned: false, newAbstraction: false, maxFiles: 5, crossPackage: false };
  assert.deepEqual(shape(role("drafter", { ceiling: OPUS, facts: plain })), [SONNET, "sonnet", "fast", `model fast:${SONNET} (drafter: fast tier)`]);
  assert.deepEqual(shape(role("drafter", { ceiling: OPUS, facts: { ...plain, codePinned: true, maxFiles: 6 } })),
    [OPUS, "opus", "session", `model ${OPUS} (drafter: session tier on code-pinned, files=6)`]);
  assert.equal(role("drafter", { ceiling: OPUS, facts: { ...plain, newAbstraction: true, crossPackage: true } }).outcome,
    `model ${OPUS} (drafter: session tier on new-abstraction, cross-package)`);
  assert.deepEqual(shape(role("repair", { ceiling: OPUS, facts: { drafterTier: "session" } })), [OPUS, "opus", "session", `model ${OPUS} (repair: drafter's session tier)`]);
  assert.deepEqual(shape(role("repair", { ceiling: OPUS, facts: { drafterTier: "fast" } })), [SONNET, "sonnet", "fast", `model fast:${SONNET} (repair: drafter's fast tier)`]);
  assert.equal(role("repair", { ceiling: OPUS }).tier, "session");
});

test("an unknown role throws, naming the roles", () => {
  assert.throws(() => role("pilot", { ceiling: OPUS }), /unknown role "pilot" — one of starter, driver, coordinator/);
});

test("the CLI prints resolveRole's result as one JSON line and exits 2 on a usage error", () => {
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  const ok = run(["--role", "implementer", "--ceiling", OPUS, "--driven", "--facts", JSON.stringify({ ...quiet, files: 9 })]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), role("implementer", { ceiling: OPUS, driven: true, facts: { ...quiet, files: 9 } }));
  assert.equal(ok.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(run(["--role", "branch-review", "--ceiling", OPUS, "--knob", SONNET]).stdout).outcome, `model ${SONNET} (pinned)`);
  for (const bad of [
    ["--role", "pilot", "--ceiling", OPUS], ["--role", "driver"], ["--ceiling", OPUS],
    ["--role", "driver", "--ceiling", OPUS, "--sigals", "1"], ["--role", "spike", "--ceiling", OPUS, "--facts", "{not json"],
  ]) {
    const r = run(bad);
    assert.equal(r.status, 2, bad.join(" "));
    assert.match(r.stderr, /^model-policy: /, bad.join(" "));
  }
});
