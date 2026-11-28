import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { finalizeSweep, historyIndex } from "../../scripts/hygiene-sweep.mjs";
import { loadRegistry } from "../../scripts/hygiene-registry.mjs";
import { gitToplevel, runsDirForRepo } from "../../scripts/run-record.mjs";

const SCRIPT = fileURLToPath(new URL("../../scripts/hygiene-sweep.mjs", import.meta.url));
const registry = loadRegistry();
const KINDS = Object.keys(registry.sweeps["dead-code"].kinds);

const cand = (source, file, line, symbol, kind, extra = {}) => ({
  id: `${source}:${file}:${line ?? 0}:${symbol ?? ""}`, sweep: "dead-code", kind, source, file, line, symbol,
  detail: "", noisy: false, cleared: null, ...extra,
});
const A = cand("knip", "src/util.ts", 2, "unusedExport", "dead-code");
const B = cand("knip", "src/util.ts", 3, "specOnly", "test-only-code");
const H = cand("knip", "src/util.ts", 4, "otherSpec", "test-only-code");
const C = cand("knip", "src/orphan.ts", null, null, "dead-code", { noisy: true });
const D = cand("css-classes-keyframes", "src/styles.css", 6, ".btn-primary", "dead-code", { cleared: "dynamic prefix" });
const E = cand("angular-io", "src/app/hero.component.ts", 6, "unboundInput", "dead-code");
const F = cand("tsc", "src/widget.ts", 2, "neverRead", "dead-code");
const cluster = (kind, anchor, files, ids, blastRadius) => ({ clusterId: `${kind}:${anchor}`, sweep: "dead-code", kind, route: "verification", anchor, files,
  candidates: ids, blastRadius, coChange: 0 });
const CLUSTERS = [
  cluster("dead-code", "src/util.ts", ["src/util.ts"], [A.id], 3),
  cluster("test-only-code", "src/util.ts", ["src/util.ts"], [B.id, H.id], 3),
  cluster("dead-code", "src/widget.ts", ["src/widget.ts"], [F.id], 2),
  cluster("dead-code", "src", ["src/orphan.ts"], [C.id], 1),
  cluster("dead-code", "src/app/hero.component.ts", ["src/app/hero.component.ts"], [E.id], 1),
];
const row = (source, kinds, status, method, extra = {}) => ({ source, kinds, class: "static", status, method, downloaded: false, version: "1", note: null, sweep: "dead-code", ...extra });
const COVERAGE = {
  stacks: ["js-ts", "python"], dependenciesInstalled: true, consent: { executing: false, coverage: false },
  config: { staleTodoDays: 365, source: "registry" }, hotspots: { source: "churn", files: [] }, degraded: [],
  rows: [
    row("knip", ["dead-code", "test-only-code", "over-exported"], "ran", "tool", { downloaded: true, version: "6.44.2" }),
    row("tsc", ["dead-code"], "failed", "tool", { note: "main: exit 1: boom" }),
    row("css-classes-keyframes", ["dead-code"], "ran", "heuristic"),
    row("stale-todo", ["stale-todo"], "ran", "heuristic"),
  ],
  sweeps: { "dead-code": { title: "Dead code", noun: "dead-code", noToolStacks: ["python"], notCovered: ["unused fonts"],
    sweepKinds: KINDS, sourcedKinds: KINDS, fullKinds: ["stale-todo"] } },
  sweepKinds: KINDS, sourcedKinds: KINDS, fullKinds: ["stale-todo"],
};
const withFull = (fullKinds) => ({ ...COVERAGE, fullKinds, sweeps: { "dead-code": { ...COVERAGE.sweeps["dead-code"], fullKinds } } });
const VERDICTS = [
  { candidateId: A.id, outcome: "verified", note: "no importer" },
  { candidateId: H.id, outcome: "verified", note: "only the spec calls it", severity: "low" },
  { candidateId: C.id, outcome: "verified", note: "no importer" },
  { candidateId: E.id, outcome: "cleared", note: "host binding" },
  { candidateId: F.id, outcome: "verified", note: "never read", severity: "high" },
];

function sweepDir() {
  const dir = makeTempDir("hygiene-finalize-");
  writeFileSync(join(dir, "candidates.json"), JSON.stringify({ candidates: [A, B, H, C, D, E, F], clusters: CLUSTERS, churn: {} }));
  writeFileSync(join(dir, "coverage.json"), JSON.stringify(COVERAGE));
  writeFileSync(join(dir, "judgment-inputs.json"), JSON.stringify({ items: [] }));
  return dir;
}
const finalize = (dir, extra = {}) =>
  finalizeSweep({ outDir: dir, verdicts: VERDICTS, repoRoot: dir, registry, previousCounts: null, ...extra });

test("finalize: verdicts become one entry per uncleared cluster, in blast-radius order, never lowering severity", () => {
  const dir = sweepDir();
  const { entries, counts: all } = finalize(dir);
  const counts = all.sweeps["dead-code"];
  assert.deepEqual(entries, [
    { culpritKind: "dead-code", canonicalLocation: "src/util.ts", title: "1 dead-code item in src/util.ts", severity: "medium", confidence: "verified", affectedFiles: ["src/util.ts"] },
    { culpritKind: "test-only-code", canonicalLocation: "src/util.ts", title: "2 test-only-code items in src/util.ts", severity: "medium", confidence: "verified", affectedFiles: ["src/util.ts"] },
    { culpritKind: "dead-code", canonicalLocation: "src/widget.ts", title: "1 dead-code item in src/widget.ts", severity: "high", confidence: "verified", affectedFiles: ["src/widget.ts"] },
    { culpritKind: "dead-code", canonicalLocation: "src", title: "1 dead-code item in src", severity: "medium", confidence: "suspected", affectedFiles: ["src/orphan.ts"] },
  ]);
  assert.deepEqual(Object.keys(counts.categories), KINDS);
  assert.deepEqual(counts.categories["dead-code"], { verified: 2, suspected: 1, cleared: 2, complete: false });
  assert.deepEqual(counts.categories["test-only-code"], { verified: 1, suspected: 1, cleared: 0, complete: false });
  assert.deepEqual(counts.categories["stale-todo"], { verified: 0, suspected: 0, cleared: 0, complete: true });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "entries.json"), "utf8")), entries);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "counts.json"), "utf8")), all);
});

test("finalize: the section names each outcome, the cleared reasons, the coverage statement and the no-earlier-pass line", () => {
  const dir = sweepDir();
  const { sections, trending: trends } = finalize(dir);
  const section = sections["dead-code"], trending = trends["dead-code"];
  assert.match(section, /^## Dead code\n\nFindings: 4, in blast-radius order\. Cleared: dynamic prefix 1, host binding 1\.\n/);
  assert.ok(section.indexOf("### 1 dead-code item in src/widget.ts") < section.indexOf("### 1 dead-code item in src\n"));
  for (const line of [
    "- `src/util.ts:3` `specOnly`: suspected (not verified: budget)",
    "- `src/orphan.ts`: suspected (no importer (known-noisy class))",
    "- `src/widget.ts:2` `neverRead`: verified (never read)",
    "- `dead-code`: tool-checked by knip; heuristic by css-classes-keyframes; incomplete",
    "- `stale-todo`: heuristic by stale-todo; complete",
    "- `unused-env-var`: not checked; incomplete",
    "- not run: tsc (failed: main: exit 1: boom)",
    "- not run: coverage-run (needs-consent: the coverage run needs this pass's consent)",
    "- downloaded: knip 6.44.2",
    "- python: no dead-code tool for this stack; heuristic scan only",
    "- not covered: unused fonts",
    "- no earlier counted pass on this machine",
  ]) assert.ok(section.includes(line), `section lacks: ${line}`);
  assert.doesNotMatch(section, /unboundInput|btn-primary/);
  assert.deepEqual(trending, ["no earlier counted pass on this machine"]);
  assert.equal(readFileSync(join(dir, "section-dead-code.md"), "utf8"), section);
});

test("finalize: an lcov report marks uncovered candidates and records the coverage-run row", () => {
  const dir = sweepDir();
  const lcov = `SF:${dir}/src/util.ts\nDA:2,0\nDA:3,4\nend_of_record\nSF:./src/orphan.ts\nDA:1,0\nDA:2,0\nend_of_record\n`;
  const section = finalize(dir, { lcov }).sections["dead-code"];
  assert.ok(section.includes("- `src/util.ts:2` `unusedExport`: verified (no importer), uncovered"));
  assert.ok(section.includes("- `src/orphan.ts`: suspected (no importer (known-noisy class)), uncovered"));
  assert.ok(section.includes("- `src/util.ts:3` `specOnly`: suspected (not verified: budget)\n"));
  const rows = JSON.parse(readFileSync(join(dir, "coverage.json"), "utf8")).rows.filter((r) => r.source === "coverage-run");
  assert.deepEqual(rows.map((r) => [r.status, r.note]), [["ran", "lcov report covers 2 files"]]);
  finalize(dir, { lcov: "not lcov at all\n" });
  const again = JSON.parse(readFileSync(join(dir, "coverage.json"), "utf8")).rows.filter((r) => r.source === "coverage-run");
  assert.deepEqual(again.map((r) => [r.status, r.note]), [["failed", "not an lcov report: no SF records"]]);
});

test("finalize: an unknown candidate, a duplicate, an invalid outcome or a reasonless clear throws", () => {
  const dir = sweepDir();
  const bad = (verdicts, re) => assert.throws(() => finalize(dir, { verdicts }), re);
  bad([{ candidateId: "nope", outcome: "verified" }], /verdict for unknown candidate "nope"/);
  bad([VERDICTS[0], VERDICTS[0]], /two verdicts for/);
  bad([{ candidateId: A.id, outcome: "dead" }], /invalid outcome "dead"/);
  bad([{ candidateId: A.id, outcome: "cleared", note: " " }], /needs its reason as the note/);
  bad([{ candidateId: A.id, outcome: "verified", severity: "huge" }], /invalid severity "huge"/);
});

test("finalize --run appends one sweep-count row per kind once and trends against the latest earlier pass", () => {
  const dir = sweepDir();
  const runs = makeTempDir("hygiene-runs-");
  const env = { ...process.env, DEVCYCLE_RUNS_DIR: runs };
  const saved = process.env.DEVCYCLE_RUNS_DIR;
  process.env.DEVCYCLE_RUNS_DIR = runs;
  const recordDir = runsDirForRepo(gitToplevel(dir));
  if (saved === undefined) delete process.env.DEVCYCLE_RUNS_DIR; else process.env.DEVCYCLE_RUNS_DIR = saved;
  mkdirSync(recordDir, { recursive: true });
  const runLine = (runId, startedAt) => JSON.stringify({ kind: "run", runId, startedAt });
  const countLine = (runId, category, verified, suspected, complete = true) =>
    JSON.stringify({ kind: "sweep-count", runId, sweep: "dead-code", category, verified, suspected, cleared: 0, complete });
  const older = "a".repeat(16), newer = "b".repeat(16), uncounted = "c".repeat(16), current = "d".repeat(16);
  writeFileSync(join(recordDir, `${older}.jsonl`), [runLine(older, "2026-01-01T00:00:00Z"), countLine(older, "dead-code", 9, 9)].join("\n") + "\n");
  writeFileSync(join(recordDir, `${newer}.jsonl`), [runLine(newer, "2026-06-01T00:00:00Z"), countLine(newer, "dead-code", 1, 1)].join("\n") + "\n");
  writeFileSync(join(recordDir, `${uncounted}.jsonl`), runLine(uncounted, "2026-12-01T00:00:00Z") + "\n");
  writeFileSync(join(dir, "coverage.json"), JSON.stringify(withFull(KINDS)));
  const verdicts = join(dir, "verdicts.json");
  writeFileSync(verdicts, JSON.stringify(VERDICTS));
  const cli = () => spawnSync(process.execPath, [SCRIPT, "finalize", "--dir", dir, "--verdicts", verdicts, "--run", current, "--repo", dir],
    { encoding: "utf8", env });
  const first = cli();
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), { dir, entries: 4, verified: 3, suspected: 2, cleared: 2, ratchet: { "dead-code": "appended" } });
  const rows = () => readFileSync(join(recordDir, `${current}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(rows().map((r) => r.category), KINDS);
  assert.deepEqual(rows().find((r) => r.category === "dead-code"),
    { kind: "sweep-count", runId: current, sweep: "dead-code", category: "dead-code", verified: 2, suspected: 1, cleared: 2, complete: true });
  const section = readFileSync(join(dir, "section-dead-code.md"), "utf8");
  assert.ok(section.includes("- dead-code 2 → 3"), section);
  assert.ok(section.includes("- test-only-code: not comparable: earlier pass was incomplete"), "a kind the earlier pass never counted has no baseline");
  const second = cli();
  assert.equal(JSON.parse(second.stdout).ratchet["dead-code"], "already-recorded");
  assert.equal(rows().length, KINDS.length);
});

test("finalize without --verdicts exits 1 and names the missing flag", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "finalize", "--dir", sweepDir()], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^hygiene-sweep: --verdicts is required; usage: /);
});

function recordsFor(runs) {
  const prior = process.env.DEVCYCLE_RUNS_DIR;
  process.env.DEVCYCLE_RUNS_DIR = runs;
  const dir = runsDirForRepo(gitToplevel(runs));
  if (prior === undefined) delete process.env.DEVCYCLE_RUNS_DIR; else process.env.DEVCYCLE_RUNS_DIR = prior;
  mkdirSync(dir, { recursive: true });
  return dir;
}
function trendingWith({ fullKinds, earlier, startedAt = "2026-06-15T00:00:00Z" }) {
  const dir = sweepDir();
  writeFileSync(join(dir, "coverage.json"), JSON.stringify(withFull(fullKinds)));
  const runs = makeTempDir("hygiene-runs-");
  const recordDir = recordsFor(runs);
  const current = "d".repeat(16);
  writeFileSync(join(recordDir, `${current}.jsonl`), JSON.stringify({ kind: "run", runId: current, startedAt }) + "\n");
  for (const [runId, when, complete, verified = 0] of earlier) {
    const lines = [JSON.stringify({ kind: "run", runId, startedAt: when }),
      ...KINDS.map((category) => JSON.stringify({ kind: "sweep-count", runId, sweep: "dead-code", category, verified, suspected: 0, cleared: 0, complete }))];
    writeFileSync(join(recordDir, `${runId}.jsonl`), lines.join("\n") + "\n");
  }
  const verdicts = join(dir, "verdicts.json");
  writeFileSync(verdicts, JSON.stringify(VERDICTS));
  const r = spawnSync(process.execPath, [SCRIPT, "finalize", "--dir", dir, "--verdicts", verdicts, "--run", current, "--repo", runs],
    { encoding: "utf8", env: { ...process.env, DEVCYCLE_RUNS_DIR: runs } });
  assert.equal(r.status, 0, r.stderr);
  return readFileSync(join(dir, "section-dead-code.md"), "utf8");
}

test("finalize: Trending says not comparable, never a direction, when either pass was incomplete", () => {
  const priorIncomplete = trendingWith({ fullKinds: KINDS, earlier: [["a".repeat(16), "2026-01-01T00:00:00Z", false]] });
  assert.ok(priorIncomplete.includes("- dead-code: not comparable: earlier pass was incomplete"), priorIncomplete);
  assert.doesNotMatch(priorIncomplete, /dead-code \d+ →/);
  const thisIncomplete = trendingWith({ fullKinds: ["stale-todo"], earlier: [["a".repeat(16), "2026-01-01T00:00:00Z", true]] });
  assert.ok(thisIncomplete.includes("- dead-code: not comparable: this pass was incomplete"), thisIncomplete);
  assert.ok(thisIncomplete.includes("- stale-todo 0 → 0"), "a kind complete on both sides still trends");
});

test("finalize: the Trending baseline is strictly earlier than the pass being finalized", () => {
  const section = trendingWith({ fullKinds: KINDS, earlier: [["a".repeat(16), "2026-01-01T00:00:00Z", true], ["b".repeat(16), "2026-12-01T00:00:00Z", true, 5]] });
  assert.ok(section.includes("- dead-code 0 → 3"), `a later pass must not be the baseline:\n${section}`);
});

// A complexity-shaped second sweep: a scored, history-ranked kind and a section-only watch kind.
function cxRegistry() {
  const reg = structuredClone(registry);
  reg.sweeps.cx = { title: "Cx", noun: "cx", notCovered: ["css"],
    kinds: { "cx-hot": { severity: "medium", history: true }, "cx-watch": { severity: "low", route: "watch" } } };
  return reg;
}
const cx = (kind, file, score, evidence) => ({ id: `lizard:${file}:0:`, sweep: "cx", kind, source: "lizard", file, line: null, symbol: null,
  detail: `score ${score}`, noisy: false, cleared: null, clusterKey: file, anchor: file, score, evidence });
const X1 = cx("cx-hot", "src/a.js", 30, ["`hot` L1: ccn 25 > 20 (ESLint complexity)", "churn: 4 commits, 90 lines"]);
const X2 = cx("cx-hot", "src/b.js", 10, ["`mid` L3: ccn 22 > 20 (ESLint complexity)", "churn: 9 commits, 40 lines"]);
const W1 = cx("cx-watch", "src/c.js", 8, ["`w` L1: ccn 21 > 20 (ESLint complexity)", "churn: 1 commits, 2 lines"]);
const W2 = cx("cx-watch", "src/d.js", 12, ["`v` L1: ccn 23 > 20 (ESLint complexity)", "churn: 0 commits, 0 lines"]);
const cxCluster = (c, blastRadius) => ({ clusterId: `cx-hot:${c.file}`, sweep: "cx", kind: "cx-hot", route: "verification", anchor: c.file,
  files: [c.file], candidates: [c.id], blastRadius, coChange: 0 });
const CX_VERDICTS = [{ candidateId: X1.id, outcome: "verified", note: "read hot()" }, { candidateId: X2.id, outcome: "verified", note: "read mid()" }];
function cxDir() {
  const dir = makeTempDir("hygiene-finalize-cx-");
  writeFileSync(join(dir, "candidates.json"), JSON.stringify({ candidates: [X1, X2, W1, W2],
    clusters: [cxCluster(X1, 150), cxCluster(X2, 100)], churn: { "src/a.js": 4, "src/b.js": 9, "src/c.js": 1 } }));
  writeFileSync(join(dir, "coverage.json"), JSON.stringify({ ...COVERAGE,
    rows: [...COVERAGE.rows, row("lizard", ["cx-hot", "cx-watch"], "ran", "tool", { sweep: "cx" })],
    sweeps: { ...COVERAGE.sweeps, cx: { title: "Cx", noun: "cx", noToolStacks: ["web"], notCovered: ["css"], sweepKinds: ["cx-hot", "cx-watch"],
      sourcedKinds: ["cx-hot", "cx-watch"], fullKinds: ["cx-hot", "cx-watch"], notes: ["lizard: lizard skips a byte-identical file"] } } }));
  writeFileSync(join(dir, "judgment-inputs.json"), JSON.stringify({ items: [] }));
  return dir;
}
const cxFinalize = (extra = {}) => finalizeSweep({ outDir: cxDir(), verdicts: CX_VERDICTS, repoRoot: "/r", registry: cxRegistry(), previousCounts: null, ...extra });
const HISTORY = { files: [{ file: "src/b.js", commits: 20, fixCommits: 2 }, { file: "src/a.js", commits: 1, fixCommits: 0 }] };

test("finalize: watch candidates are counted and listed, never entries, and their evidence and notes render", () => {
  const { entries, counts, sections } = cxFinalize();
  assert.deepEqual(entries.map((e) => [e.culpritKind, e.canonicalLocation, e.severity]), [["cx-hot", "src/a.js", "medium"], ["cx-hot", "src/b.js", "medium"]]);
  assert.deepEqual(counts.sweeps.cx.categories["cx-watch"], { verified: 0, suspected: 2, cleared: 0, complete: true });
  const s = sections.cx;
  assert.match(s, /^## Cx\n\nFindings: 2, in blast-radius order\. Cleared: none\.\n/);
  assert.ok(s.includes("- `src/a.js`: verified (read hot())\n  - `hot` L1: ccn 25 > 20 (ESLint complexity)\n  - churn: 4 commits, 90 lines"), s);
  assert.ok(s.includes("### Watch\n\n- `src/d.js`: score 12, 0 commits\n- `src/c.js`: score 8, 1 commits\n\n### Coverage"), s);
  assert.ok(s.includes("- lizard: lizard skips a byte-identical file\n- not covered: css"), s);
  assert.ok(s.includes("- web: no cx tool for this stack; not measured"), s);
  assert.match(sections["dead-code"], /- python: no dead-code tool for this stack; heuristic scan only/);
  assert.ok(!s.includes("watch: complex but stable"), "watch candidates have no finding bullet");
  assert.doesNotMatch(sections["dead-code"], /### Watch/);
  assert.throws(() => cxFinalize({ verdicts: [...CX_VERDICTS, { candidateId: W1.id, outcome: "verified", note: "x" }] }), /routes to watch/);
});

test("finalize --history at thorough reorders history kinds by commits and raises fix-commit files", () => {
  const plain = cxFinalize({ depth: "thorough" });
  assert.deepEqual(plain.entries.map((e) => e.canonicalLocation), ["src/a.js", "src/b.js"]);
  const ranked = cxFinalize({ depth: "thorough", history: HISTORY });
  assert.deepEqual(ranked.entries.map((e) => [e.canonicalLocation, e.severity]), [["src/b.js", "high"], ["src/a.js", "medium"]]);
  assert.match(ranked.sections.cx, /Findings: 2, in history then co-change then blast-radius order\./);
  assert.ok(ranked.sections.cx.includes("- `src/b.js`: verified (read mid(); fix commits: 2)"), ranked.sections.cx);
  const standard = cxFinalize({ depth: "standard", history: HISTORY });
  assert.deepEqual(standard.entries.map((e) => [e.canonicalLocation, e.severity]), [["src/a.js", "medium"], ["src/b.js", "medium"]],
    "history acts only at thorough");
  const deadPlain = finalize(sweepDir(), { depth: "thorough" });
  const deadHistory = finalize(sweepDir(), { depth: "thorough", history: { files: [{ file: "src/widget.ts", commits: 50, fixCommits: 3 }] } });
  assert.deepEqual(deadHistory.entries, deadPlain.entries, "a sweep without a history kind is unchanged");
  assert.equal(deadHistory.sections["dead-code"], deadPlain.sections["dead-code"]);
});

test("historyIndex validates the inspector table, and the CLI refuses a bad --history file", () => {
  assert.deepEqual([...historyIndex(HISTORY)], [["src/b.js", { commits: 20, fixCommits: 2 }], ["src/a.js", { commits: 1, fixCommits: 0 }]]);
  for (const bad of [null, {}, { files: {} }, { files: [{ file: "a", commits: -1, fixCommits: 0 }] }, { files: [{ file: 3, commits: 1, fixCommits: 0 }] }])
    assert.throws(() => historyIndex(bad), /history must be \{ files: \[\{ file, commits, fixCommits \}\] \}/);
  const dir = sweepDir();
  const verdicts = join(dir, "verdicts.json");
  writeFileSync(verdicts, JSON.stringify(VERDICTS));
  const badFile = join(dir, "history.json");
  writeFileSync(badFile, JSON.stringify({ files: "nope" }));
  const r = spawnSync(process.execPath, [SCRIPT, "finalize", "--dir", dir, "--verdicts", verdicts, "--depth", "thorough", "--history", badFile, "--repo", dir],
    { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^hygiene-sweep: .*history\.json: history must be/);
  writeFileSync(badFile, JSON.stringify(HISTORY));
  const ok = spawnSync(process.execPath, [SCRIPT, "finalize", "--dir", dir, "--verdicts", verdicts, "--depth", "thorough", "--history", badFile, "--repo", dir],
    { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
});
