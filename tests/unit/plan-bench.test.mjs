import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { writeInto } from "./helpers.mjs";
import {
  ARMS, DEFAULT_TASKS, RATES, DEFAULT_ANSWERS, validateManifest, validateAnswers, estimatePass, goAheadToken,
  benchKnobs, benchSettings,
} from "../../scripts/plan-bench.mjs";

const SCRIPT = new URL("../../scripts/plan-bench.mjs", import.meta.url).pathname;
const entry = (over) => ({ id: "small-1", size: "small", repoPath: "/repo", baseSha: "71cc4ff", specPath: "docs/s.md", ...over });

test("the arms are status-quo and inline, and the default task counts and rates are pinned", () => {
  assert.deepEqual(ARMS, ["status-quo", "inline"]);
  assert.deepEqual(DEFAULT_TASKS, { small: 3, medium: 7, large: 12 });
  assert.deepEqual(RATES, { planning: { "status-quo": 5.3, inline: 1.4 }, execution: 1.8 });
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
    { id: "small-1", arm: "status-quo", tasks: 3, planningUsd: 15.9, executionUsd: 0, usd: 15.9 },
    { id: "small-1", arm: "inline", tasks: 3, planningUsd: 4.2, executionUsd: 0, usd: 4.2 },
    { id: "med-1", arm: "status-quo", tasks: 7, planningUsd: 37.1, executionUsd: 12.6, usd: 49.7 },
    { id: "med-1", arm: "inline", tasks: 7, planningUsd: 9.8, executionUsd: 12.6, usd: 22.4 },
  ]);
  assert.equal(totalUsd, 92.2);
});

test("goAheadToken is 12 hex characters and changes with any input", () => {
  const base = { manifestText: "m", answersTexts: ["a"], arms: ARMS, passId: "1", budget: 150, totalUsd: 92.2 };
  const t = goAheadToken(base);
  assert.match(t, /^[0-9a-f]{12}$/);
  assert.equal(goAheadToken({ ...base }), t);
  for (const over of [{ manifestText: "m2" }, { answersTexts: ["b"] }, { arms: ["inline"] }, { passId: "2" }, { budget: 100 }, { totalUsd: 92.3 }])
    assert.notEqual(goAheadToken({ ...base, ...over }), t, JSON.stringify(over));
});

test("benchKnobs pins every knob but the arm and the implementer model", () => {
  assert.deepEqual(benchKnobs("inline", { implementerModel: "claude-sonnet-5-5" }), {
    profile: "standard", gitPolicy: "local-commits-only", docTrackingPolicy: "all-local", reviewDepth: "single",
    crossModelReview: "false", onDeviceGate: "auto-ok", implementerModel: "claude-sonnet-5-5", handoffNotification: "off",
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

const cli = (args, cwd) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });

function benchRoot(manifest) {
  const root = makeTempDir("plan-bench-root-");
  writeInto(root, ".devcycle/plan-bench/manifest.json", JSON.stringify(manifest));
  return root;
}

test("cli estimate prints the table, the estimate and a go-ahead token, exit 0 within budget", () => {
  const root = benchRoot({ entries: [entry(), entry({ id: "med-1", size: "medium" })] });
  const r = cli(["estimate", "--manifest", `${root}/.devcycle/plan-bench/manifest.json`], root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\| Entry \| Arm \| Tasks \| Planning \$ \| Execution \$ \| Total \$ \|$/m);
  assert.match(r.stdout, /^\| med-1 \| status-quo \| 7 \| 37\.10 \| 12\.60 \| 49\.70 \|$/m);
  assert.match(r.stdout, /^estimate: \$92\.20 for pass 1 \(budget \$150\.00\)$/m);
  assert.match(r.stdout, /^go-ahead: [0-9a-f]{12}$/m);
});

test("cli estimate refuses past --budget with exit 2 and prints no token", () => {
  const root = benchRoot({ entries: [entry(), entry({ id: "med-1", size: "medium" })] });
  const r = cli(["estimate", "--manifest", `${root}/.devcycle/plan-bench/manifest.json`, "--budget", "50"], root);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /^refused: the estimate exceeds --budget \$50\.00$/m);
  assert.doesNotMatch(r.stdout, /go-ahead:/);
});

test("cli estimate narrows by --arms and --entries, and rejects an unknown arm, entry or bad manifest", () => {
  const root = benchRoot({ entries: [entry(), entry({ id: "med-1", size: "medium" })] });
  const m = `${root}/.devcycle/plan-bench/manifest.json`;
  const r = cli(["estimate", "--manifest", m, "--arms", "inline", "--entries", "small-1"], root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^estimate: \$4\.20 for pass 1/m);
  assert.equal(cli(["estimate", "--manifest", m, "--arms", "grouped"], root).status, 1);
  assert.match(cli(["estimate", "--manifest", m, "--entries", "nope"], root).stderr, /no manifest entry nope/);
  const bad = benchRoot({ entries: [entry({ size: "huge" })] });
  const b = cli(["estimate", "--manifest", `${bad}/.devcycle/plan-bench/manifest.json`], bad);
  assert.equal(b.status, 1);
  assert.match(b.stderr, /entries\[0\]\.size: expected one of small, medium, large/);
  assert.equal(cli(["bogus"], root).status, 1);
});
