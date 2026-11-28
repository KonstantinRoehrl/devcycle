import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { loadRegistry } from "../../scripts/hygiene-registry.mjs";
import { SCANNERS } from "../../scripts/hygiene-scanners.mjs";
import { clusterCandidates, detectStacks, finalizeSweep, resolveCommand, runSweep, selectTools } from "../../scripts/hygiene-sweep.mjs";

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

test("detectStacks ignores a manifest under .github/, so a CI-only package.json switches on no stack", () => {
  const reg = registry();
  assert.deepEqual(detectStacks([".github/claude-code/package.json"], reg), []);
  assert.deepEqual(detectStacks([".github/claude-code/package.json", "package.json"], reg), ["js-ts"]);
  assert.deepEqual(detectStacks([".github/site/x.css"], reg), ["web"], "an extension signal still matches under .github/");
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
  assert.deepEqual(coverage.sweeps["dead-code"].noToolStacks, ["angular"]);
  assert.equal(coverage.dependenciesInstalled, false);
  assert.match(row(coverage, "needy").note, /dependencies not installed/);
  assert.ok(candidates.filter((c) => c.source === "needy").every((c) => c.noisy));
  assert.ok(coverage.fullKinds.includes("commented-out-code"), "a scanner that ran makes its kind full");
  assert.ok(!coverage.fullKinds.includes("test-coverage-gap"), "a kind with no source is never full");
  assert.deepEqual(coverage.sweeps["dead-code"].notCovered, reg.sweeps["dead-code"].notCovered);
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

const gitRepo = (files) => {
  const repo = repoWith(files);
  const g = (...a) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...a],
    { env: { ...process.env, GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z" } });
  g("init", "-q"); g("add", "."); g("commit", "-q", "-m", "init");
  return repo;
};
const sweepOnly = (repo, over = {}) => runSweep({ repoRoot: repo, outDir: join(makeTempDir("hyg-out-"), "s"), registry: { ...registry(), tools: [] },
  runTool: () => ok(), onPath: () => true, ...over });

test("a repo whose file list cannot be read stops the run instead of reading as a clean sweep", () => {
  const notGit = repoWith({ "a.js": "// TODO: old\n" });
  assert.throws(() => sweepOnly(notGit), /git ls-files failed/);
  const r = spawnSync("node", [SCRIPT, "run", "--out", join(makeTempDir("hyg-out-"), "s"), "--repo", notGit], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^hygiene-sweep: git ls-files failed/);
});

test("a failed git log is a named degraded source, and a failed git blame keeps stale-todo out of the full kinds", () => {
  const repo = repoWith({ "a.js": "// TODO: old\n" });
  const { coverage } = sweepOnly(repo, { files: ["a.js"] });
  assert.ok((coverage.degraded ?? []).some((d) => /git log failed.*file count/.test(d)), JSON.stringify(coverage.degraded));
  assert.equal(row(coverage, "stale-todo").status, "partial");
  assert.match(row(coverage, "stale-todo").note, /git blame failed for 1 file/);
  assert.ok(!coverage.fullKinds.includes("stale-todo"));
  assert.ok(coverage.fullKinds.includes("commented-out-code"), "a source that did not need git stays complete");
  const healthy = sweepOnly(gitRepo({ "a.js": "// TODO: old\n" })).coverage;
  assert.deepEqual(healthy.degraded, []);
  assert.equal(row(healthy, "stale-todo").status, "ran");
});

test("a git blame capped at 200 files marks stale-todo partial and names the cap", () => {
  const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`f${i}.js`, "// TODO: old\n"]));
  const { coverage } = sweepOnly(gitRepo(many));
  assert.equal(row(coverage, "stale-todo").status, "partial");
  assert.match(row(coverage, "stale-todo").note, /git blame capped at 200 files; 1 file with a TODO was not aged/);
  assert.ok(!coverage.fullKinds.includes("stale-todo"));
});

test("a tracked text file over the read cap makes the scanners that read it partial, a large binary does not", () => {
  const big = "x = 1\n".repeat(200_000);
  const repo = repoWith({ "big.js": big, "logo.png": big });
  const { coverage } = sweepOnly(repo, { files: ["big.js", "logo.png"], churn: new Map() });
  assert.equal(row(coverage, "commented-out-code").status, "partial");
  assert.match(row(coverage, "commented-out-code").note, /1 file over 1 MB not scanned \(big\.js\)/);
  assert.ok(!coverage.fullKinds.includes("commented-out-code"));
  const binaryOnly = sweepOnly(repoWith({ "logo.png": big }), { files: ["logo.png"], churn: new Map() }).coverage;
  assert.equal(row(binaryOnly, "static-assets").status, "ran");
});

test("a tool whose config is only in a subdirectory is named unavailable and keeps the kind open", () => {
  const reg = registry();
  const pick = (files) => Object.fromEntries(selectTools(reg, { stacks: ["js-ts"], files, consent: { executing: true } })
    .map((s) => [s.tool.id, s.status]));
  const nested = pick(["package.json", "packages/a/tsconfig.json", "packages/a/eslint.config.js"]);
  assert.equal(nested.tsc, "unavailable");
  assert.equal(nested.eslint, "unavailable");
  assert.equal(pick(["package.json", "tsconfig.json"]).tsc, "run");
  reg.tools = reg.tools.filter((t) => t.id === "tsc");
  const repo = repoWith({ "package.json": "{}", "packages/a/tsconfig.json": "{}" });
  const { coverage } = sweepOnly(repo, { registry: reg, files: ["package.json", "packages/a/tsconfig.json"], churn: new Map() });
  assert.equal(row(coverage, "tsc").status, "unavailable");
  assert.match(row(coverage, "tsc").note, /packages\/a\/tsconfig\.json.*repo root/);
  assert.ok(!coverage.fullKinds.includes("dead-code"));
});

const tscRepo = (configs, extra = {}) => repoWith({ "package.json": "{}", "src/a.ts": "export {}\n", ...Object.fromEntries(
  Object.entries(configs).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])), ...extra });
const tscSweep = (repo, runner) => {
  const reg = registry();
  reg.tools = [tool(reg, "tsc")];
  const argvs = [];
  const runTool = ({ argv }) => { argvs.push(argv); return runner(argv); };
  const tracked = ["package.json", "src/a.ts", ...readdirSync(repo).filter((n) => n.startsWith("tsconfig") || /^p\d+\.json$/.test(n))];
  return { ...runSweep({ repoRoot: repo, outDir: join(makeTempDir("hyg-out-"), "s"), registry: reg, runTool, files: tracked,
    churn: new Map(), onPath: () => true }), argvs };
};
const projectsRun = (argvs) => argvs.filter((a) => a.includes("--noEmit")).map((a) => a[a.lastIndexOf("-p") + 1]);
const UNUSED = "src/a.ts(1,21): error TS6133: 'x' is declared but its value is never read.\n";

test("tsc on a solution-style tsconfig runs each referenced project and reports their findings", () => {
  const repo = tscRepo({
    "tsconfig.json": '// Vite solution config\n{ "files": [], "references": [ { "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" }, ], }\n',
    "tsconfig.app.json": {}, "tsconfig.node.json": {},
  });
  const result = tscSweep(repo, (argv) => (argv.includes("tsconfig.app.json") ? ok(UNUSED, 2) : ok()));
  assert.deepEqual(projectsRun(result.argvs), ["tsconfig.app.json", "tsconfig.node.json"], "the root solution file is never the checked project");
  assert.deepEqual(result.candidates.filter((c) => c.source === "tsc").map((c) => [c.file, c.symbol]), [["src/a.ts", "x"]]);
  assert.equal(row(result.coverage, "tsc").status, "ran");
  assert.match(row(result.coverage, "tsc").note, /solution tsconfig\.json: 2 referenced projects/);
  const infoFiles = result.argvs.filter((a) => a.includes("--noEmit")).map((a) => a[a.indexOf("--tsBuildInfoFile") + 1]);
  assert.equal(new Set(infoFiles).size, 2, "each project gets its own build info file");
});

test("tsc on a plain tsconfig still checks that one project, and a missing or over-cap reference makes the row partial", () => {
  const plain = tscSweep(tscRepo({ "tsconfig.json": { include: ["src"] } }), () => ok());
  assert.deepEqual(projectsRun(plain.argvs), ["tsconfig.json"]);
  assert.equal(row(plain.coverage, "tsc").status, "ran");
  const refs = (n) => ({ files: [], references: Array.from({ length: n }, (_, i) => ({ path: `./p${i}.json` })) });
  const capped = tscSweep(tscRepo({ "tsconfig.json": refs(22), ...Object.fromEntries(Array.from({ length: 22 }, (_, i) => [`p${i}.json`, {}])) }), () => ok());
  assert.equal(projectsRun(capped.argvs).length, 20);
  assert.equal(row(capped.coverage, "tsc").status, "partial");
  assert.match(row(capped.coverage, "tsc").note, /2 referenced projects over the cap of 20 not checked/);
  assert.ok(!capped.coverage.fullKinds.includes("dead-code"));
  const missing = tscSweep(tscRepo({ "tsconfig.json": refs(2), "p0.json": {} }), () => ok());
  assert.equal(row(missing.coverage, "tsc").status, "partial");
  assert.match(row(missing.coverage, "tsc").note, /p1\.json: not found/);
  const none = tscSweep(tscRepo({ "tsconfig.json": refs(1) }), () => ok());
  assert.equal(row(none.coverage, "tsc").status, "failed");
});

test("staticcheck: a failed go run is a failed row, while U1000 findings with the same exit code stay a run", () => {
  const reg = registry();
  reg.tools = [tool(reg, "staticcheck")];
  const repo = repoWith({ "go.mod": "module x\n", "main.go": "package main\n" });
  const go = (stdout, stderr, status) => runSweep({ repoRoot: repo, outDir: join(makeTempDir("hyg-out-"), "s"), registry: reg,
    runTool: ({ argv }) => (argv.includes("--version") ? ok() : { status, stdout, stderr, error: null }),
    files: ["go.mod", "main.go"], churn: new Map(), onPath: () => true }).coverage;
  const broken = go("", "go: honnef.co/go/tools@v0.8.2: network unreachable\n", 1);
  assert.equal(row(broken, "staticcheck").status, "failed");
  assert.ok(!broken.fullKinds.includes("dead-code"));
  const found = go("main.go:1:6: func f is unused (U1000)\n", "", 1);
  assert.equal(row(found, "staticcheck").status, "ran");
  assert.equal(row(go("", "", 0), "staticcheck").status, "ran");
});

test("coverage names every kind some source produces, so a kind with no source is not gated by it", () => {
  const { coverage } = sweepOnly(repoWith({ "a.js": "x\n" }), { files: ["a.js"], churn: new Map() });
  const sourced = coverage.sourcedKinds ?? [];
  assert.ok(sourced.includes("dead-code") && sourced.includes("stale-todo"), `sourcedKinds: ${JSON.stringify(coverage.sourcedKinds)}`);
  assert.ok(!sourced.includes("test-coverage-gap"));
  assert.deepEqual(sourced.filter((k) => !coverage.sweepKinds.includes(k)), []);
});

// The real scanners and registry over an in-memory tree; every tool answers with nothing unless `report` is the jscpd report to replay.
function duplicationSweep(tree, { report = null } = {}) {
  const repo = repoWith(tree);
  const runTool = ({ argv }) => {
    if (report && argv.some((a) => a.startsWith("jscpd@"))) {
      const dir = argv[argv.indexOf("--output") + 1];
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "jscpd-report.json"), JSON.stringify(report));
    }
    return ok("0.0.0\n");
  };
  const outDir = join(makeTempDir("hyg-dup-out-"), "sweep");
  return { repo, outDir, ...runSweep({ repoRoot: repo, outDir, runTool, files: Object.keys(tree), churn: new Map(), onPath: () => true, hotspots: [] }) };
}

test("a candidate is identified by its kind and cluster too, so one line feeding two clusters keeps both candidates", () => {
  const { clusters, candidates } = duplicationSweep({ "package.json": "{}", "a.js": "export const TIMEOUT_MS = 5000;\n",
    "b.js": "export const TIMEOUT_MS = 5000;\n", "c.js": "export const REQUEST_TIMEOUT = 5000;\n" });
  const owner = clusters.find((k) => k.clusterId === "missing-owner:value 5000");
  assert.deepEqual([...owner.files].sort(), ["a.js", "b.js", "c.js"]);
  assert.equal(owner.candidates.length, 3);
  assert.equal(candidates.filter((c) => c.kind === "duplicate-constant").length, 2);
  assert.equal(new Set(candidates.map((c) => c.id)).size, candidates.length);
});

test("two clone families that start on the same line of one file keep that file in both", () => {
  const instance = (name, end) => ({ name, start: 1, end });
  const clone = (second, end, fragment) => ({ firstFile: instance("src/big1.js", end), secondFile: instance(second, end), format: "javascript",
    lines: end, tokens: end * 5, fragment });
  const body = "export const noop = () => {};\n";
  const { clusters } = duplicationSweep({ "package.json": "{}", "src/big1.js": body, "src/big2.js": body, "src/big3.js": body },
    { report: { duplicates: [clone("src/big2.js", 20, "alpha alpha alpha"), clone("src/big3.js", 30, "omega omega omega")] } });
  const families = clusters.filter((k) => /^duplicate-logic:clone /.test(k.clusterId));
  assert.equal(families.length, 2);
  assert.ok(families.every((k) => k.files.includes("src/big1.js") && k.candidates.length === 2), JSON.stringify(families));
});

const statementOf = (tree, over) => {
  const swept = duplicationSweep(tree, over);
  finalizeSweep({ outDir: swept.outDir, verdicts: [], repoRoot: swept.repo, previousCounts: null });
  return { ...swept, statement: readFileSync(join(swept.outDir, "section-duplication.md"), "utf8").split("### Coverage")[1] };
};
const HEURISTIC_KINDS = ["duplicate-constant", "restated-literal", "missing-owner", "scattered-env-read"];

test("source files in a language no scanner reads are named in the coverage statement and keep their kinds out of the full kinds", () => {
  const { coverage, statement } = statementOf({ "a/A.java": "class A { static final int MAX_RETRIES = 12; }\n",
    "b/B.java": "class B { static final int MAX_RETRIES = 12; }\n", "x.rb": "MAX_RETRIES = 12\n", "README.md": "# docs\n" });
  assert.deepEqual(coverage.stacks, []);
  assert.deepEqual(coverage.sweeps.duplication.noToolStacks, []);
  for (const kind of [...HEURISTIC_KINDS, "duplicate-logic"]) assert.ok(!coverage.fullKinds.includes(kind), `${kind} must not read complete`);
  assert.match(statement, /^- partial: duplicate-constants \(3 source files not scanned, their language is not read \(\.java: 2, \.rb: 1; a\/A\.java, b\/B\.java, x\.rb\)\)$/m);
  assert.match(statement, /^- partial: scattered-env-reads \(3 source files not scanned/m);
  assert.match(statement, /^- partial: same-body-helpers \(3 source files not scanned/m);
  assert.doesNotMatch(statement, /README\.md/, "a markdown file is not a source file");
  assert.doesNotMatch(statement, /`duplicate-constant`: [^\n]*; complete/);
});

test("a repo whose source languages the scanners all read still reads complete", () => {
  const { coverage, statement } = statementOf({ "package.json": "{}", "src/a.ts": "export const MAX_RETRIES = 12;\n", "lib/b.py": "X = 1\n", "README.md": "# docs\n" });
  for (const kind of HEURISTIC_KINDS) assert.ok(coverage.fullKinds.includes(kind), `${kind} should read complete`);
  assert.doesNotMatch(statement, /not scanned, their language/);
});

test("a tool that ran for a kind answers for the languages its heuristic does not read", () => {
  const { coverage, statement } = statementOf({ "package.json": "{}", "src/A.java": "class A {}\n", "src/a.ts": "export const A = 1;\n" }, { report: { duplicates: [] } });
  assert.ok(coverage.fullKinds.includes("duplicate-logic"), "jscpd read the Java file");
  assert.match(statement, /^- partial: duplicate-constants \(1 source file not scanned/m, "no tool covers the constant kinds");
  assert.doesNotMatch(statement, /partial: same-body-helpers/);
});

test("the duplication scanners skip the paths jscpd excludes, the statement names them, and an excluded file is not unread source", () => {
  const { candidates, coverage, statement } = statementOf({ "package.json": "{}", "src/a.js": "export const WAIT_MS = 4500;\n",
    "tests/a.test.js": "export const WAIT_MS = 4500;\n", "docs/demo.rb": "x = 1\n", "src/gen/x.js": "const WAIT_MS = 4500;\n" });
  assert.deepEqual(candidates.filter((c) => c.sweep === "duplication").map((c) => c.file), ["src/gen/x.js", "src/a.js"].sort());
  assert.match(statement, /^- excluded from the heuristic scanners: 2 tracked files matching \*\*\/node_modules\/\*\*, .*\*\*\/tests\/\*\*.*\*\*\/docs\/\*\*/m);
  assert.doesNotMatch(statement, /docs\/demo\.rb/);
  assert.ok(coverage.fullKinds.includes("duplicate-constant"));
});
