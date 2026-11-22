import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { loadRegistry } from "../../scripts/hygiene-registry.mjs";
import { SCANNERS } from "../../scripts/hygiene-scanners.mjs";
import { clusterCandidates, detectStacks, resolveCommand, runSweep, selectTools } from "../../scripts/hygiene-sweep.mjs";

const SCRIPT = fileURLToPath(new URL("../../scripts/hygiene-sweep.mjs", import.meta.url));
const registry = () => structuredClone(loadRegistry());
const tool = (reg, id) => reg.tools.find((t) => t.id === id);
const scanner = (id) => SCANNERS.find((s) => s.id === id);
const row = (coverage, source) => coverage.rows.find((r) => r.source === source);
function repoWith(files) {
  const dir = makeTempDir("hyg-repo-");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}
const ok = (stdout = "", status = 0) => ({ status, stdout, stderr: "", error: null });
const cand = (over) => ({ id: over.id, sweep: "dead-code", kind: "over-exported", source: "knip", file: "a.ts", line: null,
  symbol: null, detail: "", noisy: false, cleared: null, ...over });

test("detectStacks matches bare names at any depth and *.ext by extension", () => {
  const reg = registry();
  assert.deepEqual(detectStacks(["package.json", "src/a.ts", "web/site.css"], reg), ["js-ts", "web"]);
  assert.deepEqual(detectStacks(["svc/go.mod"], reg), ["go"]);
  assert.deepEqual(detectStacks(["README.md"], reg), []);
});

test("selectTools runs static modes, and an executing mode only on consent", () => {
  const reg = registry();
  const pick = (consent, files) => Object.fromEntries(selectTools(reg, { stacks: ["js-ts"], files, consent })
    .map((s) => [s.tool.id, `${s.status}/${s.mode}`]));
  const base = pick({ executing: false }, ["package.json", "tsconfig.json", "eslint.config.js"]);
  assert.equal(base.knip, "run/static");
  assert.equal(base.tsc, "run/static");
  assert.equal(base.eslint, "needs-consent/executing");
  assert.equal(base.vulture, "not-applicable/null");
  const consented = pick({ executing: true }, ["package.json", "tsconfig.json", "eslint.config.js"]);
  assert.equal(consented.knip, "run/executing");
  assert.equal(consented.eslint, "run/executing");
  assert.equal(pick({ executing: false }, ["package.json"]).tsc, "not-applicable/null", "tsc needs tsconfig.json");
});

test("resolveCommand prefers the repo's local binary, then PATH, then the pinned fetch", () => {
  const reg = registry();
  const repo = repoWith({ "node_modules/.bin/tsc": "" });
  assert.deepEqual(resolveCommand(tool(reg, "tsc"), { repoRoot: repo, onPath: () => true }),
    { argv: [join(repo, "node_modules/.bin/tsc")], downloaded: false });
  const bare = repoWith({});
  assert.deepEqual(resolveCommand(tool(reg, "tsc"), { repoRoot: bare, onPath: (n) => n === "npx" }),
    { argv: ["npx", "-y", "-p", "typescript@6.0.3", "tsc"], downloaded: true });
  assert.equal(resolveCommand(tool(reg, "tsc"), { repoRoot: bare, onPath: () => false }), null);
  assert.deepEqual(resolveCommand(tool(reg, "vulture"), { repoRoot: bare, onPath: () => true }), { argv: ["vulture"], downloaded: false });
});

test("48 over-exported symbols in one module make one cluster; file-level candidates cluster by directory", () => {
  const many = Array.from({ length: 48 }, (_, i) => cand({ id: `s${i}`, symbol: `sym${i}`, file: "src/big.ts" }));
  const fileLevel = [cand({ id: "f1", kind: "dead-code", file: "src/old/a.ts" }), cand({ id: "f2", kind: "dead-code", file: "src/old/b.ts" })];
  const cleared = cand({ id: "c1", kind: "dead-code", file: "src/x.ts", symbol: "x", cleared: "public entry point" });
  const clusters = clusterCandidates([...many, ...fileLevel, cleared], new Map([["src/big.ts", 4]]));
  assert.equal(clusters.length, 2);
  const big = clusters.find((c) => c.anchor === "src/big.ts");
  assert.equal(big.candidates.length, 48);
  assert.equal(big.blastRadius, 5);
  const dir = clusters.find((c) => c.anchor === "src/old");
  assert.deepEqual(dir.files, ["src/old/a.ts", "src/old/b.ts"]);
  assert.equal(dir.blastRadius, 2);
  assert.equal(clusters[0].clusterId, "over-exported:src/big.ts", "sorted by blast radius");
  assert.ok(!clusters.some((c) => c.candidates.includes("c1")), "a cleared candidate joins no cluster");
});

test("a raw tool's lines become noisy candidates for tracked files, and its version is recorded", () => {
  const reg = registry();
  reg.tools = [tool(reg, "vulture")];
  const repo = repoWith({ "pyproject.toml": "", "app.py": "def f():\n  pass\n" });
  const out = join(makeTempDir("hyg-out-"), "sweep");
  const calls = [];
  const runTool = ({ argv }) => {
    calls.push(argv);
    return argv.includes("--version") ? ok("vulture 2.16\n")
      : ok("app.py:1: unused function 'f' (60% confidence)\nvendor/x.py:3: unused variable 'y'\n", 3);
  };
  const { candidates, coverage } = runSweep({ repoRoot: repo, outDir: out, registry: reg, runTool,
    files: ["pyproject.toml", "app.py"], churn: new Map(), onPath: () => true });
  const v = candidates.filter((c) => c.source === "vulture");
  assert.equal(v.length, 1);
  assert.deepEqual({ file: v[0].file, line: v[0].line, kind: v[0].kind, noisy: v[0].noisy, id: v[0].id },
    { file: "app.py", line: 1, kind: "dead-code", noisy: true, id: "vulture:app.py:1:" });
  assert.deepEqual({ status: row(coverage, "vulture").status, method: row(coverage, "vulture").method, version: row(coverage, "vulture").version },
    { status: "ran", method: "tool-raw", version: "vulture 2.16" });
  assert.deepEqual(calls.at(-1), ["vulture", ".", "--min-confidence", "60", "--sort-by-size"]);
  assert.ok(existsSync(join(out, "candidates.json")) && existsSync(join(out, "coverage.json")));
  assert.ok(readFileSync(join(out, "tools", "vulture", "main.stdout"), "utf8").includes("vendor/x.py"));
});

test("every tool that cannot run is a named row, and an unconsented executing tool is never spawned", () => {
  const reg = registry();
  const nope = { ...structuredClone(tool(reg, "vulture")), id: "nope", adapter: "nope" };
  reg.tools = [tool(reg, "vulture"), tool(reg, "cargo-check"), nope];
  const repo = repoWith({ "pyproject.toml": "", "Cargo.toml": "" });
  const spawned = [];
  const runTool = ({ argv, env }) => { spawned.push({ argv, env }); return ok("", 2); };
  const files = ["pyproject.toml", "Cargo.toml"];
  const missing = runSweep({ repoRoot: repo, outDir: join(makeTempDir("hyg-out-"), "s"), registry: reg, runTool, files,
    churn: new Map(), onPath: () => false }).coverage;
  assert.equal(row(missing, "vulture").status, "unavailable");
  assert.equal(row(missing, "cargo-check").status, "needs-consent");
  assert.equal(spawned.length, 0, "nothing runs when nothing resolves and executing is unconsented");
  const present = runSweep({ repoRoot: repo, outDir: join(makeTempDir("hyg-out-"), "s"), registry: reg, runTool, files,
    churn: new Map(), onPath: () => true }).coverage;
  assert.equal(row(present, "vulture").status, "failed", "exit 2 is outside vulture's okExit");
  assert.match(row(present, "vulture").note, /main: exit 2/);
  assert.match(row(present, "nope").note, /no adapter "nope"/);
  assert.ok(!spawned.some((s) => s.argv[0] === "cargo"));
  assert.ok(!present.fullKinds.includes("dead-code"), "a failed source keeps its kind open");
  const outDir = join(makeTempDir("hyg-out-"), "s");
  runSweep({ repoRoot: repo, outDir, registry: reg, runTool, files, churn: new Map(), onPath: () => true,
    consent: { executing: true, coverage: false } });
  const cargo = spawned.find((s) => s.argv[0] === "cargo" && !s.argv.includes("--version"));
  assert.deepEqual(cargo.argv, ["cargo", "check", "--locked", "--all-targets", "--message-format=short"]);
  assert.equal(cargo.env.CARGO_TARGET_DIR, join(outDir, "tools", "cargo-check", "target"));
});

test("coverage names the stacks with no tool, the kinds left open, and missing dependencies", () => {
  const reg = registry();
  const needy = { ...structuredClone(tool(reg, "vulture")), id: "needy", needsDependencies: true };
  reg.tools = [needy];
  const repo = repoWith({ "pyproject.toml": "", "angular.json": "{}", "a.py": "x = 1\n" });
  const runTool = ({ argv }) => (argv.includes("--version") ? ok("v\n") : ok("a.py:1: unused variable 'x'\n"));
  const { candidates, coverage } = runSweep({ repoRoot: repo, outDir: join(makeTempDir("hyg-out-"), "s"), registry: reg, runTool,
    files: ["pyproject.toml", "angular.json", "a.py"], churn: new Map(), onPath: () => true });
  assert.deepEqual(coverage.noToolStacks, ["angular"]);
  assert.equal(coverage.dependenciesInstalled, false);
  assert.match(row(coverage, "needy").note, /dependencies not installed/);
  assert.ok(candidates.filter((c) => c.source === "needy").every((c) => c.noisy));
  assert.ok(coverage.fullKinds.includes("commented-out-code"), "a scanner that ran makes its kind full");
  assert.ok(!coverage.fullKinds.includes("test-coverage-gap"), "a kind with no source is never full");
  assert.deepEqual(coverage.notCovered, reg.sweeps["dead-code"].notCovered);
});

test("commented-out-code flags three or more code-like comment lines, not prose or two lines", () => {
  const files = { "a.js": "// const x = 1;\n// if (x) {\n// }\nconst y = 2;\n", "b.js": "// const x = 1;\n// return x;\n",
    "c.js": "// This explains\n// the next function\n// in plain words\n", "d.py": "# x = f()\n# return x;\n# def g():\n" };
  const found = scanner("commented-out-code").scan({ files: Object.keys(files), read: (f) => files[f] });
  assert.deepEqual(found.map((c) => `${c.file}:${c.line}`), ["a.js:1"]);
});

test("stale-todo ages each TODO by blame against the threshold", () => {
  const files = { "a.js": "const a = 1;\n// TODO: remove this\n" };
  const day = 86_400_000;
  const scan = (now, days) => scanner("stale-todo").scan({ files: ["a.js"], read: (f) => files[f],
    blame: () => [{ line: 1, time: 0 }, { line: 2, time: 0 }], now, config: { staleTodoDays: days } });
  assert.deepEqual(scan(400 * day, 365).map((c) => c.line), [2]);
  assert.deepEqual(scan(300 * day, 365), []);
  assert.deepEqual(scan(400 * day, 500), []);
});

test("unused-env-var flags a declared key no other tracked file reads", () => {
  const files = { ".env.example": "API_URL=x\nLEGACY_TOKEN=y\n", "src/c.js": "fetch(process.env.API_URL)\n" };
  const found = scanner("unused-env-var").scan({ files: Object.keys(files), read: (f) => files[f] });
  assert.deepEqual(found.map((c) => [c.symbol, c.line]), [["LEGACY_TOKEN", 2]]);
});

test("the CLI sweeps a git repo, reads the staleTodoDays override, and refuses a missing --out", () => {
  const repo = repoWith({ "a.js": "// TODO: old\n" });
  const gitEnv = { ...process.env, GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z" };
  const g = (...a) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...a], { env: gitEnv });
  g("init", "-q"); g("add", "."); g("commit", "-q", "-m", "init");
  const out = join(makeTempDir("hyg-out-"), "s");
  const summary = JSON.parse(execFileSync("node", [SCRIPT, "run", "--out", out, "--repo", repo], { encoding: "utf8" }));
  assert.equal(summary.candidates, 1);
  const stale = JSON.parse(readFileSync(join(out, "candidates.json"), "utf8")).candidates[0];
  assert.equal(stale.kind, "stale-todo");
  writeFileSync(join(repo, ".devcycle-hygiene.json"), JSON.stringify({ staleTodoDays: 100000 }));
  const out2 = join(makeTempDir("hyg-out-"), "s");
  assert.equal(JSON.parse(execFileSync("node", [SCRIPT, "run", "--out", out2, "--repo", repo], { encoding: "utf8" })).candidates, 0);
  assert.equal(JSON.parse(readFileSync(join(out2, "coverage.json"), "utf8")).config.source, ".devcycle-hygiene.json");
  const r = spawnSync("node", [SCRIPT, "run", "--repo", repo], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^hygiene-sweep: --out is required/);
});
