import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { makeFakeBin, makeRepo, commitAll, writeInto, sh } from "./helpers.mjs";
import {
  LEG_CAP, classifyLeg, pickAnswer, legArgs, parseLeg, runEntryArm, collectTranscripts, cutClone, planPrompt,
} from "../../scripts/plan-bench-pass.mjs";

const SCRIPT = new URL("../../scripts/plan-bench.mjs", import.meta.url).pathname;
const state = (rows) => `# devcycle state\n${Object.entries(rows).map(([k, v]) => `- ${k}: ${v}`).join("\n")}\n`;
const leg = (text, isError = false) => ({ isError, text });
const result = (over) => JSON.stringify({ type: "result", session_id: "s1", total_cost_usd: 0.5, result: "ok", is_error: false, permission_denials: [], ...over });

test("classifyLeg: a plan past planning is done, a planning handoff with no plan is a NO-GO, anything else a question", () => {
  const plan = (rows, l = leg("text")) => classifyLeg({ phase: "plan", stateText: state(rows), leg: l });
  assert.equal(plan({ stage: "execution", plan: "docs/p.md", handoff: "ready 2026-11-19T00:00:00Z" }), "done");
  assert.equal(plan({ stage: "execution", plan: "none" }), "question");
  assert.equal(plan({ stage: "planning", plan: "none", handoff: "ready 2026-11-19T00:00:00Z" }), "no-go");
  assert.equal(plan({ stage: "scoping", plan: "none", handoff: "pending 2026-11-19T00:00:00Z" }), "question");
  assert.equal(classifyLeg({ phase: "plan", stateText: "", leg: leg("Which?") }), "question");
  assert.equal(plan({ stage: "execution", plan: "docs/p.md" }, leg(null)), "error");
  assert.equal(plan({ stage: "execution", plan: "docs/p.md" }, leg("boom", true)), "error");
});

test("classifyLeg: execution is done past the execution stage, a ready handoff inside it is next", () => {
  const exec = (rows) => classifyLeg({ phase: "execute", stateText: state(rows), leg: leg("text") });
  assert.equal(exec({ stage: "branch-review", handoff: "ready 2026-11-19T00:00:00Z" }), "done");
  assert.equal(exec({ stage: "execution", handoff: "ready 2026-11-19T00:00:00Z" }), "next");
  assert.equal(exec({ stage: "execution", handoff: "pending 2026-11-19T00:00:00Z" }), "question");
});

test("pickAnswer takes the first unused case-insensitive match", () => {
  const answers = [{ match: "triage", reply: "Confirm." }, { match: "whitespace", reply: "Trim." }, { match: "triage", reply: "Again." }];
  assert.equal(pickAnswer(answers, new Set(), "TRIAGE: confirm?"), 0);
  assert.equal(pickAnswer(answers, new Set([0]), "triage again?"), 2);
  assert.equal(pickAnswer(answers, new Set([0, 2]), "triage again?"), -1);
  assert.equal(pickAnswer(answers, new Set(), "Trim surrounding WHITESPACE?"), 1);
});

test("legArgs is the driver's headless flag set plus the settings, resume and spend cap", () => {
  const settings = { pluginConfigs: { "devcycle@inline": { options: { planningStrategy: "inline" } } } };
  assert.deepEqual(legArgs({ prompt: "Confirm.", resume: "s1", pluginDir: "/p", settings, model: "claude-opus-5-5", maxBudgetUsd: 12.345 }), [
    "-p", "Confirm.", "--resume", "s1", "--plugin-dir", "/p", "--settings", JSON.stringify(settings),
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--model", "claude-opus-5-5", "--max-budget-usd", "12.35",
    "--permission-mode", "auto", "--output-format", "stream-json", "--verbose",
  ]);
  assert.equal(legArgs({ prompt: "x", resume: null, pluginDir: "/p", settings: {}, model: "m", maxBudgetUsd: 1 }).includes("--resume"), false);
});

test("parseLeg reads the last result event, and a missing one is an error carrying the init session", () => {
  const out = [JSON.stringify({ type: "system", subtype: "init", session_id: "s0" }), "not json",
    result({ session_id: "s1", total_cost_usd: 1.25, result: "Question?", permission_denials: [{}, {}] })].join("\n");
  assert.deepEqual(parseLeg(out), { sessionId: "s1", costUsd: 1.25, text: "Question?", isError: false, denials: 2 });
  assert.deepEqual(parseLeg(JSON.stringify({ type: "system", subtype: "init", session_id: "s0" })),
    { sessionId: "s0", costUsd: 0, text: null, isError: true, denials: 0 });
});

// A scripted replay: each leg returns its stdout and leaves the state text the next readState() sees.
function scripted(steps) {
  const calls = [];
  let current = "";
  return {
    calls,
    spawnLeg: (args) => {
      const step = steps[calls.length];
      calls.push(args);
      current = step.state;
      return result({ session_id: step.sid ?? "s1", total_cost_usd: step.cost ?? 0.5, result: step.text ?? "text" });
    },
    readState: () => current,
  };
}

const ANSWERS = [{ match: "triage", reply: "Confirm." }];
const PLANNED = state({ stage: "execution", plan: "docs/p.md", handoff: "ready 2026-11-19T00:00:00Z" });
const ASKING = state({ stage: "scoping", plan: "none", handoff: "pending 2026-11-19T00:00:00Z" });

test("runEntryArm answers the triage gate on the same session, then stops at the plan", () => {
  const s = scripted([{ state: ASKING, text: "Triage: confirm?" }, { state: PLANNED }]);
  const r = runEntryArm({ execute: false, prompt: "/devcycle:cycle go", answers: ANSWERS, budgetUsd: 10, ...s });
  assert.equal(r.outcome, "planned");
  assert.equal(r.usd, 1);
  assert.deepEqual(s.calls.map(({ prompt, resume }) => [prompt, resume]), [["/devcycle:cycle go", null], ["Confirm.", "s1"]]);
  assert.deepEqual(r.legs.map((l) => l.verdict), ["question", "done"]);
  assert.equal(s.calls[1].maxBudgetUsd, 9.5);
});

test("runEntryArm runs fresh /devcycle:continue legs through execution when the entry executes", () => {
  const s = scripted([
    { state: PLANNED, sid: "s1" },
    { state: state({ stage: "execution", handoff: "ready 2026-11-19T00:00:00Z" }), sid: "s2" },
    { state: state({ stage: "branch-review", handoff: "ready 2026-11-19T00:00:00Z" }), sid: "s3" },
  ]);
  const r = runEntryArm({ execute: true, prompt: "go", answers: ANSWERS, budgetUsd: 10, ...s });
  assert.equal(r.outcome, "executed");
  assert.deepEqual(s.calls.map(({ prompt, resume }) => [prompt, resume]), [["go", null], ["/devcycle:continue", null], ["/devcycle:continue", null]]);
  assert.deepEqual(r.legs.map((l) => [l.phase, l.verdict]), [["plan", "done"], ["execute", "next"], ["execute", "done"]]);
});

test("runEntryArm ends on a NO-GO, an unanswered gate, an error, the budget and the leg cap", () => {
  const noGo = scripted([{ state: state({ stage: "planning", plan: "none", handoff: "ready 2026-11-19T00:00:00Z" }), text: "NO-GO: x" }]);
  assert.equal(runEntryArm({ execute: false, prompt: "go", answers: ANSWERS, budgetUsd: 10, ...noGo }).outcome, "no-go");
  const ask = scripted([{ state: ASKING, text: "Which colour?" }]);
  assert.deepEqual(runEntryArm({ execute: false, prompt: "go", answers: ANSWERS, budgetUsd: 10, ...ask }).question, "Which colour?");
  const broken = { spawnLeg: () => "", readState: () => "" };
  assert.equal(runEntryArm({ execute: false, prompt: "go", answers: ANSWERS, budgetUsd: 10, ...broken }).outcome, "error");
  const pricey = scripted([{ state: ASKING, text: "Triage?", cost: 3 }, { state: ASKING, text: "Triage?" }]);
  const b = runEntryArm({ execute: false, prompt: "go", answers: [...ANSWERS, ...ANSWERS], budgetUsd: 2, ...pricey });
  assert.deepEqual([b.outcome, b.legs.length], ["budget-stop", 1]);
  const loop = scripted(Array.from({ length: LEG_CAP }, () => ({ state: ASKING, text: "triage" })));
  const many = Array.from({ length: LEG_CAP }, () => ANSWERS[0]);
  assert.deepEqual([runEntryArm({ execute: false, prompt: "go", answers: many, budgetUsd: 100, ...loop }).outcome, loop.calls.length], ["leg-cap", LEG_CAP]);
});

test("collectTranscripts copies each session's transcript and subagent directory under its project dir", () => {
  const root = makeTempDir("plan-bench-projects-");
  writeInto(root, "-tmp-a/s1.jsonl", "{}\n");
  writeInto(root, "-tmp-a/s1/subagents/agent-x.jsonl", "{}\n");
  writeInto(root, "-tmp-b/s2.jsonl", "{}\n");
  const dest = makeTempDir("plan-bench-corpus-");
  assert.equal(collectTranscripts({ projectsRoot: root, sessionIds: ["s1", "s1", null, "s2", "gone"], dest }), 2);
  for (const p of ["-tmp-a/s1.jsonl", "-tmp-a/s1/subagents/agent-x.jsonl", "-tmp-b/s2.jsonl"]) assert.ok(existsSync(join(dest, p)), p);
});

test("cutClone detaches a clone at baseSha with the spec copied in, leaving the source repo's branches alone", () => {
  const repo = makeRepo();
  writeInto(repo, "a.txt", "one\n");
  commitAll(repo, "one");
  const base = sh("git", ["rev-parse", "HEAD"], { cwd: repo }).trim();
  writeInto(repo, "a.txt", "two\n");
  commitAll(repo, "two");
  const specDir = makeTempDir("plan-bench-spec-");
  const spec = writeInto(specDir, "s-design.md", "# spec\n");
  const { dir, specRel } = cutClone({ repoPath: repo, baseSha: base, specPath: spec, parent: makeTempDir("plan-bench-") });
  assert.equal(specRel, "docs/superpowers/specs/s-design.md");
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "one\n");
  assert.equal(readFileSync(join(dir, specRel), "utf8"), "# spec\n");
  sh("git", ["switch", "-qc", "feat/x"], { cwd: dir });
  assert.equal(sh("git", ["branch", "--list", "feat/x"], { cwd: repo }).trim(), "");
  assert.equal(planPrompt(specRel), "/devcycle:cycle Plan the approved spec at docs/superpowers/specs/s-design.md. It is approved: enter planning against it and stop at the planning handoff.");
});

// A fake `claude`: `plugin list --json` prints an empty list; a first -p leg asks the triage gate; a
// --resume leg writes a finished plan's state and a transcript under CLAUDE_CONFIG_DIR/projects.
const FAKE_CLAUDE = `
const { appendFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
appendFileSync(process.env.PB_STUB_LOG, JSON.stringify({ args, runs: process.env.DEVCYCLE_RUNS_DIR, ceiling: process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS }) + "\\n");
if (args[0] === "plugin") { console.log("[]"); process.exit(0); }
mkdirSync(".devcycle", { recursive: true });
const resumed = args.includes("--resume");
writeFileSync(".devcycle/state.md", resumed
  ? "- stage: execution\\n- plan: docs/p.md\\n- handoff: ready 2026-11-19T00:00:00Z\\n"
  : "- stage: scoping\\n- plan: none\\n- handoff: pending 2026-11-19T00:00:00Z\\n");
const project = join(process.env.CLAUDE_CONFIG_DIR, "projects", "-fake");
mkdirSync(project, { recursive: true });
writeFileSync(join(project, "sid-1.jsonl"), "{}\\n");
console.log(JSON.stringify({ type: "result", session_id: "sid-1", total_cost_usd: 0.25, result: resumed ? "Planned." : "Triage: confirm?", is_error: false, permission_denials: [] }));
`;

function benchRepo() {
  const root = makeRepo();
  const spec = writeInto(root, "docs/superpowers/specs/s-design.md", "# spec\n");
  commitAll(root, "spec");
  const baseSha = sh("git", ["rev-parse", "HEAD"], { cwd: root }).trim();
  writeInto(root, ".devcycle/plan-bench/manifest.json", JSON.stringify({ entries: [
    { id: "small-1", size: "small", repoPath: root, baseSha, specPath: spec, tasks: 1 },
  ] }));
  return root;
}

const cli = (args, cwd, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
const token = (stdout) => /^go-ahead: ([0-9a-f]{12})$/m.exec(stdout)?.[1];

test("cli run prints the estimate and refuses without the matching go-ahead (exit 3), spawning nothing", () => {
  const root = benchRepo();
  const log = join(makeTempDir("plan-bench-log-"), "calls.jsonl");
  const bin = join(makeFakeBin("claude", FAKE_CLAUDE), "claude");
  const r = cli(["run", "--claude", bin], root, { PB_STUB_LOG: log });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stdout, /^estimate: \$6\.70 for pass 1/m);
  assert.match(r.stdout, /^no go-ahead: /m);
  const wrong = cli(["run", "--claude", bin, "--go-ahead", "000000000000"], root, { PB_STUB_LOG: log });
  assert.equal(wrong.status, 3);
  assert.equal(existsSync(log), false, "no claude call before a go-ahead");
});

test("cli run refuses past --budget (exit 2) and refuses the real claude under node --test (exit 1)", () => {
  const root = benchRepo();
  assert.equal(cli(["run", "--budget", "1"], root).status, 2);
  const est = cli(["estimate"], root);
  const r = cli(["run", "--go-ahead", token(est.stdout)], root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing to launch the real claude under node --test/);
});

test("cli run with a go-ahead replays each arm through the gate and collects its artifacts", () => {
  const root = benchRepo();
  const config = makeTempDir("plan-bench-config-");
  const log = join(makeTempDir("plan-bench-log-"), "calls.jsonl");
  const bin = join(makeFakeBin("claude", FAKE_CLAUDE), "claude");
  const env = { PB_STUB_LOG: log, CLAUDE_CONFIG_DIR: config };
  const est = cli(["estimate"], root, env);
  const r = cli(["run", "--claude", bin, "--go-ahead", token(est.stdout)], root, env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^small-1 status-quo: planned, \$0\.50, 2 legs$/m);
  assert.match(r.stdout, /^small-1 inline: planned, \$0\.50, 2 legs$/m);
  const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const legs = calls.filter((c) => c.args[0] === "-p");
  assert.equal(legs.length, 4);
  assert.equal(legs[1].args[legs[1].args.indexOf("--resume") + 1], "sid-1");
  assert.equal(legs[1].args[1], "Confirm: enter planning against the approved spec as a feature. For any other question, take the option you recommend.");
  const settings = JSON.parse(legs[2].args[legs[2].args.indexOf("--settings") + 1]);
  assert.equal(settings.pluginConfigs["devcycle@inline"].options.planningStrategy, "inline");
  assert.equal(legs[0].ceiling, "0");
  const out = join(root, ".devcycle/plan-bench/passes/1/small-1--inline");
  assert.equal(legs[2].runs, join(out, "runs"));
  for (const f of ["leg-1.jsonl", "leg-2.jsonl", "state.md", "outcome.json", "corpus/-fake/sid-1.jsonl"]) assert.ok(existsSync(join(out, f)), f);
  assert.equal(JSON.parse(readFileSync(join(out, "outcome.json"), "utf8")).outcome, "planned");
});
