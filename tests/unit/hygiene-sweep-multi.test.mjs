import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { clusterCandidates, orderForVerification, runSweep, selectTools } from "../../scripts/hygiene-sweep.mjs";
import { loadRegistry } from "../../scripts/hygiene-registry.mjs";
import { SCANNERS } from "../../scripts/hygiene-scanners.mjs";
import { findingId, recordMaintenanceFinding } from "../../scripts/maintenance-findings.mjs";

// A second sweep beside dead code: one verification kind fed by a whole-tree scanner and a raw
// tool, one judgment kind fed by a hotspot-scoped scanner that also hands the judgment material.
function twoSweeps() {
  const reg = structuredClone(loadRegistry());
  reg.sweeps.twins = { title: "Twins", noun: "twins", notCovered: ["twins across languages"],
    kinds: { twin: { severity: "medium" }, "judged-twin": { severity: "low", route: "judgment" } } };
  reg.scanners["twin-scan"] = { sweep: "twins", kinds: ["twin"], stacks: null };
  reg.scanners["twin-index"] = { sweep: "twins", kinds: ["judged-twin"], stacks: null, scope: "hotspots" };
  reg.tools.push({ id: "twin-tool", sweep: "twins", stacks: ["js-ts"], kinds: ["twin"], adapter: "raw", version: "1.0.0",
    command: { path: "twin-tool" }, when: { anyFile: ["twins.json"] }, modes: { static: { invocations: [{ id: "main", args: ["."] }] } } });
  return reg;
}
const seen = {};
const twinScan = { id: "twin-scan", scan: ({ files }) => files.filter((f) => f.endsWith(".js")).map((file) => (
  { kind: "twin", file, line: 1, symbol: "LIMIT", detail: "LIMIT=5", clusterKey: "constant LIMIT=5", anchor: "constant LIMIT=5" })) };
const twinIndex = { id: "twin-index", scan: (ctx) => { seen.indexFiles = ctx.files; return []; },
  material: (ctx) => ctx.files.map((file) => ({ key: file, kinds: ["judged-twin"], file, signatures: ["f(a)"] })) };
const blamer = { id: "twin-scan", blameUnit: ["file was", "files were"],
  scan: ({ files, blame }) => { for (const f of files.filter((x) => x.endsWith(".js"))) blame(f); return []; } };
function repoWith(files) {
  const dir = makeTempDir("hyg-multi-");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}
const TREE = { "package.json": "{}", "src/a.js": "export const LIMIT = 5;\n", "src/b.js": "const LIMIT = 5;\n" };
const sweep = (over = {}) => {
  const repo = over.repo ?? repoWith(TREE);
  return runSweep({ repoRoot: repo, outDir: join(makeTempDir("hyg-multi-out-"), "sweep"), registry: twoSweeps(),
    runTool: () => ({ status: 0, stdout: "", stderr: "", error: null }), files: Object.keys(TREE), churn: new Map([["src/a.js", 3]]),
    commits: [], onPath: () => true, scanners: [...SCANNERS.filter((s) => s.id !== "twin-scan"), twinScan, twinIndex], ...over });
};
const read = (out, name) => JSON.parse(readFileSync(join(out, name), "utf8"));

test("one run sweeps every registered sweep and tags candidates, rows and clusters with it", () => {
  const { candidates, clusters, coverage } = sweep();
  const twins = candidates.filter((c) => c.kind === "twin");
  assert.equal(twins.length, 2);
  assert.ok(twins.every((c) => c.sweep === "twins"));
  assert.ok(coverage.rows.every((r) => typeof r.sweep === "string"));
  assert.equal(coverage.rows.find((r) => r.source === "twin-scan").sweep, "twins");
  assert.equal(coverage.rows.find((r) => r.source === "knip").sweep, "dead-code");
  assert.deepEqual(Object.keys(coverage.sweeps), ["dead-code", "twins"]);
  assert.deepEqual([coverage.sweeps.twins.title, coverage.sweeps.twins.noun], ["Twins", "twins"]);
  assert.deepEqual(coverage.sweeps.twins.sweepKinds, ["twin", "judged-twin"]);
  assert.deepEqual(coverage.sweepKinds, [...coverage.sweeps["dead-code"].sweepKinds, "twin", "judged-twin"]);
  assert.ok(coverage.fullKinds.includes("twin") && coverage.sweeps.twins.fullKinds.includes("twin"));
  assert.equal(clusters.find((c) => c.kind === "twin").route, "verification");
});

test("candidates sharing a clusterKey form one cluster anchored on their anchor", () => {
  const { clusters } = sweep();
  const twin = clusters.filter((c) => c.kind === "twin");
  assert.equal(twin.length, 1);
  assert.equal(twin[0].clusterId, "twin:constant LIMIT=5");
  assert.equal(twin[0].anchor, "constant LIMIT=5");
  assert.deepEqual(twin[0].files, ["src/a.js", "src/b.js"]);
  assert.equal(twin[0].sweep, "twins");
});

test("noToolStacks counts a stack whose registered tool for that sweep does not apply", () => {
  const { coverage } = sweep();
  assert.deepEqual(coverage.sweeps.twins.noToolStacks, ["js-ts"], "twin-tool needs twins.json, which the repo lacks");
  assert.deepEqual(coverage.sweeps["dead-code"].noToolStacks, []);
  assert.deepEqual(coverage.sweeps.twins.notCovered, ["twins across languages"]);
});

test("verification clusters interleave across sweeps; judgment clusters come last", () => {
  const c = (clusterId, sweep, route) => ({ clusterId, sweep, route });
  const ordered = orderForVerification([c("d1", "dead-code"), c("d2", "dead-code"), c("d3", "dead-code"),
    c("j1", "twins", "judgment"), c("t1", "twins", "verification"), c("t2", "twins")], ["dead-code", "twins"]);
  assert.deepEqual(ordered.map((x) => x.clusterId), ["d1", "t1", "d2", "t2", "d3", "j1"]);
  const only = [c("d1", "dead-code"), c("d2", "dead-code")];
  assert.deepEqual(orderForVerification(only, ["dead-code"]), only, "one sweep keeps today's order");
});

test("candidates.json persists churn, and each cluster counts the commits that touch two of its files", () => {
  const out = join(makeTempDir("hyg-multi-out-"), "sweep");
  sweep({ outDir: out, commits: [["src/a.js", "src/b.js"], ["src/a.js"], ["src/b.js", "src/a.js", "x"]] });
  const written = read(out, "candidates.json");
  assert.deepEqual(written.churn, { "src/a.js": 3 });
  assert.equal(written.clusters.find((cl) => cl.kind === "twin").coChange, 2);
  const lone = clusterCandidates([{ id: "x", sweep: "dead-code", kind: "dead-code", file: "a.ts", line: 1, symbol: "x", cleared: null }],
    new Map(), [["a.ts"], ["a.ts", "b.ts"]]);
  assert.equal(lone[0].coChange, 0, "a one-file cluster never co-changes");
});

test("a hotspot-scoped scanner sees only the hotspot files, and its row says where they came from", () => {
  const listed = sweep({ hotspots: ["src/b.js", "not-tracked.js"] });
  assert.deepEqual(seen.indexFiles, ["src/b.js"]);
  assert.deepEqual(listed.coverage.hotspots, { source: "list", files: ["src/b.js"] });
  const row = listed.coverage.rows.find((r) => r.source === "twin-index");
  assert.equal(row.scope, "hotspots");
  assert.match(row.note, /^hotspot files only: 1 from the step 3 list$/);
  const fallback = sweep();
  assert.deepEqual(fallback.coverage.hotspots, { source: "churn", files: ["src/a.js"] });
  assert.match(fallback.coverage.rows.find((r) => r.source === "twin-index").note,
    /^hotspot files only: the 1 highest-churn files \(no --hotspots list\)$/);
});

test("judgment inputs hold judgment-routed candidates, scanner material and the kind's open store records", () => {
  const repo = repoWith(TREE);
  const id = findingId("judged-twin", "pair f,g");
  recordMaintenanceFinding(repo, { findingKind: "maintenance-finding", findingId: id, culpritKind: "judged-twin", title: "f and g",
    severity: "low", confidence: "verified", affectedFiles: ["src/a.js", "src/b.js"], firstSeen: "2026-11-01", lastSeen: "2026-11-01",
    passes: 1, verify: "none" });
  const dismissed = findingId("judged-twin", "pair h,i");
  recordMaintenanceFinding(repo, { findingKind: "maintenance-finding", findingId: dismissed, culpritKind: "judged-twin", title: "h and i",
    severity: "low", confidence: "verified", affectedFiles: ["src/a.js"], firstSeen: "2026-11-01", lastSeen: "2026-11-01",
    passes: 1, verify: "none", lifecycle: "dismissed", dismissedReason: "deliberate" });
  const out = join(makeTempDir("hyg-multi-out-"), "sweep");
  sweep({ repo, outDir: out, hotspots: ["src/a.js"] });
  const { items } = read(out, "judgment-inputs.json");
  assert.deepEqual(items.map((i) => i.id), [...items.map((i) => i.id)].sort());
  assert.deepEqual(items.find((i) => i.type === "material"),
    { id: "material:twin-index:src/a.js", type: "material", sweep: "twins", kinds: ["judged-twin"], source: "twin-index", key: "src/a.js",
      file: "src/a.js", signatures: ["f(a)"] });
  const records = items.filter((i) => i.type === "record");
  assert.deepEqual(records, [{ id: `record:${id}`, type: "record", sweep: "twins", kinds: ["judged-twin"], findingId: id,
    title: "f and g", affectedFiles: ["src/a.js", "src/b.js"] }]);
});

test("with dead code the only sweep, judgment inputs are empty", () => {
  const out = join(makeTempDir("hyg-multi-out-"), "sweep");
  runSweep({ repoRoot: repoWith(TREE), outDir: out, runTool: () => ({ status: 0, stdout: "", stderr: "", error: null }),
    files: Object.keys(TREE), churn: new Map(), onPath: () => true });
  assert.deepEqual(read(out, "judgment-inputs.json"), { items: [] });
});

test("each sweep has its own blame budget, so one sweep's blame cannot cap another's", () => {
  const files = { "package.json": "{}", "src/a.js": "x\n", "src/b.js": "y\n", "src/c.js": "// TODO: later\n" };
  const { coverage } = sweep({ repo: repoWith(files), files: Object.keys(files), blameCap: 1,
    scanners: [...SCANNERS, blamer, twinIndex] });
  const twin = coverage.rows.find((r) => r.source === "twin-scan");
  assert.equal(twin.status, "partial");
  assert.match(twin.note, /git blame capped at 1 files; 2 files were not aged/);
  assert.doesNotMatch(coverage.rows.find((r) => r.source === "stale-todo").note ?? "", /capped/);
});

test("a packageDependency tool applies only when the repo-root package.json declares the package", () => {
  const reg = twoSweeps();
  reg.tools.find((t) => t.id === "twin-tool").when = { packageDependency: ["twin-plugin"] };
  const pick = (rootPackage) => selectTools(reg, { stacks: ["js-ts"], files: ["package.json"], consent: { executing: false }, rootPackage })
    .find((s) => s.tool.id === "twin-tool").status;
  assert.equal(pick({ devDependencies: { "twin-plugin": "1.0.0" } }), "run");
  assert.equal(pick({ dependencies: { "twin-plugin": "1.0.0" } }), "run");
  assert.equal(pick({ dependencies: { other: "1" } }), "not-applicable");
  assert.equal(pick(null), "not-applicable");
});
