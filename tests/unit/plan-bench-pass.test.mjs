import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { makeFakeBin, makeRepo, commitAll, writeInto, sh } from "./helpers.mjs";
import {
  LEG_CAP, classifyLeg, pickAnswer, legArgs, parseLeg, runEntryArm, runPass, collectTranscripts, cutClone, planPrompt,
} from "../../scripts/plan-bench-pass.mjs";
import { DEFAULT_ANSWERS } from "../../scripts/plan-bench.mjs";

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

test("a standing answer keeps answering later gates; a per-gate answer is consumed once", () => {
  const answers = [{ match: "triage", reply: "Confirm.", standing: true }, { match: "cut", reply: "Take it." }];
  assert.equal(pickAnswer(answers, new Set([0]), "triage again?"), 0);
  assert.equal(pickAnswer(answers, new Set([1]), "the cut?"), -1);
});

test("runEntryArm answers two distinct gates from the one standing default answer", () => {
  const s = scripted([
    { state: ASKING, text: "Triage: confirm entry stage?" },
    { state: ASKING, text: "Spec review found 2 issues. Confirm the task cut and drafting estimate?" },
    { state: PLANNED },
  ]);
  const r = runEntryArm({ execute: false, prompt: "go", answers: DEFAULT_ANSWERS, budgetUsd: 10, ...s });
  assert.equal(r.outcome, "planned");
  assert.deepEqual(s.calls.map((c) => c.prompt), ["go", DEFAULT_ANSWERS[0].reply, DEFAULT_ANSWERS[0].reply]);
});

test("runEntryArm keeps the legs and spend of a replay whose next leg cannot launch", () => {
  let n = 0;
  const r = runEntryArm({
    execute: false, prompt: "go", answers: ANSWERS, budgetUsd: 10, readState: () => ASKING,
    spawnLeg: () => {
      if (n++) throw new Error("spawn EAGAIN");
      return result({ result: "Triage?" });
    },
  });
  assert.deepEqual([r.outcome, r.usd, r.legs.length, r.error], ["error", 0.5, 1, "spawn EAGAIN"]);
});

test("legArgs never renders a spend cap below one cent", () => {
  const cap = (maxBudgetUsd) => { const a = legArgs({ prompt: "x", resume: null, pluginDir: "/p", settings: {}, model: "m", maxBudgetUsd }); return a[a.indexOf("--max-budget-usd") + 1]; };
  assert.equal(cap(0.001), "0.01");
  assert.equal(cap(0), "0.01");
  assert.equal(cap(2.5), "2.50");
});

test("runPass records a replay that cannot start as an error and still runs the entries after it", () => {
  const good = benchRepo();
  const repoPath = good;
  const baseSha = sh("git", ["rev-parse", "HEAD"], { cwd: good }).trim();
  const entries = [
    { id: "bad-1", size: "small", repoPath, baseSha: "0123456789abcdef0123456789abcdef01234567", specPath: "docs/superpowers/specs/s-design.md", tasks: 1, execute: false },
    { id: "good-1", size: "small", repoPath, baseSha, specPath: "docs/superpowers/specs/s-design.md", tasks: 1, execute: false },
  ];
  const passDir = join(makeTempDir("plan-bench-passdir-"), "1");
  const spawned = [];
  const outcomes = runPass(
    { entries, arms: ["inline"], answers: entries.map(() => ({ prompt: null, answers: DEFAULT_ANSWERS })), budget: 50 },
    {
      passDir, pluginDir: "/p", model: "m", settingsFor: () => ({}), projectsRoot: makeTempDir("plan-bench-projects-"),
      spawn: (args, { cwd }) => {
        spawned.push(cwd);
        mkdirSync(join(cwd, ".devcycle"), { recursive: true });
        writeFileSync(join(cwd, ".devcycle", "state.md"), PLANNED);
        return result({});
      },
    },
  );
  assert.deepEqual(outcomes.map((o) => [o.id, o.outcome]), [["bad-1", "error"], ["good-1", "planned"]]);
  assert.match(outcomes[0].error, /git .*checkout/);
  assert.equal(spawned.length, 1);
  assert.equal(JSON.parse(readFileSync(join(passDir, "bad-1--inline", "outcome.json"), "utf8")).outcome, "error");
  assert.deepEqual(JSON.parse(readFileSync(join(passDir, "pass.json"), "utf8")), { replays: ["bad-1--inline", "good-1--inline"] });
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
  assert.equal(sh("git", ["remote"], { cwd: dir }).trim(), "", "the clone keeps no remote to push to");
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
if (args[0] === "plugin") {
  if (process.env.PB_PLUGIN_FAIL) process.exit(1);
  console.log("[]");
  process.exit(0);
}
if (process.env.PB_HANG) setInterval(() => {}, 1000);
else {
mkdirSync(".devcycle", { recursive: true });
const resumed = args.includes("--resume");
writeFileSync(".devcycle/state.md", resumed
  ? "- stage: execution\\n- plan: docs/p.md\\n- handoff: ready 2026-11-19T00:00:00Z\\n"
  : "- stage: scoping\\n- plan: none\\n- handoff: pending 2026-11-19T00:00:00Z\\n");
const project = join(process.env.CLAUDE_CONFIG_DIR, "projects", "-fake");
mkdirSync(project, { recursive: true });
writeFileSync(join(project, "sid-1.jsonl"), "{}\\n");
console.log(JSON.stringify({ type: "result", session_id: "sid-1", total_cost_usd: 0.25, result: resumed ? "Planned." : "Triage: confirm?", is_error: false, permission_denials: [] }));
}
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

// Every run starts with PLAN_BENCH_STUB_ONLY, so no test here can launch the real claude however the file is
// launched; an `undefined` value drops that variable from the child's environment.
function cli(args, cwd, env = {}) {
  const merged = { ...process.env, PLAN_BENCH_STUB_ONLY: "1", ...env };
  for (const [key, value] of Object.entries(merged)) if (value === undefined) delete merged[key];
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8", env: merged });
}
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

test("cli run refuses past --budget (exit 2)", () => {
  assert.equal(cli(["run", "--budget", "1"], benchRepo()).status, 2);
});

test("cli run never reaches the real claude when PLAN_BENCH_STUB_ONLY is set, even launched directly with no node --test variable", () => {
  const root = benchRepo();
  const log = join(makeTempDir("plan-bench-log-"), "calls.jsonl");
  // A claude on PATH stands in for the real one: any call to it is a call the guard let through.
  const path = `${makeFakeBin("claude", FAKE_CLAUDE)}${delimiter}${process.env.PATH}`;
  const env = { PB_STUB_LOG: log, PATH: path, NODE_TEST_CONTEXT: undefined, CLAUDE_CONFIG_DIR: makeTempDir("plan-bench-config-") };
  const est = cli(["estimate"], root, env);
  const r = cli(["run", "--go-ahead", token(est.stdout)], root, env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing to launch the real claude: PLAN_BENCH_STUB_ONLY is set; pass --claude <stub>/);
  assert.equal(existsSync(log), false, "no claude call");
  // Without the switch the same run reaches the claude on PATH: the real-run path is unchanged.
  const real = cli(["run", "--go-ahead", token(est.stdout)], root, { ...env, PLAN_BENCH_STUB_ONLY: undefined });
  assert.equal(real.status, 0, real.stderr);
  assert.ok(existsSync(log), "claude on PATH was launched");
});

test("cli run refuses (exit 1) when the plugin list cannot be read, before any leg launches", () => {
  const root = benchRepo();
  const log = join(makeTempDir("plan-bench-log-"), "calls.jsonl");
  const bin = join(makeFakeBin("claude", FAKE_CLAUDE), "claude");
  const env = { PB_STUB_LOG: log, PB_PLUGIN_FAIL: "1" };
  const est = cli(["estimate"], root, env);
  const r = cli(["run", "--claude", bin, "--go-ahead", token(est.stdout)], root, env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /plan-bench: cannot read `claude plugin list --json`.*installed devcycle would load beside the checkout/);
  const legs = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter((l) => JSON.parse(l).args[0] === "-p") : [];
  assert.equal(legs.length, 0, "no leg launched");
});

test("cli run ends a leg that outlives --leg-timeout as an error outcome naming the timeout, and carries on", () => {
  const root = benchRepo();
  const log = join(makeTempDir("plan-bench-log-"), "calls.jsonl");
  const bin = join(makeFakeBin("claude", FAKE_CLAUDE), "claude");
  const env = { PB_STUB_LOG: log, PB_HANG: "1" };
  const est = cli(["estimate"], root, env);
  const r = cli(["run", "--claude", bin, "--go-ahead", token(est.stdout), "--leg-timeout", "1"], root, env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^small-1 status-quo: error, \$0\.00, 0 legs — error: .*--leg-timeout 1/m);
  assert.match(r.stdout, /^small-1 inline: error, \$0\.00, 0 legs — error: .*--leg-timeout 1/m);
  assert.match(cli(["run", "--leg-timeout", "0"], root, env).stderr, /--leg-timeout 0: expected a positive number of seconds/);
});

test("runPass strips the driver's variables from a replay leg's environment and keeps the rest", () => {
  const repoPath = benchRepo();
  const baseSha = sh("git", ["rev-parse", "HEAD"], { cwd: repoPath }).trim();
  const entries = [{ id: "good-1", size: "small", repoPath, baseSha, specPath: "docs/superpowers/specs/s-design.md", tasks: 1, execute: false }];
  const seen = [];
  const driven = {
    PATH: "/usr/bin", KEEP: "1", DEVCYCLE_DRIVE_TOKEN: "t", DEVCYCLE_DRIVER_PLUGIN_VERSION: "0.33.0",
    DEVCYCLE_NESTED_RUN: "1", CLAUDECODE: "1", CLAUDE_EFFORT: "high",
  };
  runPass(
    { entries, arms: ["inline"], answers: [{ prompt: null, answers: DEFAULT_ANSWERS }], budget: 50 },
    {
      passDir: join(makeTempDir("plan-bench-passdir-"), "1"), pluginDir: "/p", model: "m", settingsFor: () => ({}),
      projectsRoot: makeTempDir("plan-bench-projects-"), env: driven,
      spawn: (args, { cwd, env }) => {
        seen.push(env);
        mkdirSync(join(cwd, ".devcycle"), { recursive: true });
        writeFileSync(join(cwd, ".devcycle", "state.md"), PLANNED);
        return result({});
      },
    },
  );
  assert.equal(seen.length, 1);
  for (const key of ["DEVCYCLE_DRIVE_TOKEN", "DEVCYCLE_DRIVER_PLUGIN_VERSION", "DEVCYCLE_NESTED_RUN", "CLAUDECODE", "CLAUDE_EFFORT"]) assert.equal(key in seen[0], false, key);
  assert.equal(seen[0].KEEP, "1");
  assert.match(seen[0].DEVCYCLE_RUNS_DIR, /good-1--inline[\\/]runs$/);
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
