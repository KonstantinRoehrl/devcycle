// The on-device stage's bookkeeping, owned by scripts/on-device-routing.mjs: which FAILED items still
// need a decision or a fix round, which were waived or accepted, how many fix rounds were spent, and
// whether the walk was delegated.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { parseLedgerLine } from "../../scripts/task-ledger.mjs";
import { DELEGATED_WALK, failedItems, itemDecisions, resultsPathFor, routing } from "../../scripts/on-device-routing.mjs";

const SPEC = "docs/superpowers/specs/2026-10-29-x-design.md";
const REPORT = [
  "## On-device results: x",
  "- #1 Export button downloads a CSV: passed (auto: .devcycle/evidence/od-1.txt) — the file arrived",
  "- #2 Empty state shows a hint: FAILED — the page is blank — severity: medium",
  "- #3 Error toast names the field: FAILED — the toast says \"error\" — severity: high",
  "- #4 Dark mode keeps contrast: FAILED — grey on grey — severity: low",
  "- #5 Totals row aligns: passed (re-walk, round 1) — aligned now",
].join("\n");
const line = (task, event, outcome, ref = SPEC) => `- [2026-10-29T10:00:00Z] task=${task} event=${event} outcome=${outcome} ref=${ref}`;
const entries = (...lines) => lines.map(parseLedgerLine);

test("failedItems reads only FAILED lines, with ordinal, symptom and severity", () => {
  assert.deepEqual(failedItems(REPORT).map((i) => [i.n, i.severity, i.symptom]),
    [[2, "medium", "the page is blank"], [3, "high", "the toast says \"error\""], [4, "low", "grey on grey"]]);
  assert.deepEqual(failedItems("- Export: FAILED — no ordinal — severity: high\nnot a line"), [], "a line without #<n> is ignored, never fatal");
});

test("itemDecisions keeps the latest decision per item and parses a waive reason", () => {
  const d = itemDecisions(entries(
    line("on-device", "user-decision", "failed-item #2 Empty state shows a hint: fix"),
    line("on-device", "user-decision", "failed-item #2 Empty state shows a hint: waive (copy lands in R31: tracked)"),
    line("on-device", "user-decision", "failed-item #3 Error toast names the field: accept"),
    line("branch", "user-decision", "failed-item #4 not on-device: accept"),
  ));
  assert.deepEqual(d.get(2), { decision: "waive", reason: "copy lands in R31: tracked" });
  assert.deepEqual(d.get(3), { decision: "accept", reason: null });
  assert.equal(d.has(4), false, "a decision on another task is not this stage's");
});

test("routing: undecided items block, fix items run a round, waived and accepted ones are carried", () => {
  const r = routing({ resultsText: REPORT, specPath: SPEC, cap: 3, entries: entries(
    line("on-device", "user-decision", "failed-item #2 Empty state shows a hint: fix"),
    line("on-device", "user-decision", "failed-item #3 Error toast names the field: accept"),
  ) });
  assert.deepEqual([r.undecided, r.toFix, r.carried.map((c) => [c.n, c.decision])], [[4], [2], [[3, "accept"]]]);
  assert.deepEqual([r.round, r.cap, r.atCap, r.delegated], [0, 3, false, false]);
});

test("routing: the round counts this spec's on-device review-round lines; at the cap a fix item is undecided again", () => {
  const rounds = [line("on-device", "review-round", "round 1"), line("on-device", "review-round", "round 2"),
    line("on-device", "review-round", "round 1", "docs/superpowers/specs/other.md"), line("branch", "review-round", "round 1 (single)")];
  const fix = line("on-device", "user-decision", "failed-item #2 Empty state shows a hint: fix");
  const atCap = routing({ resultsText: "- #2 Empty state shows a hint: FAILED — blank — severity: medium", specPath: SPEC, cap: 2, entries: entries(fix, ...rounds) });
  assert.deepEqual([atCap.round, atCap.atCap, atCap.undecided, atCap.toFix], [2, true, [2], []]);
  const extended = routing({ resultsText: "- #2 Empty state shows a hint: FAILED — blank — severity: medium", specPath: SPEC, cap: 2,
    entries: entries(fix, ...rounds, line("on-device", "user-decision", "review-cap extended to 4")) });
  assert.deepEqual([extended.cap, extended.atCap, extended.toFix], [4, false, [2]], "a granted extension raises the cap");
  const noCap = routing({ resultsText: "- #2 Empty state shows a hint: FAILED — blank — severity: medium", specPath: SPEC, cap: null, entries: entries(fix, ...rounds) });
  assert.deepEqual([noCap.atCap, noCap.toFix], [false, [2]], "with no cap known a fix item stays a fix item");
});

test("routing: a delegated walk is read from its ledger line", () => {
  const r = routing({ resultsText: "", specPath: SPEC, cap: 3, entries: entries(line("on-device", "user-decision", DELEGATED_WALK, "docs/x/on-device-checklist.md")) });
  assert.deepEqual([r.delegated, r.failed, r.undecided], [true, [], []]);
});

test("CLI: reads the state file's checklist, spec and ledger; checklist none or no report reads as nothing failed", () => {
  const repo = makeTempDir("on-device-routing-");
  try {
    mkdirSync(join(repo, ".devcycle"), { recursive: true });
    mkdirSync(join(repo, "docs/x"), { recursive: true });
    const state = (checklist) => writeFileSync(join(repo, ".devcycle/state.md"),
      `# devcycle state\n- stage: finish\n- spec: ${SPEC} (spec review: clean)\n- ledger: .devcycle/ledger.md\n- checklist: ${checklist}\n`);
    const run = (...args) => {
      const r = spawnSync(process.execPath, [fileURLToPath(new URL("../../scripts/on-device-routing.mjs", import.meta.url)), "--state", ".devcycle/state.md", ...args], { cwd: repo, encoding: "utf8" });
      return { status: r.status, out: JSON.parse(r.stdout) };
    };
    state("none");
    assert.deepEqual([run().status, run().out.results, run().out.undecided], [0, null, []]);
    state("docs/x/on-device-checklist.md");
    assert.deepEqual([run().out.results, run().out.failed], ["docs/x/on-device-results.md", []], "no report yet is nothing failed");
    writeFileSync(join(repo, resultsPathFor("docs/x/on-device-checklist.md")), REPORT);
    writeFileSync(join(repo, ".devcycle/ledger.md"), line("on-device", "user-decision", "failed-item #2 Empty state shows a hint: fix") + "\n");
    const r = run("--cap", "3");
    assert.deepEqual([r.status, r.out.ok, r.out.undecided, r.out.toFix, r.out.cap], [0, true, [3, 4], [2], 3]);
    assert.equal(run("--cap", "x").status, 2, "a bad --cap is a usage error");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
