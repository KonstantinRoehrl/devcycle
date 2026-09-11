import test from "node:test";
import assert from "node:assert/strict";
import { renderLearnReport, allTimeRollup } from "../../scripts/learn-report.mjs";

const baseArgs = () => ({
  candidates: {
    repo: "devcycle", generatedAt: "2026-09-09T00:00:00Z", profile: "thorough",
    corpus: { sessions: 12, from: "2026-08-01", to: "2026-09-01", capped: false, journalEvents: 0, journalEmpty: true },
    checkpoint: { before: null, after: "2026-09-01" },
    attribution: { vocabulary: 0, novel: 0 },
    candidates: [],
  },
  promotions: [],
});

const CANDIDATES = {
  repo: "devcycle",
  generatedAt: "2026-08-14T00:00:00Z",
  profile: "thorough",
  corpus: { sessions: 9, from: "2026-08-01", to: "2026-08-14", capped: false, journalEvents: 214, journalEmpty: false },
  checkpoint: { before: "2026-08-01T00:00:00Z", after: "2026-08-14T00:00:00Z" },
  attribution: { vocabulary: 17, novel: 3 },
  candidates: [
    {
      title: "Flaky retry masks a real dependency-order bug",
      culpritId: "friction:flaky-test-retry", aliases: [], disposition: "landed", partition: "bulk",
      rung: "r2", whyNotHigher: "the fix is a repo-specific fixture ordering issue",
      locations: ["docs/devcycle/lessons.md#executing-waves"], fault: "repo", scope: "repo-devs",
      impact: 4.1, occurrences: 7, trend: "recurring", priorOccurrences: 4, evidenceSessions: 3,
      verify: "journal-recurrence", sourcedFromMemory: false, sensitive: false,
      legacyDuplicateOf: null, declineReason: null,
    },
    {
      title: "Brief omitted the evidence class", culpritId: "novel:brief-omitted-evidence-class",
      aliases: [], disposition: "declined", partition: "explicit", rung: "r0", whyNotHigher: null,
      locations: [], fault: "pipeline", scope: null, impact: 0.8, occurrences: 1,
      trend: "first occurrence", priorOccurrences: 0, evidenceSessions: 1, verify: "journal-recurrence",
      sourcedFromMemory: true, sensitive: false, legacyDuplicateOf: null,
      declineReason: "devcycle's own defect — filed upstream instead",
    },
  ],
  contradictions: [{ culpritId: "contradiction:x", sideA: "always pin", sideB: "never pin", chosen: "sideA" }],
  evictions: [{ culpritId: "friction:old-thing", section: "executing-waves", reason: "cap" }],
};

const PROMOTIONS = [
  { culpritId: "friction:a", rung: "r2", landed: "2026-01-01", sourcedFromMemory: true, aliases: [] },
  { culpritId: "friction:a", rung: "r3", landed: "2026-03-02", sourcedFromMemory: false, aliases: [] },
  { culpritId: "friction:b", rung: "r2", landed: "2026-02-01", sourcedFromMemory: false, aliases: [] },
  { culpritId: null, rung: null, landed: "2025-12-01", sourcedFromMemory: null, aliases: [] },
];

// Acceptance criterion 8: same headings, same order, same columns in both modes.
const headings = (s) => (s.match(/^#{1,3} .*$/gm) ?? []);
const tableHeaders = (s) => (s.match(/^\|.*\|$/gm) ?? []).filter((l) => !/^\|[-: |]+\|$/.test(l));

test("proposal and outcome render the same section headings in the same order", () => {
  const a = headings(renderLearnReport({ candidates: CANDIDATES, promotions: PROMOTIONS }));
  const b = headings(renderLearnReport({ candidates: CANDIDATES, promotions: PROMOTIONS, outcome: true }));
  assert.equal(a.length, b.length);
  a.forEach((h, i) => {
    if (/^# Learn Report/.test(h)) return; // the one heading allowed to differ
    assert.equal(h, b[i]);
  });
});

test("the two modes differ only in the top heading's proposal-vs-outcome wording", () => {
  const a = renderLearnReport({ candidates: CANDIDATES, promotions: PROMOTIONS });
  const b = renderLearnReport({ candidates: CANDIDATES, promotions: PROMOTIONS, outcome: true });
  assert.match(a, /^# Learn Report \(proposal\) — devcycle — 2026-08-14$/m);
  assert.match(b, /^# Learn Report \(outcome\) — devcycle — 2026-08-14$/m);
  assert.deepEqual(tableHeaders(a), tableHeaders(b), "column order is identical in both modes");
});

test("a landed candidate renders every D9 field of its entry", () => {
  const out = renderLearnReport({ candidates: CANDIDATES, promotions: PROMOTIONS });
  assert.match(out, /^### Flaky retry masks a real dependency-order bug — `friction:flaky-test-retry`$/m);
  assert.match(out, /^- Rung: r2 — why not higher: the fix is a repo-specific fixture ordering issue$/m);
  assert.match(out, /^- Location\(s\): docs\/devcycle\/lessons\.md#executing-waves$/m);
  assert.match(out, /^- Fault \/ scope: repo · repo-devs$/m);
  assert.match(out, /^- Impact: \$4\.10 \(7 occurrences\) · trend: recurring, seen 4 times before$/m);
  assert.match(out, /^- Evidence: 3 sessions$/m);
  assert.match(out, /^- Verify: journal-recurrence$/m);
});

test("a declined candidate is one line under its own heading, with its reason", () => {
  const out = renderLearnReport({ candidates: CANDIDATES, promotions: PROMOTIONS });
  assert.match(out, /^## Declined \/ deferred$/m);
  assert.match(out, /Brief omitted the evidence class · novel:brief-omitted-evidence-class · r0 · devcycle's own defect/);
  assert.doesNotMatch(out.split("## Declined")[0], /Brief omitted the evidence class/,
    "a declined candidate never appears under Landed");
});

test("attribution renders as vocabulary vs novel, because it cannot be asserted mechanically", () => {
  assert.match(renderLearnReport({ candidates: CANDIDATES, promotions: PROMOTIONS }),
    /^Attributed: 17 vocabulary · 3 novel$/m);
});

test("an empty journal is reported as empty, distinct from read-and-found-nothing", () => {
  const cold = { ...CANDIDATES, corpus: { ...CANDIDATES.corpus, journalEvents: 0, journalEmpty: true } };
  assert.match(renderLearnReport({ candidates: cold, promotions: [] }), /Journal: empty \(no run records yet\)/);
  const warm = { ...CANDIDATES, corpus: { ...CANDIDATES.corpus, journalEvents: 0, journalEmpty: false } };
  assert.match(renderLearnReport({ candidates: warm, promotions: [] }), /Journal: 0 events \(read, nothing in window\)/);
});

test("evictions are rendered, so a landing that costs a line says so", () => {
  assert.match(renderLearnReport({ candidates: CANDIDATES, promotions: PROMOTIONS }),
    /landing evicts `friction:old-thing` from `executing-waves` \(cap\)/);
});

test("contradictions render as their own table with both sides preserved", () => {
  const out = renderLearnReport({ candidates: CANDIDATES, promotions: PROMOTIONS });
  assert.match(out, /^## Contradictions resolved$/m);
  assert.match(out, /\| contradiction:x \| always pin \| never pin \| sideA \|/);
});

test("the all-time rollup buckets by rung and counts what cannot bucket", () => {
  const r = allTimeRollup(PROMOTIONS);
  assert.equal(r.byRung.r2.landed, 2);
  assert.equal(r.byRung.r3.landed, 1);
  assert.equal(r.unbucketed, 1, "legacy records carry no rung: and are counted, never hidden");
  assert.deepEqual(r.sourced, { memory: 1, mining: 2 });
});

test("r2→r3 transition median is measured from paired records; r2→retired is unmeasurable this phase", () => {
  const r = allTimeRollup(PROMOTIONS);
  assert.equal(r.transitions.r2r3, 60, "2026-01-01 → 2026-03-02 is 60 days");
  assert.equal(r.transitions.r2retired, null);
});

test("a null transition renders as an em dash and names why, never as a zero", () => {
  const out = renderLearnReport({ candidates: CANDIDATES, promotions: PROMOTIONS });
  assert.match(out, /r2 → retired \(held out\), median — \(no retirement recorded yet\)/);
  assert.doesNotMatch(out, /median 0 days/);
});

test("the legacy-record count is stated rather than silently excluded", () => {
  assert.match(renderLearnReport({ candidates: CANDIDATES, promotions: PROMOTIONS }),
    /1 record predates `rung:` and does not bucket/);
});

// The run-level impact total had no honest input while no event carried a culprit (audit M7);
// per-candidate impact stays, the aggregate line goes.
test("the report renders no run-level impact total", () => {
  const out = renderLearnReport({ candidates: CANDIDATES, promotions: PROMOTIONS });
  assert.doesNotMatch(out, /^Impact addressed this run/m);
  assert.match(out, /^- Impact: \$4\.10 \(7 occurrences\)/m, "per-candidate impact must survive");
});

// Step 5's line-item diff found `sensitive` had no render home in either candidate section —
// a defect, not an acceptable drop, per D9's "standardization, not narrowing" rule.
test("the sensitive flag renders for both a landed and a declined candidate", () => {
  const out = renderLearnReport({ candidates: CANDIDATES, promotions: PROMOTIONS });
  assert.match(out, /^- Sensitive: no$/m, "the landed fixture is not sensitive-flagged");
  assert.match(out, /Brief omitted the evidence class.*· sensitive: no/,
    "the declined line carries the flag too, since sensitivity applies regardless of disposition");
});

// Phase 4: a retirement lifecycle record un-hardwires the r2→retired median and the retired
// count — the rollup times the transition from the real (at − landed) day-delta and counts it.
test("allTimeRollup times r2->retired from lifecycle records", () => {
  const roll = allTimeRollup([
    { rung: "r2", lifecycle: null, sourcedFromMemory: false, culpritId: "friction:a", landed: "2026-05-01" },
    { rung: "r2", lifecycle: "retirement", culpritId: "friction:a", landed: "2026-05-01", at: "2026-08-15" },
  ]);
  assert.equal(roll.byRung.r2.retired, 1);
  assert.equal(roll.transitions.r2retired, 106);
});

// Phase 4: the verify() candidate shape and the byte-budget line render into the report.
test("renderLearnReport renders verify candidates and the always-loaded budget line", () => {
  const verification = {
    scoreboard: [],
    candidates: {
      escalation: [{ culpritId: "friction:a", rung: "r2", reason: "recurred 3×" }],
      retirement: [{ culpritId: "friction:b", rung: "r2", reason: "held 6 runs since 2026-01-01" }],
    },
    resolvedIn: [],
  };
  const budget = { netBytes: 320, withinBudget: true };
  const out = renderLearnReport({ candidates: CANDIDATES, promotions: PROMOTIONS, verification, budget });
  assert.match(out, /`friction:a` \(r2\) — recurred 3×/);
  assert.match(out, /`friction:b` \(r2\) — held 6 runs since 2026-01-01/);
  assert.match(out, /^Always-loaded budget: 320 bytes/m);
});

// The propose gate's reinforcement outcome renders as its own ### Reinforcement section, and the
// escalation candidates now render under the renamed ### Graduation (r1/r2 → r3) heading.
test("renderLearnReport renders a reinforcement candidate and the renamed graduation heading", () => {
  const verification = {
    scoreboard: [],
    candidates: {
      escalation: [{ culpritId: "friction:c", rung: "r2", reason: "recurred 4×" }],
      retirement: [],
      reinforcement: [{ culpritId: "win:first-round-clean-accept", rung: "r1", reason: "held 5×" }],
    },
    resolvedIn: [],
  };
  const out = renderLearnReport({ candidates: CANDIDATES, promotions: PROMOTIONS, verification });
  assert.match(out, /### Graduation \(r1\/r2 → r3\)/);
  assert.match(out.split("### Graduation")[1] ?? "", /`friction:c` \(r2\) — recurred 4×/);
  const reinforcement = out.split("### Reinforcement")[1] ?? "";
  assert.match(reinforcement, /`win:first-round-clean-accept` \(r1\) — held 5×/);
});

const LEDGER = {
  from: "2026-08-01", to: "2026-09-01", sessions: 12,
  baseline: { from: "2026-06-01", to: "2026-09-01", sessions: 61 },
  rows: [
    { win: "first-round-clean-accept", occurrences: 14, prevents: ["review-reject:execution"], savings: 8.4, reason: null },
    { win: "gate-caught-regression", occurrences: 14, prevents: [], savings: null, reason: "declares no prevents" },
  ],
  savings: null, cost: 14.2, net: null, unpriced: 1,
  measured: { savings: 8.4, cost: 14.2 },
  excluded: { events: 1, keys: ["re-dispatch:unattributed"] },
};

test("the ledger section prints savings, cost, net, and the baseline window", () => {
  const md = renderLearnReport({ ...baseArgs(), ledger: LEDGER });
  assert.match(md, /## Ledger/);
  assert.match(md, /Period: 2026-08-01 → 2026-09-01 · 12 sessions/);
  assert.match(md, /baseline window: 2026-06-01 → 2026-09-01 \(61 sessions\)/);
  assert.match(md, /Win savings: unmeasurable \(1 of 2 rows unpriced\)/);
  assert.match(md, /Culprit cost: \$14\.20/);
  assert.match(md, /Net: unmeasurable/);
  assert.match(md, /Excluded: 1 events unattributable to a stage/);
});

test("an unmeasurable win row renders the word, never a dollar zero", () => {
  const md = renderLearnReport({ ...baseArgs(), ledger: LEDGER });
  const row = md.split("\n").find((l) => l.includes("gate-caught-regression"));
  assert.match(row, /unmeasurable/);
  assert.doesNotMatch(row, /\$0\.00/);
});

test("a priced win row renders its exact dollar figure", () => {
  const md = renderLearnReport({ ...baseArgs(), ledger: LEDGER });
  const row = md.split("\n").find((l) => l.includes("first-round-clean-accept"));
  assert.match(row, /\$8\.40/);
  assert.match(row, /review-reject:execution/);
});

test("the ledger section is omitted when no ledger is supplied", () => {
  const md = renderLearnReport(baseArgs());
  assert.doesNotMatch(md, /## Ledger/);
});
