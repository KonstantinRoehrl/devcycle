import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { finalizeSweep, runSweep } from "../../scripts/hygiene-sweep.mjs";
import { loadRegistry } from "../../scripts/hygiene-registry.mjs";
import { makeTempDir } from "../../scripts/temp-dir.mjs";

// The complexity fixture: one hotspot and three decoys (a marked generated file, a large cohesive
// table, a complex file nobody changes), replayed from one recorded lizard run so the suite stays offline.
const FIXTURES = fileURLToPath(new URL("../fixtures/maintain/", import.meta.url));
const TREE = JSON.parse(readFileSync(join(FIXTURES, "complexity-repo.json"), "utf8"));
const LIZARD = readFileSync(join(FIXTURES, "sweep-tool-outputs", "lizard.csv"), "utf8");
const CHURN = new Map([["src/hot.js", 6], ["src/table.js", 5], ["src/small.js", 9]]);

function replay({ argv }) {
  const out = (stdout) => ({ status: 0, stdout, stderr: "", error: null });
  if (argv.includes("--version")) return out("0.0.0\n");
  return out(argv.includes("--csv") ? LIZARD : "");
}

function sweep(tree = TREE) {
  const root = makeTempDir("complexity-fixture-");
  const repo = join(root, "repo");
  for (const [rel, body] of Object.entries(tree)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), body);
  }
  const outDir = join(root, "out");
  const result = runSweep({ repoRoot: repo, outDir, runTool: replay, files: Object.keys(tree), churn: CHURN,
    lines: new Map([["src/hot.js", 140]]), onPath: () => true });
  return { ...result, repo, outDir };
}
const complexity = (result) => result.candidates.filter((c) => c.sweep === "complexity");
const byFile = (result, file) => complexity(result).find((c) => c.file === file);

test("the registry ships the complexity sweep, its tools and a sourced default for every metric", () => {
  const reg = loadRegistry();
  assert.deepEqual(Object.keys(reg.sweeps), ["dead-code", "complexity"]);
  assert.deepEqual(reg.sweeps.complexity.kinds, { "complexity-hotspot": { severity: "medium", history: true }, "complexity-watch": { severity: "low", route: "watch" } });
  const radon = reg.tools.find((t) => t.id === "radon");
  assert.deepEqual([radon.fallbackFor, radon.version, reg.tools.find((t) => t.id === "lizard").version], ["lizard", "6.0.1", "1.26.1"]);
  for (const [stack, metrics] of Object.entries(reg.complexity.defaults))
    for (const [metric, d] of Object.entries(metrics)) assert.match(d.url, /^https:\/\//, `${stack}.${metric}`);
  assert.equal(reg.complexity.defaults["js-ts"].cognitive.value, 15);
});

test("the hotspot ranks first, the stable file is watch, the table is hot, and the generated file is excluded", () => {
  const result = sweep();
  assert.equal(byFile(result, "src/hot.js")?.kind, "complexity-hotspot");
  assert.equal(byFile(result, "src/table.js")?.kind, "complexity-hotspot");
  assert.equal(byFile(result, "src/stable.js")?.kind, "complexity-watch");
  assert.equal(byFile(result, "src/generated-client.js"), undefined);
  assert.equal(byFile(result, "src/small.js"), undefined, "a simple file is no candidate however often it changes");
  const ranked = result.clusters.filter((c) => c.sweep === "complexity");
  assert.deepEqual(ranked.map((c) => c.anchor), ["src/hot.js", "src/table.js"], "watch never reaches verification; the hotspot leads");
  assert.ok(byFile(result, "src/hot.js")?.evidence.at(-1) === "churn: 6 commits, 140 lines");
  const notes = result.coverage.sweeps.complexity.notes;
  assert.ok(notes.includes("lizard: excluded before measurement: generated 1"), notes.join("\n"));
  assert.ok(notes.some((n) => n.includes("byte-identical")));
  assert.equal(result.coverage.rows.find((r) => r.source === "radon").status, "not-applicable", "no Python here");
});

test("finalize: the table clears as cohesive, the hotspot is the one entry, and the stable file is only watched", () => {
  const result = sweep();
  const verdicts = [
    { candidateId: byFile(result, "src/hot.js")?.id, outcome: "verified", note: "read the nested branches of the hot function" },
    { candidateId: byFile(result, "src/table.js")?.id, outcome: "cleared", note: "cohesive: table" },
  ];
  const { entries, counts, sections } = finalizeSweep({ outDir: result.outDir, verdicts, repoRoot: result.repo, previousCounts: null });
  const own = entries.filter((e) => e.culpritKind.startsWith("complexity"));
  assert.deepEqual(own.map((e) => [e.culpritKind, e.canonicalLocation, e.severity, e.confidence]),
    [["complexity-hotspot", "src/hot.js", "medium", "verified"]]);
  assert.deepEqual(counts.sweeps.complexity.categories["complexity-watch"], { verified: 0, suspected: 1, cleared: 0, complete: true });
  const s = sections.complexity;
  assert.match(s, /^## Complexity hotspots\n\nFindings: 1, in blast-radius order\. Cleared: cohesive: table 1\.\n/);
  assert.match(s, /### Watch\n\n- `src\/stable\.js`: score \d+, 0 commits\n/);
});

test("mutation: without its header marker the generated file is measured like any other", () => {
  const tree = { ...TREE, "src/generated-client.js": TREE["src/generated-client.js"].replace(/^.*@generated.*\n/, "") };
  assert.ok(byFile(sweep(tree), "src/generated-client.js"), "the marker is what excludes it");
});
