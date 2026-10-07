import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { makeRepo, writeInto } from "./helpers.mjs";
import { repoSlug, gitToplevel } from "../../scripts/run-record.mjs";

const SCRIPT = new URL("../../scripts/plan-check.mjs", import.meta.url).pathname;
const WAVE = new URL("../../scripts/wave-disjointness-check.mjs", import.meta.url).pathname;

const task = (n, files) => [
  `### Task ${n}: Thing ${n}`, "", "**Files:**", ...files.map((f) => `- Modify: ${f}`), "",
  "**Interfaces:**", "- Consumes: nothing.", "- Produces: nothing.", "",
  "**Dependencies:** none (completely independent)", "**Evidence:** red-green",
  "**Quality constraints:** none", "**Lessons:**", "", "- [ ] step", "",
].join("\n");
const plan = (body, map = "## Dispatch Map\n\n- Wave 1: Task 1, Task 2 (file-disjoint, no dependencies)\n") =>
  `# P Implementation Plan\n\n${body}\n${map}`;

function run(planText, { repo = realpathSync(makeTempDir("plan-check-repo")), args = [], env = {} } = {}) {
  const p = join(repo, "plan.md");
  writeFileSync(p, planText);
  return spawnSync(process.execPath, [SCRIPT, p, repo, ...args], { encoding: "utf8", cwd: repo,
    env: { ...process.env, DEVCYCLE_RUNS_DIR: makeTempDir("plan-check-runs"), ...env } });
}

test("a clean plan prints one ok line naming all seven legs", () => {
  const r = run(plan(task(1, ["src/a.txt"]) + task(2, ["src/b.txt"])));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "plan-check: ok — 7 leg(s): codeBlocks, briefCompleteness, blastRadius, contentCoupling, budgetFixtures, waveDisjointness, authoredClaims");
});

test("no Dispatch Map fails closed before any leg runs (M16)", () => {
  const r = run(plan(task(1, ["src/a.txt"]), ""));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^plan-check: dispatchMap: missing "## Dispatch Map" section/m);
  assert.doesNotMatch(r.stderr, /plan-check: (codeBlocks|waveDisjointness):/);
});

test("a same-wave overlap is a waveDisjointness finding, matching the standalone CLI's verdict", () => {
  const text = plan(task(1, ["src/a.txt"]) + task(2, ["src/a.txt"]));
  const r = run(text);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^plan-check: waveDisjointness: Wave 1 -- Task 1 and Task 2 both list src\/a\.txt/m);
  const dir = realpathSync(makeTempDir("plan-check-cli"));
  writeFileSync(join(dir, "plan.md"), text);
  assert.equal(spawnSync(process.execPath, [WAVE, join(dir, "plan.md")], { encoding: "utf8" }).status, 1);
});

test("a budget-fixture gap is reported once, by the budgetFixtures leg", () => {
  const r = run(plan(task(1, ["playbooks/x.md"]) + task(2, ["src/b.txt"])));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^plan-check: budgetFixtures: .*surface-budget\.json/m);
  assert.doesNotMatch(r.stderr, /^plan-check: briefCompleteness: .*surface-budget\.json/m);
});

test("--only runs one leg", () => {
  const r = run(plan(task(1, ["src/a.txt"]) + task(2, ["src/a.txt"])), { args: ["--only", "codeBlocks"] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "plan-check: ok — 1 leg(s): codeBlocks");
});

test("an unknown --only leg is a usage error", () => {
  const r = run(plan(task(1, ["src/a.txt"])), { args: ["--only", "nope"] });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown leg "nope"/);
});

test("with a run in .devcycle/state.md, each run appends one gate-ran event with its result", () => {
  const repo = makeRepo();
  writeInto(repo, ".devcycle/state.md", "# devcycle state\n- stage: planning\n- run: 00000000000000b2\n");
  const runsDir = makeTempDir("plan-check-runs");
  run(plan(task(1, ["src/a.txt"]) + task(2, ["src/a.txt"])), { repo, env: { DEVCYCLE_RUNS_DIR: runsDir } });
  const dir = join(runsDir, repoSlug(gitToplevel(repo)));
  assert.ok(existsSync(dir));
  const events = readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)))
    .filter((o) => o.kind === "event");
  assert.deepEqual(events.map((e) => [e.event, e.stage, e.result]), [["gate-ran", "planning", "fail"]]);
});

function overrideRepo() {
  const repo = realpathSync(makeTempDir("plan-check-repo"));
  writeInto(repo, "lib/use.mjs", 'import data from "./a.txt";\n');
  return repo;
}
const OVERRIDE = "- Blast-radius override: src/a.txt → lib/use.mjs — it only reads the file's bytes\n\n";
const COUNT_LINE = /^plan-check: blastRadius: 1 note\(s\) — rerun with --verbose to list them$/m;
const NOTE_LINE = /^plan-check: blastRadius: override -- lib\/use\.mjs references src\/a\.txt, cleared: /m;

test("a passing run summarizes each leg's notes as one count line", () => {
  const r = run(plan(task(1, ["src/a.txt"]) + OVERRIDE + task(2, ["src/b.txt"])), { repo: overrideRepo() });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, COUNT_LINE);
  assert.doesNotMatch(r.stderr, /override --/);
  assert.match(r.stdout, /^plan-check: ok — 7 leg\(s\)/);
});

test("--verbose lists every note on a passing run", () => {
  const r = run(plan(task(1, ["src/a.txt"]) + OVERRIDE + task(2, ["src/b.txt"])), { repo: overrideRepo(), args: ["--verbose"] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, NOTE_LINE);
  assert.doesNotMatch(r.stderr, COUNT_LINE);
});

test("a failing run lists every note without --verbose", () => {
  const r = run(plan(task(1, ["src/a.txt"]) + OVERRIDE + task(2, ["src/a.txt"])), { repo: overrideRepo() });
  assert.equal(r.status, 1);
  assert.match(r.stderr, NOTE_LINE);
  assert.doesNotMatch(r.stderr, COUNT_LINE);
});

test("an unknown flag is a usage error that names --verbose", () => {
  const r = run(plan(task(1, ["src/a.txt"]) + task(2, ["src/b.txt"])), { args: ["--bogus"] });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown flag "--bogus"/);
  assert.match(r.stderr, /--verbose/);
});
