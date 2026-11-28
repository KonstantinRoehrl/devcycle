import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { finalizeSweep, runSweep } from "../../scripts/hygiene-sweep.mjs";
import { loadRegistry } from "../../scripts/hygiene-registry.mjs";
import { applyPass } from "../../scripts/maintenance-findings.mjs";
import { makeTempDir } from "../../scripts/temp-dir.mjs";

const FIXTURES = fileURLToPath(new URL("../fixtures/maintain/", import.meta.url));
const TREE = JSON.parse(readFileSync(join(FIXTURES, "duplication-repo.json"), "utf8"));
const HOTSPOTS = ["src/format/a.ts", "src/format/b.ts", "src/report/digest.ts", "src/report/summary.ts"];

// Replays the committed jscpd report into the --output directory the spine hands it; any other tool reports nothing.
function replay({ argv }) {
  const out = (stdout = "") => ({ status: 0, stdout, stderr: "", error: null });
  if (argv.includes("--version")) return out("0.0.0\n");
  if (argv.some((a) => a.startsWith("jscpd@"))) {
    const dir = argv[argv.indexOf("--output") + 1];
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "jscpd-report.json"), readFileSync(join(FIXTURES, "sweep-tool-outputs", "jscpd.json")));
  }
  return out();
}

function sweep() {
  const root = makeTempDir("dup-fixture-");
  const repo = join(root, "repo");
  const out = join(root, "out");
  for (const [rel, body] of Object.entries(TREE)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), body);
  }
  return { repo, out, ...runSweep({ repoRoot: repo, outDir: out, runTool: replay, files: Object.keys(TREE),
    churn: new Map(), now: Date.parse("2026-11-28T00:00:00Z"), onPath: () => true, hotspots: HOTSPOTS }) };
}

const KNOWN = [
  ["a constant declared in two files", "duplicate-constant", "constant MAX_RETRIES=12", 2],
  ["a constant redefined in three files", "duplicate-constant", "constant RETRY_DELAY_MS=1500", 3],
  ["a literal restated where an exported constant exists", "restated-literal", "src/limits.ts#BRAND_TIMEOUT_MS", 1],
  ["a CSS token restated as a literal in TS", "restated-literal", "src/theme.css#--brand-color", 1],
  ["two differently named helpers with the same body", "duplicate-logic", "body makeSlug,toSlug", 2],
  ["one env var read in three files", "scattered-env-read", "env API_BASE_URL", 3],
];

test("every known duplication case is an uncleared, clustered candidate of its kind", () => {
  const { candidates, clusters } = sweep();
  const byId = new Map(candidates.map((c) => [c.id, c]));
  for (const [label, kind, anchor, size] of KNOWN) {
    const cluster = clusters.find((k) => k.kind === kind && k.anchor === anchor);
    assert.ok(cluster, `${label}: no ${kind} cluster anchored on ${anchor}`);
    assert.equal(cluster.sweep, "duplication", label);
    assert.equal(cluster.candidates.length, size, label);
    assert.ok(cluster.candidates.every((id) => byId.get(id).cleared === null), `${label}: a member is cleared`);
  }
  const clones = clusters.filter((k) => k.kind === "duplicate-logic" && /^clone [0-9a-f]{12}$/.test(k.anchor));
  assert.equal(clones.length, 1, "one textual clone family");
  assert.deepEqual([...clones[0].files].sort(), ["src/report/digest.ts", "src/report/summary.ts"]);
});

test("the decoys are no candidate, or cleared with their reason and in no cluster", () => {
  const { candidates, clusters, coverage } = sweep();
  assert.deepEqual(candidates.filter((c) => c.symbol === "FULL_PERCENT" || c.symbol === "MAX_PAGE_ITEMS" || c.clusterKey === "value 100"), [],
    "two equal numbers with unrelated names");
  const copies = candidates.filter((c) => c.clusterKey === "constant PAGE_SIZE=25");
  assert.equal(copies.length, 2);
  assert.ok(copies.every((c) => c.cleared === "documented deliberate copy"));
  assert.ok(!clusters.some((k) => k.anchor === "constant PAGE_SIZE=25"));
  const jscpd = coverage.rows.find((r) => r.source === "jscpd");
  assert.equal(jscpd.status, "ran");
  assert.match(jscpd.note, /^excludes \*\*\/node_modules\/\*\*, /);
});

test("the judgment inputs hold a signature index of every hotspot file", () => {
  const { out } = sweep();
  const { items } = JSON.parse(readFileSync(join(out, "judgment-inputs.json"), "utf8"));
  const index = items.filter((i) => i.type === "material" && i.source === "semantic-index");
  assert.deepEqual(index.map((i) => i.id), HOTSPOTS.map((f) => `material:semantic-index:${f}`));
  assert.ok(index.every((i) => i.sweep === "duplication" && i.functions.length > 0));
});

test("a verified duplication finding is new on its first pass and persisting on the next", () => {
  const { repo, out, clusters } = sweep();
  const target = clusters.find((k) => k.anchor === "constant MAX_RETRIES=12");
  const verdicts = target.candidates.map((candidateId) => ({ candidateId, outcome: "verified", note: "one retry budget, two owners" }));
  finalizeSweep({ outDir: out, verdicts, repoRoot: repo, registry: loadRegistry(), previousCounts: null });
  const entries = JSON.parse(readFileSync(join(out, "entries.json"), "utf8"))
    .filter((e) => e.culpritKind === "duplicate-constant" && e.canonicalLocation === "constant MAX_RETRIES=12");
  assert.equal(entries.length, 1);
  const first = applyPass({ root: repo, entries, date: "2026-11-28" });
  assert.deepEqual([first.new.length, first.persisting.length], [1, 0]);
  const second = applyPass({ root: repo, entries, date: "2026-11-29" });
  assert.deepEqual([second.new.length, second.persisting.length], [0, 1]);
});
