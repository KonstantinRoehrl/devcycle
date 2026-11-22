import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { commitAll, makeFakeBin, makeRepo, sh, writeInto } from "./helpers.mjs";
import {
  ARMS, OPT_IN_ARMS, DEFAULT_TASKS, RATES, DEFAULT_ANSWERS, validateManifest, validateAnswers, estimatePass, goAheadToken,
  benchKnobs, benchSettings, preflight,
} from "../../scripts/plan-bench.mjs";
import { PLANNING_RATES, EXECUTION_RATE } from "../../scripts/plan-cost.mjs";

const SCRIPT = new URL("../../scripts/plan-bench.mjs", import.meta.url).pathname;
const entry = (over) => ({ id: "small-1", size: "small", repoPath: "/repo", baseSha: "71cc4ff", specPath: "docs/s.md", ...over });

test("the default arms are status-quo and inline, two more are opt-in, and the default task counts and rates are pinned", () => {
  assert.deepEqual(ARMS, ["status-quo", "inline"]);
  assert.deepEqual(OPT_IN_ARMS, ["grouped", "checkpointed"]);
  assert.deepEqual(DEFAULT_TASKS, { small: 3, medium: 7, large: 12 });
  assert.deepEqual(RATES, { planning: { "status-quo": 1.34, inline: 0.97, grouped: 1.11, checkpointed: 1.4 }, execution: 2.5 });
  // The rates are plan-cost's, never a second copy.
  assert.equal(RATES.planning, PLANNING_RATES);
  assert.equal(RATES.execution, EXECUTION_RATE);
});

test("validateManifest fills tasks from the size and executes medium entries by default", () => {
  const { entries, errors } = validateManifest({ entries: [entry(), entry({ id: "med-1", size: "medium" }), entry({ id: "big", size: "large", tasks: 13, execute: true })] });
  assert.deepEqual(errors, []);
  assert.deepEqual(entries.map((e) => [e.id, e.tasks, e.execute]), [["small-1", 3, false], ["med-1", 7, true], ["big", 13, true]]);
});

test("validateManifest names every bad field and drops the entry", () => {
  const { entries, errors } = validateManifest({ entries: [
    entry({ id: "Bad_Id" }), entry({ size: "huge" }), entry({ baseSha: "xyz" }), entry({ repoPath: "" }),
    entry({ tasks: 0 }), entry({ execute: "yes" }), entry(), entry(),
  ] });
  assert.equal(entries.length, 1);
  assert.deepEqual(errors, [
    "entries[0].id: expected lowercase letters, digits and dashes",
    "entries[1].size: expected one of small, medium, large",
    "entries[2].baseSha: expected a 7-40 character hex sha",
    "entries[3].repoPath: expected a non-empty string",
    "entries[4].tasks: expected a positive integer",
    "entries[5].execute: expected true or false",
    "entries[7].id: duplicate id small-1",
  ]);
  assert.deepEqual(validateManifest([]).errors, ["manifest: expected an object with an entries array"]);
});

test("validateAnswers defaults to the standing answers and rejects a bad regex", () => {
  assert.deepEqual(validateAnswers(undefined), { prompt: null, answers: DEFAULT_ANSWERS, errors: [] });
  const ok = validateAnswers({ prompt: "/devcycle:cycle go", answers: [{ match: "trim", reply: "Trim it." }] });
  assert.deepEqual(ok, { prompt: "/devcycle:cycle go", answers: [{ match: "trim", reply: "Trim it." }], errors: [] });
  assert.deepEqual(validateAnswers({ answers: [{ match: "(", reply: "x" }, { match: "a" }] }).errors,
    ["answers[0].match: not a valid regular expression", "answers[1]: expected {match, reply} strings"]);
});

test("estimatePass prices planning per arm and execution only for executing entries", () => {
  const { entries } = validateManifest({ entries: [entry(), entry({ id: "med-1", size: "medium" })] });
  const { rows, totalUsd } = estimatePass({ entries, arms: ARMS });
  assert.deepEqual(rows, [
    { id: "small-1", arm: "status-quo", tasks: 3, planningUsd: 4.02, executionUsd: 0, usd: 4.02 },
    { id: "small-1", arm: "inline", tasks: 3, planningUsd: 2.91, executionUsd: 0, usd: 2.91 },
    { id: "med-1", arm: "status-quo", tasks: 7, planningUsd: 9.38, executionUsd: 17.5, usd: 26.88 },
    { id: "med-1", arm: "inline", tasks: 7, planningUsd: 6.79, executionUsd: 17.5, usd: 24.29 },
  ]);
  assert.equal(totalUsd, 58.1);
});

test("goAheadToken is 12 hex characters and changes with any input", () => {
  const base = { manifestText: "m", answersTexts: ["a"], arms: ARMS, passId: "1", budget: 150, totalUsd: 102 };
  const t = goAheadToken(base);
  assert.match(t, /^[0-9a-f]{12}$/);
  assert.equal(goAheadToken({ ...base }), t);
  for (const over of [{ manifestText: "m2" }, { answersTexts: ["b"] }, { arms: ["inline"] }, { passId: "2" }, { budget: 100 }, { totalUsd: 92.3 }])
    assert.notEqual(goAheadToken({ ...base, ...over }), t, JSON.stringify(over));
});

test("benchKnobs pins every knob but the arm and the implementer model", () => {
  assert.deepEqual(benchKnobs("inline", { implementerModel: "claude-sonnet-5-5" }), {
    profile: "standard", gitPolicy: "local-commits-only", docTrackingPolicy: "all-local", reviewDepth: "single",
    crossModelReview: false, onDeviceGate: "auto-ok", implementerModel: "claude-sonnet-5-5", handoffNotification: "off",
    executionMode: "manual", subagentBudget: "warn", planningStrategy: "inline",
  });
});

test("benchSettings turns off every enabled plugin but superpowers and stores the knobs under devcycle@inline", () => {
  const plugins = [
    { id: "devcycle@devcycle", enabled: true, projectEnabled: false },
    { id: "superpowers@claude-plugins-official", enabled: true, projectEnabled: false },
    { id: "impeccable@impeccable", enabled: false, projectEnabled: true },
    { id: "warp@claude-code-warp", enabled: false, projectEnabled: false },
  ];
  assert.deepEqual(benchSettings({ plugins, knobs: { planningStrategy: "inline" } }), {
    enabledPlugins: { "devcycle@devcycle": false, "impeccable@impeccable": false },
    pluginConfigs: { "devcycle@inline": { options: { planningStrategy: "inline" } } },
  });
});

// A manifest entry whose repo, base sha and spec exist, so a pass over it clears the preflight.
let gitRepo;
function gitEntry(over) {
  if (!gitRepo) {
    const root = makeRepo();
    writeInto(root, "docs/s.md", "# spec\n");
    commitAll(root, "spec");
    gitRepo = { repoPath: root, baseSha: sh("git", ["rev-parse", "HEAD"], { cwd: root }).trim() };
  }
  return entry({ ...gitRepo, ...over });
}

// The environment a child plan-bench starts with: this process's, minus the drive token a driven session sets, which
// would make every `run` refuse before the behavior under test; the refusal's own test sets it back explicitly.
const undriven = (extra = {}) => ({ ...process.env, DEVCYCLE_DRIVE_TOKEN: undefined, ...extra });
const cli = (args, cwd) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8", env: undriven() });

function benchRoot(manifest) {
  const root = makeTempDir("plan-bench-root-");
  writeInto(root, ".devcycle/plan-bench/manifest.json", JSON.stringify(manifest));
  return root;
}

test("cli estimate prints the table, the estimate and a go-ahead token, exit 0 within budget", () => {
  const root = benchRoot({ entries: [gitEntry(), gitEntry({ id: "med-1", size: "medium" })] });
  const r = cli(["estimate", "--manifest", `${root}/.devcycle/plan-bench/manifest.json`], root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\| Entry \| Arm \| Tasks \| Planning \$ \| Execution \$ \| Total \$ \|$/m);
  assert.match(r.stdout, /^\| med-1 \| status-quo \| 7 \| 9\.38 \| 17\.50 \| 26\.88 \|$/m);
  assert.match(r.stdout, /^estimate: \$58\.10 for pass 1 \(budget \$150\.00\)$/m);
  assert.match(r.stdout, /^go-ahead: [0-9a-f]{12}$/m);
});

test("cli estimate prices an opt-in arm and rejects an unknown one", () => {
  const root = benchRoot({ entries: [gitEntry()] });
  const manifest = `${root}/.devcycle/plan-bench/manifest.json`;
  const ok = cli(["estimate", "--manifest", manifest, "--arms", "grouped,checkpointed"], root);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^\| small-1 \| grouped \| 3 \| 3\.33 \| 0\.00 \| 3\.33 \|$/m);
  assert.match(ok.stdout, /^\| small-1 \| checkpointed \| 3 \| 4\.20 \| 0\.00 \| 4\.20 \|$/m);
  const dropped = cli(["estimate", "--manifest", manifest, "--arms", "grouped-fork"], root);
  assert.notEqual(dropped.status, 0);
  assert.match(dropped.stderr, /unknown arm grouped-fork/);
  const bad = cli(["estimate", "--manifest", manifest, "--arms", "parallel"], root);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /unknown arm parallel; expected status-quo, inline, grouped, checkpointed/);
});

test("cli estimate refuses past --budget with exit 2 and prints no token", () => {
  const root = benchRoot({ entries: [gitEntry(), gitEntry({ id: "med-1", size: "medium" })] });
  const r = cli(["estimate", "--manifest", `${root}/.devcycle/plan-bench/manifest.json`, "--budget", "50"], root);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /^refused: the estimate exceeds --budget \$50\.00$/m);
  assert.doesNotMatch(r.stdout, /go-ahead:/);
});

test("the budget refusal names both ways forward: a smaller corpus, or an explicit --budget that is the user's call", () => {
  const root = benchRoot({ entries: [gitEntry(), gitEntry({ id: "med-1", size: "medium" }), gitEntry({ id: "big", size: "large" })] });
  const r = cli(["estimate", "--manifest", `${root}/.devcycle/plan-bench/manifest.json`, "--budget", "80"], root);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /^estimate: \$85\.82 for pass 1 \(budget \$80\.00\)$/m);
  assert.match(r.stdout, /^refused: the estimate exceeds --budget \$80\.00$/m);
  assert.match(r.stdout, /^next: either shrink the corpus \(fewer --entries, a smaller `size` or `tasks` in the manifest\), or rerun with an explicit --budget above the estimate, which is the user's decision to make$/m);
});

test("cli estimate narrows by --arms and --entries, and rejects an unknown arm, entry or bad manifest", () => {
  const root = benchRoot({ entries: [gitEntry(), gitEntry({ id: "med-1", size: "medium" })] });
  const m = `${root}/.devcycle/plan-bench/manifest.json`;
  const r = cli(["estimate", "--manifest", m, "--arms", "inline", "--entries", "small-1"], root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^estimate: \$2\.91 for pass 1/m);
  assert.equal(cli(["estimate", "--manifest", m, "--arms", "parallel"], root).status, 1);
  assert.match(cli(["estimate", "--manifest", m, "--entries", "nope"], root).stderr, /no manifest entry nope/);
  const bad = benchRoot({ entries: [gitEntry({ size: "huge" })] });
  const b = cli(["estimate", "--manifest", `${bad}/.devcycle/plan-bench/manifest.json`], bad);
  assert.equal(b.status, 1);
  assert.match(b.stderr, /entries\[0\]\.size: expected one of small, medium, large/);
  assert.equal(cli(["bogus"], root).status, 1);
});

test("the standing default answer is reusable and no per-gate answer is", () => {
  assert.ok(DEFAULT_ANSWERS.every((a) => a.standing === true));
  assert.ok(validateAnswers({ answers: [{ match: "a", reply: "b", standing: true }] }).answers.every((a) => a.standing === undefined));
});

test("preflight names each entry's missing repo, base sha, spec and a pass directory that already holds a run", () => {
  const good = gitEntry();
  const none = makeTempDir("plan-bench-none-");
  const problems = preflight({
    entries: [
      good,
      gitEntry({ id: "gone-sha", baseSha: "0123456789abcdef0123456789abcdef01234567" }),
      gitEntry({ id: "no-spec", specPath: "docs/missing.md" }),
      gitEntry({ id: "no-repo", repoPath: join(none, "absent") }),
      gitEntry({ id: "not-git", repoPath: none }),
    ],
    passDir: join(none, "pass"),
  });
  assert.equal(problems.length, 4, problems.join("\n"));
  assert.match(problems[0], /^gone-sha: baseSha 0123456 does not exist in /);
  assert.match(problems[1], /^no-spec: spec file docs\/missing\.md not found/);
  assert.match(problems[2], /^no-repo: repoPath .* is not a git repository/);
  assert.match(problems[3], /^not-git: repoPath .* is not a git repository/);
  mkdirSync(join(none, "pass", "x--inline"), { recursive: true });
  assert.match(preflight({ entries: [good], passDir: join(none, "pass") })[0], /^pass directory .* already holds a run; pick a new --pass id/);
});

const STUB = `
require("node:fs").appendFileSync(process.env.PB_STUB_LOG, process.argv.slice(2).join(" ") + "\\n");
console.log("[]");
`;

test("cli run refuses inside a driven session (DEVCYCLE_DRIVE_TOKEN), before any estimate or go-ahead token prints; estimate stays allowed", () => {
  const root = benchRoot({ entries: [gitEntry()] });
  const log = join(makeTempDir("plan-bench-log-"), "calls.jsonl");
  const bin = join(makeFakeBin("claude", STUB), "claude");
  const env = undriven({ PB_STUB_LOG: log, DEVCYCLE_DRIVE_TOKEN: "drive-token" });
  const run = spawnSync(process.execPath, [SCRIPT, "run", "--claude", bin, "--go-ahead", "000000000000"], { cwd: root, encoding: "utf8", env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /^plan-bench: run never starts inside a driven session/m);
  assert.doesNotMatch(run.stdout, /go-ahead: [0-9a-f]{12}|estimate:/);
  assert.equal(existsSync(log), false, "claude never spawned");
  const est = spawnSync(process.execPath, [SCRIPT, "estimate"], { cwd: root, encoding: "utf8", env });
  assert.equal(est.status, 0, est.stderr);
  assert.match(est.stdout, /^go-ahead: [0-9a-f]{12}$/m);
});

test("cli estimate and run refuse a manifest with a vanished base sha (exit 2), before any token or claude call", () => {
  const root = benchRoot({ entries: [gitEntry(), gitEntry({ id: "gone-sha", baseSha: "0123456789abcdef0123456789abcdef01234567" })] });
  const log = join(makeTempDir("plan-bench-log-"), "calls.jsonl");
  const bin = join(makeFakeBin("claude", STUB), "claude");
  const env = undriven({ PB_STUB_LOG: log });
  const est = spawnSync(process.execPath, [SCRIPT, "estimate"], { cwd: root, encoding: "utf8", env });
  assert.equal(est.status, 2, est.stderr);
  assert.match(est.stderr, /^plan-bench: gone-sha: baseSha 0123456 does not exist in /m);
  assert.doesNotMatch(est.stdout, /go-ahead:/);
  const run = spawnSync(process.execPath, [SCRIPT, "run", "--claude", bin, "--go-ahead", "000000000000"], { cwd: root, encoding: "utf8", env });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /gone-sha: baseSha/);
  assert.equal(existsSync(log), false, "claude never spawned");
});

test("cli refuses a pass id that already holds a run (exit 2) and accepts a fresh one", () => {
  const root = benchRoot({ entries: [gitEntry()] });
  mkdirSync(join(root, ".devcycle/plan-bench/passes/1/small-1--inline"), { recursive: true });
  const r = cli(["estimate"], root);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /already holds a run; pick a new --pass id/);
  const fresh = cli(["estimate", "--pass", "2"], root);
  assert.equal(fresh.status, 0, fresh.stderr);
});
