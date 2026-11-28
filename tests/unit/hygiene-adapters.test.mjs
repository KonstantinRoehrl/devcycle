import { test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { loadRegistry, validateRegistry } from "../../scripts/hygiene-registry.mjs";
import { ADAPTERS, ignoreGlobs } from "../../scripts/hygiene-adapters.mjs";
import { runSweep } from "../../scripts/hygiene-sweep.mjs";

const OUTPUTS = fileURLToPath(new URL("../fixtures/maintain/sweep-tool-outputs/", import.meta.url));
const recorded = (name) => readFileSync(join(OUTPUTS, name), "utf8");
const tool = (id) => structuredClone(loadRegistry().tools.find((t) => t.id === id));
const SOURCES = {
  "src/util.ts": "export function used() { return helper(); }\nexport function helper() { return 1; }\n" +
    "export function unusedExport() { return 2; }\nexport function specOnly() { return 3; }\n",
};
const FILES = ["package.json", "tsconfig.json", "src/index.ts", "src/util.ts", "src/util.spec.ts", "src/widget.ts",
  "src/color.ts", "src/orphan.ts", "src/app/hero.component.ts", "src/app/routed.component.ts"];
const ctx = (over = {}) => ({ tool: tool("knip"), mode: "static", repoRoot: "/repo", files: FILES, read: (f) => SOURCES[f] ?? null,
  dependenciesInstalled: true, scratch: "/repo/.out/tools/knip", ...over });
const run = (invocationId, stdout, status = 0) => ({ invocationId, status, stdout, stderr: "", error: null });
const knipRuns = () => [run("default", recorded("knip-default.json")), run("production", recorded("knip-production.json"))];
const brief = (c) => `${c.kind}|${c.file}|${c.line}|${c.symbol}|${Boolean(c.noisy)}`;

test("knip: recorded static-mode runs map to dead, over-exported and test-only candidates", () => {
  const result = ADAPTERS.knip.normalize(knipRuns(), ctx());
  assert.equal(result.ok, true);
  assert.deepEqual(result.candidates.map(brief).sort(), [
    "dead-code|package.json|6|left-pad|true",
    "dead-code|src/color.ts|3|Color.Green|false",
    "dead-code|src/orphan.ts|null|null|true",
    "dead-code|src/util.ts|3|unusedExport|false",
    "over-exported|src/util.ts|2|helper|false",
    "test-only-code|src/util.ts|4|specOnly|false",
  ]);
  assert.match(result.note, /static mode/);
  assert.match(result.note, /ignored: 2 unlisted/);
});

test("knip: an executing-mode run keeps file and dependency findings quiet unless dependencies are missing", () => {
  const noisy = (over, pick) => ADAPTERS.knip.normalize(knipRuns(), ctx(over)).candidates.filter(pick).map((c) => c.noisy);
  const leftPad = (c) => c.symbol === "left-pad";
  assert.deepEqual(noisy({ mode: "executing" }, leftPad), [false]);
  assert.deepEqual(noisy({ mode: "executing" }, (c) => c.file === "src/orphan.ts"), [false]);
  assert.deepEqual(noisy({ mode: "executing", dependenciesInstalled: false }, leftPad), [true]);
});

test("knip: unparseable output fails the tool, and missing issue arrays read as empty", () => {
  const bad = ADAPTERS.knip.normalize([run("default", "Error: no config"), run("production", "{\"issues\":[]}")], ctx());
  assert.deepEqual({ ok: bad.ok, candidates: bad.candidates }, { ok: false, candidates: [] });
  assert.match(bad.note, /^default: unparseable knip JSON/);
  const sparse = ADAPTERS.knip.normalize([run("default", JSON.stringify({ issues: [{ file: "src/util.ts",
    exports: [{ name: "unusedExport", line: 3 }] }] }))], ctx());
  assert.deepEqual(sparse.candidates.map(brief), ["dead-code|src/util.ts|3|unusedExport|false"]);
  const untracked = ADAPTERS.knip.normalize([run("default", JSON.stringify({ issues: [{ file: "dist/x.js",
    exports: [{ name: "x", line: 1 }] }] }))], ctx());
  assert.deepEqual(untracked.candidates, [], "a file outside the tracked list is dropped");
});

test("knip: a registry row missing a kind the adapter maps is an adapter error, not a silent drop", () => {
  const narrow = { ...tool("knip"), kinds: ["dead-code"] };
  assert.throws(() => ADAPTERS.knip.normalize(knipRuns(), ctx({ tool: narrow })), /registry row lacks kind "over-exported"/);
});

test("tsc: unused-symbol diagnostics become dead-code candidates, and every other diagnostic is counted", () => {
  const recordedRun = ADAPTERS.tsc.normalize([run("main", recorded("tsc.txt"), 2)], ctx({ tool: tool("tsc") }));
  assert.equal(recordedRun.ok, true);
  assert.deepEqual(recordedRun.candidates.map(brief), ["dead-code|src/widget.ts|2|neverRead|false"]);
  assert.match(recordedRun.candidates[0].detail, /^TS6133: 'neverRead' is declared/);
  assert.equal(recordedRun.note, "2 other diagnostics ignored");
  const synthetic = [
    "/repo/src/index.ts(4,1): error TS7027: Unreachable code detected.",
    "src/color.ts(1,1): error TS6192: All imports in import declaration are unused.",
    "dist/out.ts(1,1): error TS6133: 'gone' is declared but its value is never read.",
  ].join("\n");
  const parsed = ADAPTERS.tsc.normalize([run("main", synthetic, 2)], ctx({ tool: tool("tsc") }));
  assert.deepEqual(parsed.candidates.map(brief), ["dead-code|src/index.ts|4|null|false", "dead-code|src/color.ts|1|null|false"]);
  assert.equal(parsed.note, null);
});

test("the spine runs knip and tsc through the registry, and missing node_modules makes every candidate noisy", () => {
  const registry = loadRegistry();
  registry.tools = registry.tools.filter((t) => t.id === "knip" || t.id === "tsc");
  const output = (stdout, status = 0) => ({ status, stdout, stderr: "", error: null });
  const replay = ({ argv }) => argv.includes("--noEmit") ? output(recorded("tsc.txt"), 2)
    : output(recorded(argv.includes("--production") ? "knip-production.json" : "knip-default.json"));
  const sweep = (installed) => {
    const repo = makeTempDir("hyg-adapt-");
    for (const [rel, text] of Object.entries({ ...SOURCES, ...(installed ? { "node_modules/.keep": "" } : {}) })) {
      mkdirSync(dirname(join(repo, rel)), { recursive: true });
      writeFileSync(join(repo, rel), text);
    }
    return runSweep({ repoRoot: repo, outDir: join(makeTempDir("hyg-out-"), "s"), registry, runTool: replay, files: FILES,
      churn: new Map(), onPath: () => true });
  };
  const withDeps = sweep(true);
  const rows = Object.fromEntries(withDeps.coverage.rows.filter((r) => r.method === "tool").map((r) => [r.source, r.status]));
  assert.deepEqual(rows, { knip: "ran", tsc: "ran" });
  assert.ok(withDeps.candidates.some((c) => c.source === "knip" && c.kind === "test-only-code" && !c.noisy));
  assert.ok(withDeps.candidates.some((c) => c.source === "tsc" && c.symbol === "neverRead" && !c.noisy));
  const noDeps = sweep(false);
  assert.ok(noDeps.candidates.filter((c) => c.source === "knip" || c.source === "tsc").every((c) => c.noisy));
});

const MACHETE_FOUND = "Analyzing dependencies of crates in this directory...\n" +
  "cargo-machete found the following unused dependencies in this directory:\n" +
  "mycrate -- ./Cargo.toml:\n\tserde\n\tanyhow\nnested -- ./crates/nested/Cargo.toml:\n\tregex\nDone!\n";
const MACHETE_CLEAN = "Analyzing dependencies of crates in this directory...\n" +
  "cargo-machete didn't find any unused dependencies in this directory. Good job!\nDone!\n";
const rawCtx = (id, over = {}) => ({ tool: tool(id), mode: "static", repoRoot: "/repo", scratch: "/repo/.out/tools/x",
  files: ["Cargo.toml", "crates/nested/Cargo.toml", "src/a.css", "src/b.css", "app.py", "go.mod", "svc/main.go"], ...over });

test("raw: cargo-machete's unused dependencies, which carry no line number, become candidates on their manifest", () => {
  const found = ADAPTERS.raw.normalize([run("main", MACHETE_FOUND, 1)], rawCtx("cargo-machete"));
  assert.equal(found.ok, true);
  assert.deepEqual(found.candidates.map(brief), [
    "dead-code|Cargo.toml|null|serde|true", "dead-code|Cargo.toml|null|anyhow|true", "dead-code|crates/nested/Cargo.toml|null|regex|true",
  ]);
  assert.match(found.candidates[0].detail, /unused dependency/);
  assert.deepEqual(ADAPTERS.raw.normalize([run("main", MACHETE_CLEAN, 0)], rawCtx("cargo-machete")).candidates, []);
});

test("raw: purgecss's rejected selectors become candidates per css file, and a file with none is clean", () => {
  const json = JSON.stringify([
    { css: ".used{}", file: "/repo/src/a.css", rejected: [".unused", ".old"] },
    { css: ".kept{}", file: "/repo/src/b.css", rejected: [] },
  ]);
  const found = ADAPTERS.raw.normalize([run("main", json, 0)], rawCtx("purgecss"));
  assert.equal(found.ok, true);
  assert.deepEqual(found.candidates.map(brief), ["dead-code|src/a.css|null|.unused|true", "dead-code|src/a.css|null|.old|true"]);
  const clean = ADAPTERS.raw.normalize([run("main", JSON.stringify([{ css: "", file: "/repo/src/b.css", rejected: [] }]), 0)], rawCtx("purgecss"));
  assert.deepEqual(clean.candidates, []);
  const garbled = ADAPTERS.raw.normalize([run("main", "Error: no css files found", 0)], rawCtx("purgecss"));
  assert.equal(garbled.ok, false);
  assert.match(garbled.note, /unparseable purgecss JSON/);
});

test("raw: a line that passes the tool's filter but names no line number is never dropped", () => {
  const line = "warning IDE0051: Private member 'Widget.unused' is unused [/repo/App/App.csproj]";
  const found = ADAPTERS.raw.normalize([run("main", `Build started\n${line}\n`, 0)],
    rawCtx("dotnet-build", { files: ["App/App.csproj", "App/Widget.cs"] }));
  assert.equal(found.ok, true);
  assert.deepEqual(found.candidates.map((c) => [c.file, c.line, c.noisy]), [["App/App.csproj", null, true]]);
  assert.ok(found.candidates[0].detail.includes("IDE0051"));
  const unnamed = ADAPTERS.raw.normalize([run("main", "warning IDE0051: Private member 'Widget.unused' is unused\n", 0)],
    rawCtx("dotnet-build", { files: ["App/App.csproj", "App/Widget.cs"], anchorFiles: ["App/App.csproj"] }));
  assert.deepEqual(unnamed.candidates.map((c) => c.file), ["App/App.csproj"], "anchored on the stack's own manifest");
});

test("raw: a findings exit code with no recognised finding line is a failed run, not a clean one", () => {
  const golint = (stdout, stderr, status = 1) => ADAPTERS.raw.normalize([{ invocationId: "main", status, stdout, stderr, error: null }], rawCtx("staticcheck"));
  const broken = golint("", "go: downloading honnef.co/go/tools v0.8.2\ngo: honnef.co/go/tools@v0.8.2: network unreachable\n");
  assert.equal(broken.ok, false);
  assert.match(broken.note, /exit 1/);
  const found = golint("svc/main.go:3:6: func unused is unused (U1000)\n", "");
  assert.equal(found.ok, true);
  assert.deepEqual(found.candidates.map(brief), ["dead-code|svc/main.go|3|null|true"]);
  assert.equal(golint("", "", 0).ok, true, "exit 0 with no output is a clean run");
  const vulture = ADAPTERS.raw.normalize([run("main", "", 3)], rawCtx("vulture"));
  assert.equal(vulture.ok, false, "vulture's findings exit with no finding line cannot be a clean run");
});

test("tsc: a diagnostics exit with no diagnostic line is a failed run", () => {
  const broken = ADAPTERS.tsc.normalize([run("main", "error TS5083: Cannot read file '/repo/tsconfig.json'.\n", 2)], ctx({ tool: tool("tsc") }));
  assert.equal(broken.ok, false);
  assert.match(broken.note, /exit 2/);
});

const jscpdCtx = (report, over = {}) => {
  const scratch = makeTempDir("hyg-jscpd-");
  if (report !== undefined) {
    mkdirSync(join(scratch, "report"), { recursive: true });
    writeFileSync(join(scratch, "report", "jscpd-report.json"), typeof report === "string" ? report : JSON.stringify(report));
  }
  return { tool: { id: "jscpd", kinds: ["duplicate-logic"],
    modes: { static: { invocations: [{ id: "main", args: ["--ignore", "**/dist/**,**/fixtures/**", "."] }] } } },
    mode: "static", repoRoot: "/repo", scratch, files: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"], read: () => null, ...over };
};
const side = (name, start) => ({ name, start, end: start + 11 });
const pair = (a, b, fragment, extra = {}) => ({ format: "typescript", lines: 12, tokens: 60, fragment, firstFile: side(...a), secondFile: side(...b), ...extra });
const cloneKey = (normalized) => `clone ${createHash("sha256").update(normalized).digest("hex").slice(0, 12)}`;
const clone = (c) => `${c.kind}|${c.file}|${c.line}|${c.symbol}|${c.clusterKey === c.anchor}|${c.detail}`;

test("jscpd: clone pairs union into families, one candidate per tracked instance under one family key", () => {
  const result = ADAPTERS.jscpd.normalize([run("main", "")], jscpdCtx({ statistics: {}, duplicates: [
    pair(["src/b.ts", 10], ["/repo/src/c.ts", 1], "const x = 1;\n  return x;", { tokens: 61 }),
    pair(["src/a.ts", 3], ["src/b.ts", 10], "const x =   1;\nreturn x;"),
    pair(["src/a.ts", 40], ["dist/a.js", 5], "other();"),
    pair(["src/d.ts", 1], ["src/d.ts", 30], "zeta();\n  eta();", { format: "javascript", lines: 4, tokens: 52 }),
  ] }));
  assert.equal(result.ok, true);
  const family = cloneKey("const x = 1; return x;");
  assert.deepEqual(result.candidates.map(clone), [
    "duplicate-logic|src/a.ts|3|null|true|12 lines, 60 tokens (typescript)",
    "duplicate-logic|src/b.ts|10|null|true|12 lines, 61 tokens (typescript)",
    "duplicate-logic|src/c.ts|1|null|true|12 lines, 61 tokens (typescript)",
    "duplicate-logic|src/d.ts|1|null|true|4 lines, 52 tokens (javascript)",
    "duplicate-logic|src/d.ts|30|null|true|4 lines, 52 tokens (javascript)",
  ]);
  assert.deepEqual([...new Set(result.candidates.slice(0, 3).map((c) => c.clusterKey))], [family]);
  assert.equal(result.candidates[3].clusterKey, cloneKey("zeta(); eta();"));
  assert.ok(result.candidates.every((c) => c.noisy === false));
  assert.equal(result.note, "excludes **/dist/**, **/fixtures/**");
});

test("jscpd: a missing, unparsable or duplicates-less report fails the tool", () => {
  for (const report of [undefined, "not json", { statistics: {} }]) {
    const result = ADAPTERS.jscpd.normalize([run("main", "")], jscpdCtx(report));
    assert.deepEqual({ ok: result.ok, candidates: result.candidates }, { ok: false, candidates: [] });
    assert.match(result.note, /^jscpd report missing or unreadable: /);
  }
});

test("the registry validator accepts a jscpd-adapter tool", () => {
  const reg = structuredClone(loadRegistry());
  reg.tools.find((t) => t.id === "vulture").adapter = "jscpd";
  assert.deepEqual(validateRegistry(reg).filter((e) => /\.adapter: /.test(e)), []);
});

test("ignoreGlobs lists the --ignore globs of a tool's first invocation in one mode, and nothing for a tool that names none", () => {
  const tool = { modes: { static: { invocations: [{ id: "main", args: [".", "--ignore", "**/dist/**,**/docs/**", "--min-lines", "5"] }, { id: "other", args: ["--ignore", "x"] }] } } };
  assert.deepEqual(ignoreGlobs(tool, "static"), ["**/dist/**", "**/docs/**"]);
  assert.deepEqual(ignoreGlobs(tool, "coverage"), []);
  assert.deepEqual(ignoreGlobs({}, "static"), []);
  assert.ok(ignoreGlobs(loadRegistry().tools.find((t) => t.id === "jscpd"), "static").includes("**/node_modules/**"));
});
