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
import { DELEGATED_WALK, failedItems, itemDecisions, malformedLines, resultsPathFor, routing } from "../../scripts/on-device-routing.mjs";

const SPEC = "docs/superpowers/specs/2026-10-29-x-design.md";
const REPORT = [
  "## On-device results: x",
  "- #1 Export button downloads a CSV: passed (auto: .devcycle/evidence/od-1.txt) — the file arrived",
  "- #2 Empty state shows a hint: FAILED — the page is blank — severity: medium",
  "- #3 Error toast names the field: FAILED — the toast says \"error\" — severity: high",
  "- #4 Dark mode keeps contrast: FAILED — grey on grey — severity: low",
  "- #5 Totals row aligns: passed (re-walk, round 1) — aligned now",
].join("\n");
const CHECKLIST = "docs/x/on-device-checklist.md";
const RESULTS = resultsPathFor(CHECKLIST);
const line = (task, event, outcome, ref = SPEC) => `- [2026-10-29T10:00:00Z] task=${task} event=${event} outcome=${outcome} ref=${ref}`;
const entries = (...lines) => lines.map(parseLedgerLine);

test("failedItems reads only FAILED lines, with ordinal, symptom and severity", () => {
  assert.deepEqual(failedItems(REPORT).map((i) => [i.n, i.severity, i.symptom]),
    [[2, "medium", "the page is blank"], [3, "high", "the toast says \"error\""], [4, "low", "grey on grey"]]);
});

test("failedItems fails closed: near-variants of the FAILED line still parse, so they are asked about", () => {
  const variants = {
    "- #6 Retry works: FAILED (re-walk, round 1) — still blank — severity: high": ["high", "(re-walk, round 1) — still blank — severity: high"],
    "- #7 Save works: FAILED — nothing saved — severity: High": ["high", "— nothing saved — severity: High"],
    "- #8 Print works: FAILED — cut off — severity: critical": ["critical", "— cut off — severity: critical"],
    "- #9 Undo works: FAILED - no effect - severity: medium": ["medium", "- no effect - severity: medium"],
    "- #10 Zoom works: failed — jumps — severity: low": ["low", "— jumps — severity: low"],
    "- #11 Menu opens: FAILED — never opens": ["unknown", "— never opens"],
  };
  for (const [text, [severity, symptom]] of Object.entries(variants)) {
    const [item, ...rest] = failedItems(text);
    assert.deepEqual([rest.length, item?.severity, item?.symptom], [0, severity, symptom], text);
  }
  assert.deepEqual(failedItems("- #6 Retry works: FAILED (re-walk, round 1) — still blank — severity: high").map((i) => [i.n, i.text]), [[6, "Retry works"]]);
  const r = routing({ resultsText: Object.keys(variants).join("\n"), checklist: CHECKLIST, specPath: SPEC, cap: 3, entries: [] });
  assert.deepEqual(r.undecided, [6, 7, 8, 9, 10, 11], "every variant reaches the routing question");
});

test("failedItems: a passed line that mentions FAILED later in its prose is not a failed item", () => {
  assert.deepEqual(failedItems("- #3 Toast names the field: passed — it FAILED earlier, now fixed"), []);
  assert.deepEqual(failedItems("- #3 Toast names the field: passed (re-walk, round 1) — was FAILED: now fixed").length, 0);
});

test("failedItems: the verdict position decides - FAILED in a passed, waived or unverified line's prose is not a failed item", () => {
  const notFailed = [
    "- #1 login works: passed — note: FAILED earlier",
    "- #3 build status: FAILED badge is red: passed — saw red",
    "- #4 Toast names the field: waived (tracked in R31) — it FAILED in round 1",
    "- #5 Totals align: unverified (re-walk, round 1) — nobody could observe it; FAILED before: now unknown",
    "- #6 Menu opens: passed (auto: .devcycle/evidence/od-6.txt) — was FAILED: now fixed",
  ];
  for (const text of notFailed) {
    assert.deepEqual(failedItems(text), [], text);
    assert.deepEqual(malformedLines(text), [], `${text} is a well-formed non-failed line`);
  }
  assert.deepEqual(failedItems(notFailed.join("\n")), []);
});

test("failedItems: the item text is everything before the verdict, even when it contains a FAILED-looking colon", () => {
  const [item, ...rest] = failedItems("- #2 login works: passed — note: FAILED earlier\n- #3 build status: FAILED — badge is red — severity: high");
  assert.deepEqual([rest.length, item.n, item.text, item.severity, item.symptom], [0, 3, "build status", "high", "badge is red"]);
});

test("failedItems fails closed on emphasis, spacing and dash spellings of the verdict", () => {
  const spellings = {
    "- #3 Item: **FAILED** — nothing happens — severity: high": ["Item", "high"],
    "- #3 Item: `FAILED` — nothing happens — severity: low": ["Item", "low"],
    "- #3 Item: _FAILED_ — nothing happens": ["Item", "unknown"],
    "- #3 Item — FAILED — nothing happens — severity: medium": ["Item", "medium"],
    "- #3 Item – FAILED – nothing happens": ["Item", "unknown"],
    "- #3 Item - FAILED - nothing happens - severity: low": ["Item", "low"],
    "- #5 x:FAILED": ["x", "unknown"],
    "- #5 x:**FAILED**": ["x", "unknown"],
    "- #5 x : FAILED, nothing happens": ["x", "unknown"],
    "- #5 x: FAILED (re-walk, round 2) — severity: **high**": ["x", "high"],
  };
  for (const [text, [itemText, severity]] of Object.entries(spellings)) {
    const [item, ...rest] = failedItems(text);
    assert.deepEqual([rest.length, item?.n, item?.text, item?.severity], [0, Number(/#(\d+)/.exec(text)[1]), itemText, severity], text);
    assert.deepEqual(malformedLines(text), [], text);
  }
});

test("failedItems: the same spellings with a passed, waived or unverified verdict are not failed items", () => {
  for (const verdict of ["passed", "waived", "unverified", "**passed**", "`unverified`"]) {
    for (const sep of [": ", ":", " — ", " - "]) {
      const text = `- #3 Item${sep}${verdict} — the FAILED badge is gone`;
      assert.deepEqual([failedItems(text), malformedLines(text)], [[], []], text);
    }
  }
});

test("failedItems: a bulleted line that mentions FAILED but has no ordinal stays malformed, whatever its spelling", () => {
  const lines = ["- Item — FAILED — nothing happens", "- Item: **FAILED** — nothing happens", "- Totals row FAILED to align", "* Item `FAILED`"];
  assert.deepEqual(malformedLines(lines.join("\n")), lines);
  assert.deepEqual(failedItems(lines.join("\n")), []);
  assert.deepEqual(malformedLines("## On-device results: x\nSome prose that failed\n- #1 ok: passed — fine"), []);
});

test("failedItems: a numbered line whose FAILED is not at the verdict position is malformed, not silently passed", () => {
  const text = "- #7 Menu opens: FAILED badge is red";
  assert.deepEqual([failedItems(text), malformedLines(text)], [[], [text]]);
});

test("a CRLF results file parses the same as an LF one: no canonical line is also malformed", () => {
  const crlf = REPORT.replaceAll("\n", "\r\n") + "\r\n";
  assert.deepEqual(failedItems(crlf), failedItems(REPORT));
  assert.deepEqual(failedItems(crlf).map((i) => i.symptom), ["the page is blank", "the toast says \"error\"", "grey on grey"]);
  assert.deepEqual(malformedLines(crlf), []);
  assert.deepEqual(failedItems("- #11 Menu opens: FAILED — never opens\r\n").map((i) => [i.severity, i.symptom]), [["unknown", "— never opens"]]);
  assert.deepEqual(malformedLines("- Export: FAILED — no ordinal\r\n- #1 ok: passed — fine\r\n"), ["- Export: FAILED — no ordinal"]);
});

test("failedItems: a FAILED line with no ordinal is reported as malformed, never dropped", () => {
  const text = "- Export: FAILED — no ordinal — severity: high\nnot a line\n- #1 ok: passed — fine\n* Other: failed — nope";
  assert.deepEqual(malformedLines(text), ["- Export: FAILED — no ordinal — severity: high", "* Other: failed — nope"]);
  assert.deepEqual(failedItems(text), [], "a line without #<n> has no item to decide on");
  const r = routing({ resultsText: text, checklist: CHECKLIST, specPath: SPEC, cap: 3, entries: [] });
  assert.equal(r.malformed.length, 2);
  assert.deepEqual(routing({ resultsText: REPORT, checklist: CHECKLIST, specPath: SPEC, cap: 3, entries: [] }).malformed, []);
});

test("itemDecisions keeps the latest decision per item and parses a waive reason", () => {
  const d = itemDecisions(entries(
    line("on-device", "user-decision", "failed-item #2 Empty state shows a hint: fix", RESULTS),
    line("on-device", "user-decision", "failed-item #2 Empty state shows a hint: waive (copy lands in R31: tracked)", RESULTS),
    line("on-device", "user-decision", "failed-item #3 Error toast names the field: accept", RESULTS),
    line("branch", "user-decision", "failed-item #4 not on-device: accept", RESULTS),
  ));
  assert.deepEqual(d.get(2), { decision: "waive", reason: "copy lands in R31: tracked" });
  assert.deepEqual(d.get(3), { decision: "accept", reason: null });
  assert.equal(d.has(4), false, "a decision on another task is not this stage's");
});

test("routing: undecided items block, fix items run a round, waived and accepted ones are carried", () => {
  const r = routing({ resultsText: REPORT, checklist: CHECKLIST, specPath: SPEC, cap: 3, entries: entries(
    line("on-device", "user-decision", "failed-item #2 Empty state shows a hint: fix", RESULTS),
    line("on-device", "user-decision", "failed-item #3 Error toast names the field: accept", RESULTS),
  ) });
  assert.deepEqual([r.undecided, r.toFix, r.carried.map((c) => [c.n, c.decision])], [[4], [2], [[3, "accept"]]]);
  assert.deepEqual([r.round, r.cap, r.atCap, r.delegated], [0, 3, false, false]);
});

test("routing: the round counts this spec's on-device review-round lines; at the cap a fix item is undecided again", () => {
  const rounds = [line("on-device", "review-round", "round 1"), line("on-device", "review-round", "round 2"),
    line("on-device", "review-round", "round 1", "docs/superpowers/specs/other.md"), line("branch", "review-round", "round 1 (single)")];
  const fix = line("on-device", "user-decision", "failed-item #2 Empty state shows a hint: fix", RESULTS);
  const atCap = routing({ resultsText: "- #2 Empty state shows a hint: FAILED — blank — severity: medium", checklist: CHECKLIST, specPath: SPEC, cap: 2, entries: entries(fix, ...rounds) });
  assert.deepEqual([atCap.round, atCap.atCap, atCap.undecided, atCap.toFix], [2, true, [2], []]);
  const extended = routing({ resultsText: "- #2 Empty state shows a hint: FAILED — blank — severity: medium", checklist: CHECKLIST, specPath: SPEC, cap: 2,
    entries: entries(fix, ...rounds, line("on-device", "user-decision", "review-cap extended to 4")) });
  assert.deepEqual([extended.cap, extended.atCap, extended.toFix], [4, false, [2]], "a granted extension raises the cap");
  const noCap = routing({ resultsText: "- #2 Empty state shows a hint: FAILED — blank — severity: medium", checklist: CHECKLIST, specPath: SPEC, cap: null, entries: entries(fix, ...rounds) });
  assert.deepEqual([noCap.atCap, noCap.toFix], [false, [2]], "with no cap known a fix item stays a fix item");
});

test("routing: a delegated walk is read from its ledger line", () => {
  const r = routing({ resultsText: "", checklist: CHECKLIST, specPath: SPEC, cap: 3, entries: entries(line("on-device", "user-decision", DELEGATED_WALK, CHECKLIST)) });
  assert.deepEqual([r.delegated, r.failed, r.undecided], [true, [], []]);
});

test("routing: only this cycle's lines count - decisions by results ref, the delegated flag by checklist ref, a cap extension by spec ref", () => {
  const foreign = "docs/y/on-device-results.md";
  const one = (extra, cap = 2) => routing({ resultsText: "- #2 Empty state shows a hint: FAILED — blank — severity: medium", checklist: CHECKLIST, specPath: SPEC, cap, entries: entries(...extra) });
  const accept = (ref) => line("on-device", "user-decision", "failed-item #2 Empty state shows a hint: accept", ref);
  assert.deepEqual(one([accept(foreign)]).undecided, [2], "another cycle's decision on item #2 does not decide this cycle's");
  assert.deepEqual(one([accept(RESULTS)]).undecided, [], "this cycle's decision does");
  assert.equal(one([line("on-device", "user-decision", DELEGATED_WALK, "docs/y/on-device-checklist.md")]).delegated, false, "another cycle's delegation is not this one's");
  assert.equal(one([line("on-device", "user-decision", DELEGATED_WALK, CHECKLIST)]).delegated, true);
  const rounds = [line("on-device", "review-round", "round 1"), line("on-device", "review-round", "round 2")];
  const extend = (ref) => line("on-device", "user-decision", "review-cap extended to 4", ref);
  assert.deepEqual([one([...rounds, extend("docs/superpowers/specs/other.md")]).cap, one([...rounds, extend("docs/superpowers/specs/other.md")]).atCap], [2, true], "another spec's extension is ignored");
  assert.deepEqual([one([...rounds, extend(SPEC)]).cap, one([...rounds, extend(SPEC)]).atCap], [4, false], "this spec's extension is honoured");
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
    state("none — on-device not applicable (docs only)");
    assert.deepEqual([run().status, run().out.results, run().out.undecided], [0, null, []], "a none with a reason is still none, not a path");
    state("none — trace found a rendered surface (x)");
    assert.equal(run().out.results, null);
    state("docs/x/on-device-checklist.md");
    assert.deepEqual([run().out.results, run().out.failed], ["docs/x/on-device-results.md", []], "no report yet is nothing failed");
    writeFileSync(join(repo, resultsPathFor("docs/x/on-device-checklist.md")), REPORT);
    writeFileSync(join(repo, ".devcycle/ledger.md"), line("on-device", "user-decision", "failed-item #2 Empty state shows a hint: fix", RESULTS) + "\n");
    const r = run("--cap", "3");
    assert.deepEqual([r.status, r.out.ok, r.out.undecided, r.out.toFix, r.out.cap], [0, true, [3, 4], [2], 3]);
    assert.equal(run("--cap", "x").status, 2, "a bad --cap is a usage error");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
