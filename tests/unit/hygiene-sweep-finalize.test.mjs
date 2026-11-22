import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { finalizeSweep } from "../../scripts/hygiene-sweep.mjs";
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
const cluster = (kind, anchor, files, ids, blastRadius) => ({ clusterId: `${kind}:${anchor}`, kind, anchor, files, candidates: ids, blastRadius });
const CLUSTERS = [
  cluster("dead-code", "src/util.ts", ["src/util.ts"], [A.id], 3),
  cluster("test-only-code", "src/util.ts", ["src/util.ts"], [B.id, H.id], 3),
  cluster("dead-code", "src/widget.ts", ["src/widget.ts"], [F.id], 2),
  cluster("dead-code", "src", ["src/orphan.ts"], [C.id], 1),
  cluster("dead-code", "src/app/hero.component.ts", ["src/app/hero.component.ts"], [E.id], 1),
];
const row = (source, kinds, status, method, extra = {}) => ({ source, kinds, class: "static", status, method, downloaded: false, version: "1", note: null, ...extra });
const COVERAGE = {
  sweep: "dead-code", stacks: ["js-ts", "python"], dependenciesInstalled: true, consent: { executing: false, coverage: false },
  config: { staleTodoDays: 365, source: "registry" },
  rows: [
    row("knip", ["dead-code", "test-only-code", "over-exported"], "ran", "tool", { downloaded: true, version: "6.44.2" }),
    row("tsc", ["dead-code"], "failed", "tool", { note: "main: exit 1: boom" }),
    row("css-classes-keyframes", ["dead-code"], "ran", "heuristic"),
    row("stale-todo", ["stale-todo"], "ran", "heuristic"),
  ],
  noToolStacks: ["python"], notCovered: ["unused fonts"], sweepKinds: KINDS, fullKinds: ["stale-todo"],
};
const VERDICTS = [
  { candidateId: A.id, outcome: "verified", note: "no importer" },
  { candidateId: H.id, outcome: "verified", note: "only the spec calls it", severity: "low" },
  { candidateId: C.id, outcome: "verified", note: "no importer" },
  { candidateId: E.id, outcome: "cleared", note: "host binding" },
  { candidateId: F.id, outcome: "verified", note: "never read", severity: "high" },
];

function sweepDir() {
  const dir = makeTempDir("hygiene-finalize-");
  writeFileSync(join(dir, "candidates.json"), JSON.stringify({ sweep: "dead-code", candidates: [A, B, H, C, D, E, F], clusters: CLUSTERS }));
  writeFileSync(join(dir, "coverage.json"), JSON.stringify(COVERAGE));
  return dir;
}
const finalize = (dir, extra = {}) =>
  finalizeSweep({ outDir: dir, verdicts: VERDICTS, repoRoot: dir, registry, previousCounts: null, ...extra });

test("finalize: verdicts become one entry per uncleared cluster, in blast-radius order, never lowering severity", () => {
  const dir = sweepDir();
  const { entries, counts } = finalize(dir);
  assert.deepEqual(entries, [
    { culpritKind: "dead-code", canonicalLocation: "src/util.ts", title: "1 dead-code item in src/util.ts", severity: "medium", confidence: "verified", affectedFiles: ["src/util.ts"] },
    { culpritKind: "test-only-code", canonicalLocation: "src/util.ts", title: "2 test-only-code items in src/util.ts", severity: "medium", confidence: "verified", affectedFiles: ["src/util.ts"] },
    { culpritKind: "dead-code", canonicalLocation: "src/widget.ts", title: "1 dead-code item in src/widget.ts", severity: "high", confidence: "verified", affectedFiles: ["src/widget.ts"] },
    { culpritKind: "dead-code", canonicalLocation: "src", title: "1 dead-code item in src", severity: "medium", confidence: "suspected", affectedFiles: ["src/orphan.ts"] },
  ]);
  assert.deepEqual(Object.keys(counts.categories), KINDS);
  assert.deepEqual(counts.categories["dead-code"], { verified: 2, suspected: 1, cleared: 2 });
  assert.deepEqual(counts.categories["test-only-code"], { verified: 1, suspected: 1, cleared: 0 });
  assert.deepEqual(counts.categories["stale-todo"], { verified: 0, suspected: 0, cleared: 0 });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "entries.json"), "utf8")), entries);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "counts.json"), "utf8")), counts);
});

test("finalize: the section names each outcome, the cleared reasons, the coverage statement and the no-earlier-pass line", () => {
  const dir = sweepDir();
  const { section, trending } = finalize(dir);
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
  assert.equal(readFileSync(join(dir, "section.md"), "utf8"), section);
});

test("finalize: an lcov report marks uncovered candidates and records the coverage-run row", () => {
  const dir = sweepDir();
  const lcov = `SF:${dir}/src/util.ts\nDA:2,0\nDA:3,4\nend_of_record\nSF:./src/orphan.ts\nDA:1,0\nDA:2,0\nend_of_record\n`;
  const { section } = finalize(dir, { lcov });
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
  const countLine = (runId, category, verified, suspected) =>
    JSON.stringify({ kind: "sweep-count", runId, sweep: "dead-code", category, verified, suspected, cleared: 0 });
  const older = "a".repeat(16), newer = "b".repeat(16), uncounted = "c".repeat(16), current = "d".repeat(16);
  writeFileSync(join(recordDir, `${older}.jsonl`), [runLine(older, "2026-01-01T00:00:00Z"), countLine(older, "dead-code", 9, 9)].join("\n") + "\n");
  writeFileSync(join(recordDir, `${newer}.jsonl`), [runLine(newer, "2026-06-01T00:00:00Z"), countLine(newer, "dead-code", 1, 1)].join("\n") + "\n");
  writeFileSync(join(recordDir, `${uncounted}.jsonl`), runLine(uncounted, "2026-12-01T00:00:00Z") + "\n");
  const verdicts = join(dir, "verdicts.json");
  writeFileSync(verdicts, JSON.stringify(VERDICTS));
  const cli = () => spawnSync(process.execPath, [SCRIPT, "finalize", "--dir", dir, "--verdicts", verdicts, "--run", current, "--repo", dir],
    { encoding: "utf8", env });
  const first = cli();
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), { dir, entries: 4, verified: 3, suspected: 2, cleared: 2, ratchet: "appended" });
  const rows = () => readFileSync(join(recordDir, `${current}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(rows().map((r) => r.category), KINDS);
  assert.deepEqual(rows().find((r) => r.category === "dead-code"),
    { kind: "sweep-count", runId: current, sweep: "dead-code", category: "dead-code", verified: 2, suspected: 1, cleared: 2 });
  const section = readFileSync(join(dir, "section.md"), "utf8");
  assert.ok(section.includes("- dead-code 2 → 3"), section);
  assert.ok(section.includes("- test-only-code 0 → 2"));
  const second = cli();
  assert.equal(JSON.parse(second.stdout).ratchet, "already-recorded");
  assert.equal(rows().length, KINDS.length);
});

test("finalize without --verdicts exits 1 and names the missing flag", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "finalize", "--dir", sweepDir()], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^hygiene-sweep: --verdicts is required; usage: /);
});
