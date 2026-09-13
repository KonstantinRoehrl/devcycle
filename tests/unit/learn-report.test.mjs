import test from "node:test";
import assert from "node:assert/strict";
import { renderLearnReport, allTimeRollup, routingAdvisoriesSection } from "../../scripts/learn-report.mjs";

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

// The advisory shape routingAdvisoriesSection is handed, with every counted field present. The
// renderer states a count or says it is unmeasurable, so a fixture that silently omitted one would
// assert against a shape the generator never produces.
const advisory = ({ corpus = {}, exclusions = {}, cells = [], classes = [] }) => ({
  corpus: {
    transcripts: 0, joined: 0, withTask: 0, withKind: 0, withVerdict: 0,
    taskFromRecord: 0, taskFromDescription: 0, measuredUSD: null, unmeasurable: 0, ...corpus,
  },
  exclusions: {
    unjoinedSession: 0, unparseableTask: 0, unknownRequestKind: 0, missingTranscript: 0,
    noPricedTurns: 0, unpricedModel: 0, multiModel: 0, noVerdict: 0, ...exclusions,
  },
  cells, classes,
});

test("routingAdvisoriesSection: renders each state and never prints $0 for an unmeasurable figure", () => {
  const cell = (model, dispatches, accepted, costPerAcceptedValue) => ({
    requestKind: "feature", model, dispatches, accepted,
    totalUSD: costPerAcceptedValue == null ? 0 : costPerAcceptedValue * accepted,
    meanUSD: 1, costPerAccepted: costPerAcceptedValue,
  });
  const cheap = cell("claude-sonnet-5", 28, 22, 1.2);
  const dear = cell("claude-opus-4-8", 41, 30, 4.46);
  const text = routingAdvisoriesSection(advisory({
    corpus: {
      transcripts: 779, joined: 396, withTask: 264, withKind: 279, withVerdict: 231,
      taskFromRecord: 12, taskFromDescription: 252, measuredUSD: 1046.8, unmeasurable: 1,
    },
    exclusions: {
      unjoinedSession: 383, unparseableTask: 132, unknownRequestKind: 117,
      missingTranscript: 1, multiModel: 6, noVerdict: 33,
    },
    cells: [cheap, dear],
    classes: [{
      requestKind: "feature", cheapest: "claude-sonnet-5", comparatorFloor: 5,
      comparisons: [
        { model: "claude-sonnet-5", state: "baseline", interval: null, cell: cheap,
          comparator: null, comparatorEligible: true },
        { model: "claude-opus-4-8", state: "premium-not-justified", direction: "premium", cell: dear, comparator: cheap,
          comparatorEligible: true,
          interval: { median: 3.72, low: 2.3, high: 5.74, draws: 20000, discarded: 0, resamples: 20000 } },
      ],
    }],
  }));
  assert.match(text, /premium-not-justified/);
  assert.match(text, /3\.72/, "the ratio's median is cited");
  assert.match(text, /2\.30.*5\.74/s, "the interval is cited alongside it");
  assert.match(text, /41/, "the dispatch count behind the pricier cell is cited");
  assert.match(text, /unparseable task attribution.*132/s, "every exclusion is counted");
  assert.match(text, /\| baseline \|/, "the comparator's own row says it IS the baseline");
  assert.match(text, /0 of 20000 draws discarded/, "the bootstrap's own discards ride with the interval");
  assert.doesNotMatch(text, /\$0\.00\b/, "no figure in this fixture is zero");
});

// "Joined" counted every implementer transcript found, including the 351 that matched no session
// line in the journal, which were then billed to unknown requestKind.
test("routingAdvisoriesSection: transcripts found and dispatches joined are separate counts", () => {
  const text = routingAdvisoriesSection(advisory({
    corpus: {
      transcripts: 779, joined: 428, withTask: 264, withKind: 279, withVerdict: 231,
      taskFromRecord: 12, taskFromDescription: 252, measuredUSD: 1046.8, unmeasurable: 1,
    },
    exclusions: { unjoinedSession: 351 },
  }));
  assert.match(text, /transcripts found: 779/, "every transcript the reader walked is counted");
  assert.match(text, /joined to a run: 428/, "joined means joined to a run");
  assert.match(text, /^- session absent from the run journal — 351$/m,
    "the rows that joined to nothing are named as their own class");
  assert.match(text, /12 from the dispatch record/, "how each task number was attributed is stated");
});

// A transcript that exists but prices nothing is its own bucket (noPricedTurns), never folded
// into missingTranscript, which states something untrue about the corpus (transcript-exists
// dispatches are not missing-transcript dispatches).
test("routingAdvisoriesSection: the no-priced-turns exclusion renders under its own label", () => {
  const text = routingAdvisoriesSection(advisory({
    corpus: { transcripts: 10, joined: 10, withTask: 10, withKind: 10, withVerdict: 10, measuredUSD: 5 },
    exclusions: { missingTranscript: 2, noPricedTurns: 4 },
  }));
  assert.match(text, /^- no priced turns — 4$/m,
    "transcript-exists-but-nothing-priceable gets its own labeled count");
  assert.match(text, /^- missing transcript — 2$/m, "missingTranscript keeps its own distinct count");
});

test("routingAdvisoriesSection: an unresolved comparison names its interval and its discarded draws", () => {
  const cheap = { requestKind: "refactor", model: "claude-sonnet-5", dispatches: 9, accepted: 7, totalUSD: 9, meanUSD: 1, costPerAccepted: 1.28 };
  const dear = { requestKind: "refactor", model: "claude-opus-4-8", dispatches: 8, accepted: 4, totalUSD: 17, meanUSD: 2.1, costPerAccepted: 4.25 };
  const text = routingAdvisoriesSection(advisory({
    corpus: { transcripts: 17, joined: 17, withTask: 17, withKind: 17, withVerdict: 17, taskFromDescription: 17, measuredUSD: 26 },
    cells: [cheap, dear],
    classes: [{ requestKind: "refactor", cheapest: "claude-sonnet-5", comparatorFloor: 5, comparisons: [
      { model: "claude-sonnet-5", state: "baseline", interval: null, cell: cheap, comparator: null, comparatorEligible: true },
      { model: "claude-opus-4-8", state: "unresolved", cell: dear, comparator: cheap, comparatorEligible: true,
        interval: { median: 1.66, low: 0.93, high: 2.91, draws: 12843, discarded: 7157, resamples: 20000 } },
    ] }],
  }));
  assert.match(text, /unresolved/);
  assert.match(text, /0\.93.*2\.91/s, "an unresolved cell shows how far from a conclusion it sits");
  assert.match(text, /7157 of 20000 draws discarded/,
    "an interval conditional on both cells accepting says how many draws it dropped to get there");
});

// A cell that spent $60 over 20 dispatches and accepted nothing is the strongest possible
// premium-not-justified signal; rendering it as an absence reads as no data.
test("routingAdvisoriesSection: a cell that accepted nothing reports what it is, not an absence", () => {
  const cheap = { requestKind: "docs", model: "claude-sonnet-5", dispatches: 9, accepted: 6, totalUSD: 9, meanUSD: 1, costPerAccepted: 1.5 };
  const none = { requestKind: "docs", model: "claude-opus-5", dispatches: 20, accepted: 0, totalUSD: 60, meanUSD: 3, costPerAccepted: null };
  const text = routingAdvisoriesSection(advisory({
    corpus: { transcripts: 29, joined: 29, withTask: 29, withKind: 29, withVerdict: 29, taskFromDescription: 29, measuredUSD: 69 },
    cells: [cheap, none],
    classes: [{ requestKind: "docs", cheapest: "claude-sonnet-5", comparatorFloor: 5, comparisons: [
      { model: "claude-sonnet-5", state: "baseline", interval: null, cell: cheap, comparator: null, comparatorEligible: true },
      { model: "claude-opus-5", state: "no-accepts", noAccepts: "compared", interval: null,
        cell: none, comparator: cheap, comparatorEligible: true },
    ] }],
  }));
  assert.match(text, /\| no-accepts \|/, "the verdict column names the state rather than leaving a dash");
  assert.match(text, /\$60\.00/, "the dollars it did spend are named");
  assert.match(text, /unmeasurable/, "no accepted task means no cost per accepted task");
  assert.doesNotMatch(text, /\$0\.00/, "an unmeasurable cost per accepted task must not read as zero");
});

// § 4.1: a below-floor cell is reported and named, never silently dropped and never the baseline.
test("routingAdvisoriesSection: a below-floor cell is marked, and the floor it failed is named", () => {
  const thin = { requestKind: "bug", model: "claude-haiku-4-5", dispatches: 2, accepted: 2, totalUSD: 1, meanUSD: 0.5, costPerAccepted: 0.5 };
  const cheap = { requestKind: "bug", model: "claude-sonnet-5", dispatches: 26, accepted: 18, totalUSD: 26, meanUSD: 1, costPerAccepted: 1.44 };
  const text = routingAdvisoriesSection(advisory({
    corpus: { transcripts: 28, joined: 28, withTask: 28, withKind: 28, withVerdict: 28, taskFromDescription: 28, measuredUSD: 27 },
    cells: [thin, cheap],
    classes: [{ requestKind: "bug", cheapest: "claude-sonnet-5", comparatorFloor: 5, comparisons: [
      { model: "claude-haiku-4-5", state: "unresolved", cell: thin, comparator: cheap, comparatorEligible: false,
        interval: { median: 0.35, low: 0.1, high: 1.4, draws: 20000, discarded: 0, resamples: 20000 } },
      { model: "claude-sonnet-5", state: "baseline", interval: null, cell: cheap, comparator: null, comparatorEligible: true },
    ] }],
  }));
  assert.match(text, /claude-haiku-4-5.*‡/s, "the below-floor row is marked where it is read");
  assert.match(text, /‡ below the comparator floor of 5 dispatches/,
    "and the mark is explained: reported, never the baseline");
  assert.match(text, /0\.35/, "its own comparison is still reported");
});

// A below-floor cell can be cheaper than the comparator, since the comparator is the cheapest
// ELIGIBLE cell. Rendering that row in premium words tells the reader a premium was paid.
test("routingAdvisoriesSection: a cheaper-than-baseline row reads as a route-down hint, not a premium", () => {
  const thin = { requestKind: "bug", model: "claude-haiku-4-5", dispatches: 2, accepted: 2, totalUSD: 0.58, meanUSD: 0.29, costPerAccepted: 0.29 };
  const cheap = { requestKind: "bug", model: "claude-sonnet-5", dispatches: 26, accepted: 19, totalUSD: 43.7, meanUSD: 1.68, costPerAccepted: 2.3 };
  const text = routingAdvisoriesSection(advisory({
    corpus: { transcripts: 28, joined: 28, withTask: 28, withKind: 28, withVerdict: 28, taskFromDescription: 28, measuredUSD: 44.28 },
    cells: [thin, cheap],
    classes: [{ requestKind: "bug", cheapest: "claude-sonnet-5", comparatorFloor: 5, comparisons: [
      { model: "claude-haiku-4-5", state: "costs-less-per-accepted", direction: "discount",
        cell: thin, comparator: cheap, comparatorEligible: false,
        interval: { median: 0.12, low: 0.09, high: 0.17, draws: 20000, discarded: 0, resamples: 20000 } },
      { model: "claude-sonnet-5", state: "baseline", direction: null, interval: null, cell: cheap, comparator: null, comparatorEligible: true },
    ] }],
  }));
  // The table row itself, not the whole section: the note under the table is allowed to say what
  // the row is NOT ("not a justified premium"), while the verdict a reader scans must not.
  const row = text.split("\n").find((l) => l.includes("`claude-haiku-4-5`"));
  assert.match(row, /\| costs-less-per-accepted \|/, "the verdict column states the direction it measured");
  assert.doesNotMatch(row, /premium/, "no premium was paid on this row, so its verdict may not use a premium word");
  assert.match(text, /route-down candidate/, "the cheap cell winning is the artifact's strongest route-down hint");
});

test("routingAdvisoriesSection: a class with no cell above the floor says so instead of naming a baseline", () => {
  const a = { requestKind: "chore", model: "claude-sonnet-5", dispatches: 3, accepted: 2, totalUSD: 3, meanUSD: 1, costPerAccepted: 1.5 };
  const b = { requestKind: "chore", model: "claude-opus-5", dispatches: 2, accepted: 1, totalUSD: 8, meanUSD: 4, costPerAccepted: 8 };
  const text = routingAdvisoriesSection(advisory({
    corpus: { transcripts: 5, joined: 5, withTask: 5, withKind: 5, withVerdict: 5, taskFromDescription: 5, measuredUSD: 11 },
    cells: [a, b],
    classes: [{ requestKind: "chore", cheapest: null, comparatorFloor: 5, comparisons: [
      { model: "claude-sonnet-5", state: "no-comparator", reason: "no-cell-meets-floor", interval: null, cell: a, comparator: null, comparatorEligible: false },
      { model: "claude-opus-5", state: "no-comparator", reason: "no-cell-meets-floor", interval: null, cell: b, comparator: null, comparatorEligible: false },
    ] }],
  }));
  assert.match(text, /no cell in this class holds the 5 dispatches/i,
    "the class says why every row reports no-comparator");
  assert.doesNotMatch(text, /Compared against/, "there is no comparator to compare against");
});

test("routingAdvisoriesSection: an empty corpus renders no zeros", () => {
  const text = routingAdvisoriesSection(advisory({}));
  assert.match(text, /no measurable dispatch/i);
  assert.doesNotMatch(text, /\$0\.00/);
});

test("renderLearnReport: the section is spliced in only when advisories are supplied", () => {
  assert.doesNotMatch(renderLearnReport(baseArgs()), /## Routing advisories/);
  const withAdvisories = renderLearnReport({
    ...baseArgs(),
    routingAdvisories: advisory({}),
  });
  assert.match(withAdvisories, /## Routing advisories/);
});
