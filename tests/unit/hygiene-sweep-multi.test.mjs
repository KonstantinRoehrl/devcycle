import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { clusterCandidates, finalizeSweep, orderForVerification, runSweep, selectTools } from "../../scripts/hygiene-sweep.mjs";
import { ADAPTERS } from "../../scripts/hygiene-adapters.mjs";
import { loadRegistry } from "../../scripts/hygiene-registry.mjs";
import { SCANNERS } from "../../scripts/hygiene-scanners.mjs";
import { findingId, recordMaintenanceFinding } from "../../scripts/maintenance-findings.mjs";
import { gitToplevel, runsDirForRepo } from "../../scripts/run-record.mjs";

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

const VERIFIED_TWINS = (candidates) => candidates.filter((c) => c.kind === "twin")
  .map((c) => ({ candidateId: c.id, outcome: "verified", note: "same name and value" }));
function finalized(over = {}) {
  const out = join(makeTempDir("hyg-multi-out-"), "sweep");
  const { candidates } = sweep({ outDir: out, ...(over.run ?? {}) });
  const registry = over.registry ?? twoSweeps();
  const result = finalizeSweep({ outDir: out, verdicts: over.verdicts?.(candidates) ?? VERIFIED_TWINS(candidates),
    judgments: over.judgments ?? null, depth: over.depth ?? "standard", repoRoot: out, registry, previousCounts: null });
  return { out, candidates, ...result };
}

test("finalize writes one section per sweep under its title, each with its own coverage statement", () => {
  const { out, entries, counts } = finalized();
  const dead = readFileSync(join(out, "section-dead-code.md"), "utf8");
  const twins = readFileSync(join(out, "section-twins.md"), "utf8");
  assert.match(dead, /^## Dead code\n/);
  assert.match(twins, /^## Twins\n\nFindings: 1, in blast-radius order\. Cleared: none\.\n/);
  assert.ok(twins.includes("- js-ts: no twins tool for this stack; heuristic scan only"), twins);
  assert.ok(twins.includes("- not covered: twins across languages"));
  assert.ok(twins.includes("- hotspot-only: twin-index (hotspot files only: the 1 highest-churn files (no --hotspots list))"), twins);
  assert.doesNotMatch(twins, /coverage-run/);
  assert.match(dead, /- not run: coverage-run/);
  assert.doesNotMatch(dead, /twin/);
  assert.equal(existsSync(join(out, "section.md")), false);
  assert.deepEqual(Object.keys(counts.sweeps), ["dead-code", "twins"]);
  assert.deepEqual(counts.sweeps.twins.categories.twin, { verified: 2, suspected: 0, cleared: 0, complete: true });
  assert.deepEqual(entries.find((e) => e.culpritKind === "twin"), { culpritKind: "twin", canonicalLocation: "constant LIMIT=5",
    title: "2 twin items in constant LIMIT=5", severity: "medium", confidence: "verified", affectedFiles: ["src/a.js", "src/b.js"] });
  assert.deepEqual(JSON.parse(readFileSync(join(out, "counts.json"), "utf8")), counts);
});

test("a judgment-routed kind is complete only when the judgment reached every one of its inputs", () => {
  const without = finalized();
  const cov = (out) => JSON.parse(readFileSync(join(out, "coverage.json"), "utf8"));
  assert.ok(!cov(without.out).fullKinds.includes("judged-twin"));
  assert.ok(!cov(without.out).sweeps.twins.fullKinds.includes("judged-twin"));
  const reachedAll = finalized({ judgments: { reached: ["material:twin-index:src/a.js"], verdicts: [], added: [] } });
  assert.ok(cov(reachedAll.out).fullKinds.includes("judged-twin"));
  assert.ok(cov(reachedAll.out).sweeps.twins.fullKinds.includes("judged-twin"));
  assert.throws(() => finalized({ judgments: { reached: ["nope"], verdicts: [], added: [] } }), /judgment reached unknown input "nope"/);
});

test("judgment-added candidates cluster and rank, and one that names no comparison stays suspected", () => {
  const add = (file, symbol, note) => ({ sweep: "twins", kind: "judged-twin", file, line: 1, symbol, clusterKey: "semantic f,g",
    anchor: "semantic f,g", detail: "f and g parse dates", outcome: "verified", note });
  const { out, entries } = finalized({ judgments: { reached: [], verdicts: [],
    added: [add("src/a.js", "f", "both parse ISO dates; bodies compared"), add("src/b.js", "g", "")] } });
  assert.deepEqual(entries.find((e) => e.culpritKind === "judged-twin"), { culpritKind: "judged-twin", canonicalLocation: "semantic f,g",
    title: "2 judged-twin items in semantic f,g", severity: "low", confidence: "verified", affectedFiles: ["src/a.js", "src/b.js"] });
  assert.ok(readFileSync(join(out, "section-twins.md"), "utf8").includes("- `src/b.js:1` `g`: suspected (judgment named no comparison)"));
  assert.throws(() => finalized({ judgments: { reached: [], verdicts: [], added: [{ ...add("src/a.js", "f", "x"), kind: "twin" }] } }),
    /added judgment kind "twin" is not a judgment-routed kind of twins/);
  assert.throws(() => finalized({ judgments: { reached: [], verdicts: [], added: [{ ...add("src/a.js", "f", "x"), anchor: "" }] } }),
    /added judgment needs file, clusterKey and anchor/);
});

test("a verdict answers only verification-routed candidates and a judgment only judgment-routed ones", () => {
  const judgedScan = { id: "twin-index", scan: ({ files }) => files.map((file) => ({ kind: "judged-twin", file, line: 2, symbol: "g", detail: "g looks like f" })) };
  const run = { scanners: [...SCANNERS, twinScan, judgedScan] };
  const { out } = finalized({ run });
  assert.ok(readFileSync(join(out, "section-twins.md"), "utf8").includes("- `src/a.js:2` `g`: suspected (not judged: budget)"));
  assert.throws(() => finalized({ run, verdicts: (cs) => cs.filter((c) => c.kind === "judged-twin")
    .map((c) => ({ candidateId: c.id, outcome: "verified", note: "x" })) }), /verdict for ".*", which routes to judgment/);
  assert.throws(() => finalized({ run, verdicts: () => [], judgments: { reached: [], added: [],
    verdicts: [{ candidateId: "twin-scan:src/a.js:1:LIMIT", outcome: "verified", note: "x" }] } }), /judgment for ".*", which routes to verification/);
});

test("a severity raise stops at the kind's cap unless the verdict names a reason that passes it", () => {
  const capped = () => { const r = twoSweeps(); Object.assign(r.sweeps.twins.kinds.twin, { maxSeverity: "medium", raiseBeyondCapWhen: ["shared across services"] }); return r; };
  const raise = (extra) => (cs) => VERIFIED_TWINS(cs).map((v) => ({ ...v, severity: "critical", ...extra }));
  const severity = (r) => r.entries.find((e) => e.culpritKind === "twin").severity;
  assert.equal(severity(finalized({ registry: capped(), verdicts: raise({}) })), "medium");
  assert.equal(severity(finalized({ registry: capped(), verdicts: raise({ raiseReason: "shared across services" }) })), "critical");
  assert.throws(() => finalized({ verdicts: raise({ raiseReason: "" }) }), /invalid raiseReason for/);
});

test("at thorough, a sweep's clusters order by co-change first, then blast radius", () => {
  const out = makeTempDir("hyg-multi-hand-");
  const cand = (id, file) => ({ id, sweep: "twins", kind: "twin", source: "twin-scan", file, line: 1, symbol: id, detail: "", noisy: false, cleared: null });
  const cluster = (key, files, ids, blastRadius, coChange) => ({ clusterId: `twin:${key}`, sweep: "twins", kind: "twin", route: "verification",
    anchor: key, files, candidates: ids, blastRadius, coChange });
  writeFileSync(join(out, "candidates.json"), JSON.stringify({ candidates: [cand("p", "a.js"), cand("q", "b.js")],
    clusters: [cluster("wide", ["a.js"], ["p"], 5, 0), cluster("tight", ["b.js"], ["q"], 1, 3)], churn: {} }));
  const block = (title, noun, kinds) => ({ title, noun, noToolStacks: [], notCovered: [], sweepKinds: kinds, sourcedKinds: kinds, fullKinds: [] });
  const dead = Object.keys(loadRegistry().sweeps["dead-code"].kinds);
  writeFileSync(join(out, "coverage.json"), JSON.stringify({ stacks: [], dependenciesInstalled: true, consent: { executing: false, coverage: false },
    config: { staleTodoDays: 365, source: "registry" }, hotspots: { source: "churn", files: [] }, degraded: [], rows: [],
    sweeps: { "dead-code": block("Dead code", "dead-code", dead), twins: block("Twins", "twins", ["twin", "judged-twin"]) },
    sweepKinds: [...dead, "twin", "judged-twin"], sourcedKinds: [], fullKinds: [] }));
  writeFileSync(join(out, "judgment-inputs.json"), JSON.stringify({ items: [] }));
  const verdicts = [{ candidateId: "p", outcome: "verified", note: "x" }, { candidateId: "q", outcome: "verified", note: "y" }];
  const order = (depth) => finalizeSweep({ outDir: out, verdicts, depth, repoRoot: out, registry: twoSweeps(), previousCounts: null })
    .entries.map((e) => e.canonicalLocation);
  assert.deepEqual(order("standard"), ["wide", "tight"]);
  assert.deepEqual(order("thorough"), ["tight", "wide"]);
  assert.match(readFileSync(join(out, "section-twins.md"), "utf8"), /^## Twins\n\nFindings: 2, in co-change then blast-radius order\./);
  writeFileSync(join(out, "coverage.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(out, "coverage.json"), "utf8")), sweeps: {} }));
  assert.throws(() => order("standard"), /coverage.json has no block for sweep "dead-code"/);
});

test("finalize --run appends one set of sweep-count rows per sweep, once", () => {
  const runs = makeTempDir("hyg-multi-runs-");
  const saved = process.env.DEVCYCLE_RUNS_DIR;
  process.env.DEVCYCLE_RUNS_DIR = runs;
  try {
    const out = join(makeTempDir("hyg-multi-out-"), "sweep");
    const { candidates } = sweep({ outDir: out });
    const runId = "e".repeat(16);
    const recordDir = runsDirForRepo(gitToplevel(out));
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(join(recordDir, `${runId}.jsonl`), JSON.stringify({ kind: "run", runId, startedAt: "2026-11-28T00:00:00Z" }) + "\n");
    const go = () => finalizeSweep({ outDir: out, verdicts: VERIFIED_TWINS(candidates), runId, repoRoot: out, registry: twoSweeps() });
    assert.deepEqual(go().ratchet, { "dead-code": "appended", twins: "appended" });
    const rows = readFileSync(join(recordDir, `${runId}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .filter((r) => r.kind === "sweep-count");
    assert.deepEqual(rows.filter((r) => r.sweep === "twins").map((r) => r.category), ["twin", "judged-twin"]);
    assert.equal(rows.filter((r) => r.sweep === "dead-code").length, Object.keys(loadRegistry().sweeps["dead-code"].kinds).length);
    assert.deepEqual(go().ratchet, { "dead-code": "already-recorded", twins: "already-recorded" });
  } finally {
    if (saved === undefined) delete process.env.DEVCYCLE_RUNS_DIR; else process.env.DEVCYCLE_RUNS_DIR = saved;
  }
});

// A complexity-shaped sweep: a scored verification kind, a watch kind, a primary tool and its fallback.
function scoredSweeps() {
  const reg = twoSweeps();
  reg.config.hotCommits = 4;
  reg.sweeps.cx = { title: "Cx", noun: "cx", notCovered: [],
    kinds: { "cx-hot": { severity: "medium", history: true }, "cx-watch": { severity: "low", route: "watch" } } };
  const cxTool = (id, extra) => ({ id, sweep: "cx", stacks: ["js-ts"], kinds: ["cx-hot", "cx-watch"], adapter: "cx", version: "1.0.0",
    command: { path: id }, modes: { static: { invocations: [{ id: "main", args: ["."] }] } }, ...extra });
  reg.tools.push(cxTool("cx-fallback", { fallbackFor: "cx-primary" }), cxTool("cx-primary", {}));
  return reg;
}
const cxSeen = { ctx: null, argv: [] };
const cxAdapter = { normalize(runs, ctx) {
  cxSeen.ctx = ctx;
  const c = (kind, file, score) => ({ kind, file, line: null, symbol: null, clusterKey: file, anchor: file, score, detail: "", evidence: ["e"] });
  return { ok: true, candidates: [c("cx-hot", "src/a.js", 7), c("cx-watch", "src/b.js", 2)], note: null, coverage: ["measured 2 files"] };
} };
const cxSweep = (over = {}) => sweep({ registry: scoredSweeps(), lines: new Map([["src/a.js", 40]]),
  adapters: { ...ADAPTERS, cx: cxAdapter }, runTool: ({ argv }) => { cxSeen.argv.push(argv[0]); return { status: 0, stdout: "", stderr: "", error: null }; },
  ...over });

test("a fallback tool is superseded while its primary ran, and runs when the primary could not", () => {
  cxSeen.argv = [];
  const ran = cxSweep();
  const fallbackRow = ran.coverage.rows.find((r) => r.source === "cx-fallback");
  assert.deepEqual([fallbackRow.status, fallbackRow.note], ["not-applicable", "superseded by cx-primary"]);
  assert.equal(ran.coverage.rows.find((r) => r.source === "cx-primary").status, "ran");
  assert.ok(!cxSeen.argv.includes("cx-fallback"), "a superseded fallback never spawns");
  assert.ok(ran.coverage.sweeps.cx.fullKinds.includes("cx-hot"), "a superseded fallback never blocks completeness");
  const fell = cxSweep({ onPath: (name) => name !== "cx-primary" });
  assert.equal(fell.coverage.rows.find((r) => r.source === "cx-primary").status, "unavailable");
  assert.equal(fell.coverage.rows.find((r) => r.source === "cx-fallback").status, "ran");
});

test("adapters get churn, lines, config, registry and stacks, and their coverage notes land on their sweep", () => {
  const reg = scoredSweeps();
  const { coverage } = cxSweep({ registry: reg });
  assert.equal(cxSeen.ctx.churn.get("src/a.js"), 3);
  assert.equal(cxSeen.ctx.lines.get("src/a.js"), 40);
  assert.equal(cxSeen.ctx.config.hotCommits, 4);
  assert.equal(cxSeen.ctx.registry, reg);
  assert.deepEqual(cxSeen.ctx.stacks, ["js-ts"]);
  assert.deepEqual(coverage.sweeps.cx.notes, ["cx-primary: measured 2 files"]);
  assert.deepEqual(coverage.sweeps["dead-code"].notes, []);
});

test("scored candidates weight their cluster, and watch clusters are never sent to verification", () => {
  const out = join(makeTempDir("hyg-multi-out-"), "sweep");
  const { candidates, clusters } = cxSweep({ outDir: out });
  const hot = clusters.find((c) => c.kind === "cx-hot");
  assert.equal(hot.anchor, "src/a.js");
  assert.equal(hot.blastRadius, 7 * (1 + 3));
  assert.ok(candidates.some((c) => c.kind === "cx-watch"), "the watch candidate is kept");
  assert.ok(!clusters.some((c) => c.kind === "cx-watch"));
  assert.ok(!read(out, "candidates.json").clusters.some((c) => c.kind === "cx-watch"));
  const plain = clusterCandidates([{ id: "a", sweep: "dead-code", kind: "dead-code", file: "a.ts", line: 1, symbol: "x", cleared: null }], new Map([["a.ts", 2]]));
  assert.equal(plain[0].blastRadius, 1 * (1 + 2), "an unscored cluster still weighs its file count");
});
