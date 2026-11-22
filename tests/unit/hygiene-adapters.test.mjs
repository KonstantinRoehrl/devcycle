import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { loadRegistry } from "../../scripts/hygiene-registry.mjs";
import { ADAPTERS } from "../../scripts/hygiene-adapters.mjs";
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
