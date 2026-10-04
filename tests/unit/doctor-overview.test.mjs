// The overview builder and its renderers, over hand-built tables. buildOverview and the render
// functions are pure, so each test states its inputs in full and pins the output it expects: the
// settled-population rule, the profile collapse, the unpriced and undetermined rules, and the
// two notes whose definitions carry thresholds. The wiring into doctor.mjs is tested in
// doctor-report.test.mjs and doctor.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildOverview, renderOverview, renderTrendSummary, OVERVIEW_STAGES, SPIKE_BAND_PCT,
} from "../../scripts/doctor-overview.mjs";

const BANDS = { flatBandPct: 5, minTrendN: 3, minCohort: 3 };
const UNDETERMINED = {
  direction: "insufficient-data", deltaPct: null, reason: "no matched cohort spans two versions with n>=3",
};
const DOWN = { direction: "down", deltaPct: -50, matchKey: "standard|feature|M", from: "0.1.0", to: "0.2.0" };

// A cohortTable row, a versionProfileTable row, a stageByVersionTable cell and a whole input —
// each carrying only the fields the overview reads, so a test shows what it varies.
const cohort = (version, over = {}) => ({
  version, sessions: 4, total: 40, medianPerSession: 10, quality: null, excluded: 0, ...over,
});
const profileRow = (version, profile, over = {}) => ({
  version, profile, sessions: 4, cycles: 4, medianCostPerCycle: 10, lowConfidence: false, excluded: 0,
  delta: { state: "first-seen", pct: null }, ...over,
});
const cell = (median, n = 3) => ({ median, n });
const stageRow = (stage, byVersion, trend = "flat") => ({ stage, byVersion, trend });
const input = (over = {}) => ({
  scope: "every devcycle-tagged session",
  cohorts: [], profileRows: [],
  stageByVersion: { versions: [], rows: [], excludedVersions: [] },
  stageWindow: [], direction: UNDETERMINED,
  shares: { inferredUnknownDollars: 0 }, inFlight: { sessions: 0, dollars: 0 }, bands: BANDS, ...over,
});

// A frozen input proves the builder reads without writing: an in-place sort or push on a table the
// report also renders would silently reorder it.
const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
};
const build = (over) => buildOverview(deepFreeze(input(over)));
const text = (overview) => renderOverview(overview).join("\n");
const sumOf = (list, pick) => list.reduce((n, item) => n + pick(item), 0);

test("every population is the settled one: the stage Total and version Total columns reconcile", () => {
  const overview = build({
    cohorts: [cohort("0.1.0", { total: 30 }), cohort("0.2.0", { total: 60 }), cohort("unknown", { total: 10 })],
    stageWindow: [{ stage: "execution", total: 70 }, { stage: "planning", total: 30 }],
    stageByVersion: { versions: ["0.1.0", "0.2.0"], rows: [], excludedVersions: [] },
    inFlight: { sessions: 2, dollars: 4.5 },
  });
  const { versions, stages, reconciliation } = overview;
  assert.equal(reconciliation.settledTotal, 100);
  const versionTotal = sumOf(versions.rows, (r) => r.total) + (versions.folded?.total ?? 0) + versions.unknown.total;
  assert.equal(versionTotal, reconciliation.settledTotal);
  const stageTotal = sumOf(stages.rows, (r) => r.total) + (stages.remaining?.total ?? 0);
  assert.equal(stageTotal, reconciliation.settledTotal);
  assert.deepEqual(
    { sessions: reconciliation.inFlightSessions, dollars: reconciliation.inFlightDollars },
    { sessions: 2, dollars: 4.5 },
  );
  assert.match(text(overview), /2 in-flight sessions \(\$4\.50\) are not in these tables; the full report's window table still counts them\./);
});

test("a corpus with nothing in flight says nothing about in-flight sessions", () => {
  const out = text(build({ cohorts: [cohort("0.1.0")], stageWindow: [{ stage: "execution", total: 40 }] }));
  assert.match(out, /Total sums to \$40\.00, the settled sessions' spend\./);
  assert.doesNotMatch(out, /in-flight/);
});

test("a stage with spend only in unknown-version sessions keeps its Total and Share and has no version cell or Trend", () => {
  const overview = build({
    cohorts: [cohort("0.1.0", { total: 20 }), cohort("unknown", { total: 80 })],
    stageWindow: [{ stage: "unversioned-stage", total: 80 }, { stage: "execution", total: 20 }],
    stageByVersion: {
      versions: ["0.1.0"], excludedVersions: [],
      rows: [stageRow("execution", { "0.1.0": cell(5) })],
    },
  });
  const row = overview.stages.rows.find((r) => r.stage === "unversioned-stage");
  assert.equal(row.total, 80);
  assert.equal(row.sharePct, 80);
  assert.deepEqual(row.cells, [null]);
  assert.equal(row.trend, null);
  assert.match(text(overview), /^\| unversioned-stage \| \$80\.00 \| 80\.0% \| — \| — \|$/m);
  // The dropped spend is named, in words that are not the report's own "Excluded from this table".
  assert.match(text(overview), /\$80\.00 \(80\.0% of settled spend\) sits in sessions with no detectable version/);
  assert.doesNotMatch(text(overview), /Excluded from this table/);
});

test("the stage table shows the top stages and folds the tail into one remaining row", () => {
  const stageWindow = Array.from({ length: OVERVIEW_STAGES + 2 }, (_, i) => ({ stage: `s${i}`, total: 100 - i }));
  const overview = build({
    cohorts: [cohort("0.1.0")],
    stageWindow,
    stageByVersion: { versions: ["0.1.0"], excludedVersions: [], rows: [] },
  });
  assert.equal(overview.stages.rows.length, OVERVIEW_STAGES);
  assert.deepEqual(overview.stages.remaining, {
    count: 2, total: 100 - 8 + (100 - 9), sharePct: ((100 - 8 + (100 - 9)) / sumOf(stageWindow, (r) => r.total)) * 100,
  });
  assert.match(text(overview), /^\| remaining 2 stages \| \$183\.00 \| [\d.]+% \| — \| — \|$/m);
  assert.equal(build({ cohorts: [cohort("0.1.0")], stageWindow: stageWindow.slice(0, 1) }).stages.remaining, null);
});

test("older versions fold into one row that sums sessions and total and leaves the other cells empty", () => {
  const overview = build({
    cohorts: [cohort("0.1.0", { sessions: 2, total: 5 }), cohort("0.2.0", { sessions: 3, total: 7 }), cohort("0.3.0")],
    stageByVersion: { versions: ["0.3.0"], excludedVersions: [], rows: [] },
    stageWindow: [{ stage: "execution", total: 52 }],
  });
  assert.deepEqual(overview.versions.folded, { count: 2, sessions: 5, total: 12, unpriced: false });
  assert.deepEqual(overview.versions.rows.map((r) => r.version), ["0.3.0"]);
  assert.match(text(overview), /^\| 2 older versions \| 5 \| \$12\.00 \| — \| — \| — \| — \|$/m);
});

test("the main profile has the most cycles; a tie goes to the name; unknown wins only alone", () => {
  const rows = (...p) => p.map(([profile, cycles]) => profileRow("0.1.0", profile, { cycles, sessions: cycles }));
  const split = (profileRows) => build({
    cohorts: [cohort("0.1.0")], profileRows,
    stageByVersion: { versions: ["0.1.0"], excludedVersions: [], rows: [] },
  }).versions;
  assert.equal(split(rows(["lean", 2], ["standard", 9])).main_profile, "standard");
  assert.equal(split(rows(["standard", 3], ["lean", 3])).main_profile, "lean");
  assert.equal(split(rows(["unknown", 50], ["lean", 1])).main_profile, "lean");
  assert.equal(split(rows(["unknown", 5])).main_profile, "unknown");
  assert.deepEqual(split(rows(["lean", 2], ["standard", 9], ["unknown", 4])).other_profiles, [
    { profile: "lean", cycles: 2, sessions: 2 }, { profile: "unknown", cycles: 4, sessions: 4 },
  ]);
});

test("an all-unknown-profile corpus is headed unknown profile and says the figure is per-session", () => {
  const overview = build({
    cohorts: [cohort("0.1.0")], profileRows: [profileRow("0.1.0", "unknown")],
    stageByVersion: { versions: ["0.1.0"], excludedVersions: [], rows: [] },
  });
  assert.match(text(overview), /\| Median \$\/cycle \(unknown profile\) \|/);
  assert.match(text(overview), /Median \$\/cycle is a per-session median/);
  assert.match(text(overview), /or a run record that names no profile/);
});

test("the main profile's cycles and delta fill the version row; other profiles are named in a footnote", () => {
  const overview = build({
    cohorts: [cohort("0.1.0"), cohort("0.2.0", { sessions: 5, total: 90, medianPerSession: 18 })],
    profileRows: [
      profileRow("0.1.0", "standard"),
      profileRow("0.2.0", "standard", { medianCostPerCycle: 22.5, delta: { state: "compared", pct: 125 } }),
      profileRow("0.2.0", "lean", { cycles: 1, sessions: 1 }),
    ],
    stageByVersion: { versions: ["0.1.0", "0.2.0"], excludedVersions: [], rows: [] },
  });
  assert.match(text(overview), /^\| 0\.2\.0 \| 5 \| \$90\.00 \| \$18\.00 \| \$22\.50 \| \+125\.0% \| — \|$/m);
  assert.match(text(overview), /Other profiles: lean \(1 cycle, 1 session\)\./);
});

test("a low-confidence cohort is marked in the Sessions cell and in the $/cycle cell by its own session count", () => {
  const overview = build({
    cohorts: [cohort("0.1.0", { sessions: 2 })],
    profileRows: [profileRow("0.1.0", "standard", { sessions: 2, lowConfidence: true })],
    stageByVersion: { versions: ["0.1.0"], excludedVersions: [], rows: [] },
  });
  assert.match(text(overview), /^\| 0\.1\.0 \| 2 \(low confidence: n<3\) \| \$40\.00 \| \$10\.00 \| \$10\.00 \(n=2\) \| first seen \| — \|$/m);
});

test("a version with unpriced requests is flagged, its delta withheld, and never shown as $0 or -100%", () => {
  const overview = build({
    cohorts: [cohort("0.1.0"), cohort("0.2.0", { total: 0, medianPerSession: 0, excluded: 7 })],
    profileRows: [
      profileRow("0.1.0", "standard"),
      profileRow("0.2.0", "standard", {
        medianCostPerCycle: 0, excluded: 7, delta: { state: "not-compared", pct: null, reason: "unpriced" },
      }),
    ],
    stageByVersion: { versions: ["0.1.0", "0.2.0"], excludedVersions: [], rows: [] },
    stageWindow: [{ stage: "execution", total: 40 }],
  });
  const out = text(overview);
  assert.match(out, /^\| ⚠ 0\.2\.0 \| 4 \| ⚠ unpriced \| ⚠ unpriced \| ⚠ unpriced \| not compared \(⚠ unpriced\) \| — \|$/m);
  const versionRows = out.split("\n").filter((line) => /^\| (⚠ )?0\./.test(line)).join("\n");
  assert.match(versionRows, /0\.2\.0/, "the version table carried no row for the unpriced version");
  assert.doesNotMatch(versionRows, /-100|\$0\.0000/);
  assert.deepEqual(overview.summary.trust.withheldVersions, ["0.2.0"]);
  assert.match(renderTrendSummary(overview).join("\n"), /Trust: ⚠ Δ withheld for 0\.2\.0/);
});

test("a version unpriced only outside the main profile keeps its real delta and says so", () => {
  const overview = build({
    cohorts: [cohort("0.1.0"), cohort("0.2.0", { excluded: 2 })],
    profileRows: [
      profileRow("0.1.0", "standard"),
      profileRow("0.2.0", "standard", { cycles: 9, delta: { state: "compared", pct: 10 } }),
      profileRow("0.2.0", "lean", { cycles: 1, excluded: 2 }),
    ],
    stageByVersion: { versions: ["0.1.0", "0.2.0"], excludedVersions: [], rows: [] },
  });
  const out = text(overview);
  assert.match(out, /^\| ⚠ 0\.2\.0 \| 4 \| \$40\.00 ⚠ \| \$10\.00 ⚠ \| \$10\.00 \| \+10\.0% \| — \|$/m);
  assert.match(out, /⚠ via another profile: 0\.2\.0/);
  assert.deepEqual(overview.summary.trust.withheldVersions, []);
});

test("an unpriced version folded into the older row flags that row, and the legend explains the withheld delta", () => {
  const overview = build({
    cohorts: [cohort("0.1.0", { excluded: 2 }), cohort("0.2.0"), cohort("0.3.0")],
    profileRows: [
      profileRow("0.1.0", "standard", { excluded: 2 }),
      profileRow("0.2.0", "standard", { delta: { state: "not-compared", pct: null, reason: "unpriced" } }),
      profileRow("0.3.0", "standard", { delta: { state: "compared", pct: 5 } }),
    ],
    stageByVersion: { versions: ["0.2.0", "0.3.0"], excludedVersions: [], rows: [] },
    stageWindow: [{ stage: "execution", total: 120 }],
  });
  const out = text(overview);
  assert.match(out, /^\| ⚠ 1 older version \| 4 \| \$40\.00 ⚠ \| — \| — \| — \| — \|$/m);
  assert.match(out, /^\| 0\.2\.0 \| 4 \| \$40\.00 \| \$10\.00 \| \$10\.00 \| not compared \(⚠ unpriced\) \| — \|$/m);
  assert.match(out, /⚠ marks a version with requests on a model with no exact price/);
  assert.doesNotMatch(text(build({ cohorts: [cohort("0.1.0")] })), /⚠ marks a version/);
});

test("the unknown-version row and the dearest version carry the ⚠ like any other, and a fully unpriced unknown row reads ⚠ unpriced", () => {
  const flaggedUnknown = text(build({
    cohorts: [cohort("0.1.0", { total: 90, excluded: 1 }), cohort("unknown", { excluded: 2 })],
    stageByVersion: { versions: ["0.1.0"], excludedVersions: [], rows: [] },
  }));
  assert.match(flaggedUnknown, /^\| no version detectable ⚠ \| 4 \| \$40\.00 ⚠ \| \$10\.00 ⚠ \| — \| — \| — \|$/m);
  assert.match(flaggedUnknown, /^Dearest version: 0\.1\.0 \(\$90\.00 ⚠\)$/m);
  const fullyUnpriced = text(build({
    cohorts: [cohort("unknown", { total: 0, medianPerSession: 0, excluded: 2 })],
  }));
  assert.match(fullyUnpriced, /^\| no version detectable ⚠ \| 4 \| ⚠ unpriced \| ⚠ unpriced \| — \| — \| — \|$/m);
});

test("a version unpriced only in a profile that has no row beside the main one has no 'via another profile' footnote", () => {
  const overview = build({
    cohorts: [cohort("0.1.0"), cohort("0.2.0", { excluded: 2 })],
    profileRows: [profileRow("0.1.0", "standard", { cycles: 9 }), profileRow("0.2.0", "lean", { excluded: 2 })],
    stageByVersion: { versions: ["0.1.0", "0.2.0"], excludedVersions: [], rows: [] },
    stageWindow: [{ stage: "execution", total: 80 }],
  });
  assert.equal(overview.versions.main_profile, "standard");
  assert.match(text(overview), /^\| ⚠ 0\.2\.0 \| 4 \| \$40\.00 ⚠ \| \$10\.00 ⚠ \| — \| — \| — \|$/m);
  assert.doesNotMatch(text(overview), /via another profile/);
});

test("the trust line counts every cell that carries a low-n mark, and no cell that does not", () => {
  const overview = build({
    cohorts: [cohort("0.1.0", { sessions: 2 }), cohort("0.2.0", { sessions: 1 })],
    profileRows: [
      profileRow("0.1.0", "standard", { sessions: 2, lowConfidence: true }),
      profileRow("0.2.0", "standard", { sessions: 1, lowConfidence: true }),
    ],
    stageWindow: [{ stage: "execution", total: 10 }],
    stageByVersion: {
      versions: ["0.1.0", "0.2.0"], excludedVersions: [],
      rows: [stageRow("execution", { "0.1.0": cell(1, 2), "0.2.0": cell(2, 1) }, "insufficient data (n=2→1)")],
    },
  });
  // Two Sessions cells, two $/cycle cells and two stage cells.
  assert.equal(overview.summary.trust.lowNCells, 6);
  assert.match(renderTrendSummary(overview).join("\n"), /Trust: 6 low-n cells/);
  // A $/cycle cell that renders ⚠ unpriced carries no n mark, so it is not one.
  const unpriced = build({
    cohorts: [cohort("0.1.0", { total: 0, medianPerSession: 0, excluded: 3 })],
    profileRows: [profileRow("0.1.0", "standard", { lowConfidence: true, medianCostPerCycle: 0, excluded: 3 })],
    stageByVersion: { versions: ["0.1.0"], excludedVersions: [], rows: [] },
  });
  assert.equal(unpriced.summary.trust.lowNCells, 0);
});

test("the Overview states its scope, and says nothing of one when the run named none", () => {
  assert.match(text(build({ cohorts: [cohort("0.1.0")] })), /^Scope: every devcycle-tagged session · settled sessions only$/m);
  assert.doesNotMatch(text(build({ scope: null, cohorts: [cohort("0.1.0")] })), /Scope:/);
});

test("a corpus that cannot name a direction says undetermined and never a direction", () => {
  const overview = build({ cohorts: [cohort("0.1.0")] });
  const out = text(overview);
  assert.match(out, /^Direction of travel: undetermined \(no matched cohort spans two versions with n>=3\)$/m);
  assert.doesNotMatch(out, /Direction of travel: (up|down|flat)/);
  const summary = renderTrendSummary(overview).join("\n");
  assert.match(summary, /Cost: direction undetermined \(no matched cohort/);
  assert.match(summary, /Trust: .*direction undetermined/);
  assert.equal(overview.summary.trust.directionUndetermined, true);
});

test("a determined direction is carried from the report's own statement", () => {
  const overview = build({ cohorts: [cohort("0.1.0"), cohort("0.2.0")], direction: DOWN });
  assert.match(text(overview), /^Direction of travel: down \(-50\.0% median cost, standard\|feature\|M, 0\.1\.0→0\.2\.0\)$/m);
  assert.equal(overview.summary.trust.directionUndetermined, false);
});

test("the dearest version is the one with the highest total, and a different highest median is named beside it", () => {
  const overview = build({
    cohorts: [
      cohort("0.1.0", { sessions: 3, total: 300, medianPerSession: 100 }),
      cohort("0.2.0", { sessions: 40, total: 800, medianPerSession: 20 }),
      cohort("0.3.0", { sessions: 1, total: 60, medianPerSession: 60 }),
    ],
  });
  const { dearest } = overview.versions;
  assert.equal(dearest.version, "0.2.0");
  // 0.3.0's median is a single session: it cannot be named the dearest median.
  assert.deepEqual(dearest.medianLeader, { version: "0.1.0", medianPerSession: 100 });
  assert.match(text(overview), /Dearest version: 0\.2\.0 \(\$800\.00\); highest median \$\/session: 0\.1\.0 \(\$100\.00\)/);
  assert.equal(build({ cohorts: [cohort("unknown")] }).versions.dearest, null);
});

test("quality renders rounds per task and retries over tasks, and an em dash with no run record", () => {
  const overview = build({
    cohorts: [
      cohort("0.1.0", { quality: { tasks: 8, reviewRounds: 10, retries: 2, roundsPerTask: 1.25 } }),
      cohort("0.2.0"),
    ],
    stageByVersion: { versions: ["0.1.0", "0.2.0"], excludedVersions: [], rows: [] },
  });
  assert.match(text(overview), /^\| 0\.1\.0 \|.* \| 1\.3 rounds\/task · 2\/8 retries\/tasks \|$/m);
  assert.match(text(overview), /^\| 0\.2\.0 \|.* \| — \|$/m);
});

test("stage cells carry n, and a cell below the trend gate says it is low n", () => {
  const overview = build({
    cohorts: [cohort("0.1.0"), cohort("0.2.0")],
    stageWindow: [{ stage: "execution", total: 10 }],
    stageByVersion: {
      versions: ["0.1.0", "0.2.0"], excludedVersions: [],
      rows: [stageRow("execution", { "0.1.0": cell(1, 3), "0.2.0": cell(2, 1) }, "insufficient data (n=3→1)")],
    },
  });
  assert.match(text(overview), /^\| execution \| \$10\.00 \| 100\.0% \| \$1\.00 \(n=3\) \| \$2\.00 \(n=1, low n\) \| insufficient data \(n=3→1\) \|$/m);
});

// A steadily-rising fixture: execution climbs through three reliable cells.
const risingInput = (cells, over = {}) => input({
  cohorts: [cohort("0.1.0"), cohort("0.2.0"), cohort("0.3.0")],
  stageWindow: [{ stage: "execution", total: 100 }],
  stageByVersion: {
    versions: ["0.1.0", "0.2.0", "0.3.0"], excludedVersions: [],
    rows: [stageRow("execution", cells, "up")],
  },
  ...over,
});

test("steadily rising needs a trend of up, three reliable cells and no reliable pair falling past the flat band", () => {
  const rising = (cells, over) => buildOverview(risingInput(cells, over)).stages.notes.risingStages;
  assert.deepEqual(rising({ "0.1.0": cell(1), "0.2.0": cell(2), "0.3.0": cell(3) }), ["execution"]);
  // A dip of 10% between adjacent reliable cells breaks the run; one inside the 5% band does not.
  assert.deepEqual(rising({ "0.1.0": cell(10), "0.2.0": cell(9), "0.3.0": cell(30) }), []);
  assert.deepEqual(rising({ "0.1.0": cell(10), "0.2.0": cell(9.6), "0.3.0": cell(30) }), ["execution"]);
  // A thin middle cell is skipped, leaving two reliable cells: too few.
  assert.deepEqual(rising({ "0.1.0": cell(1), "0.2.0": cell(50, 1), "0.3.0": cell(3) }), []);
  // The pair is judged across a skipped cell: 0.1.0 → 0.3.0 falls here.
  assert.deepEqual(rising({ "0.1.0": cell(10), "0.2.0": cell(50, 1), "0.3.0": cell(9) }), []);
});

test("a stage whose trend is not up is never steadily rising, however its cells climb", () => {
  const risingWith = (trend) => buildOverview(input({
    cohorts: [cohort("0.1.0"), cohort("0.2.0"), cohort("0.3.0")],
    stageWindow: [{ stage: "execution", total: 100 }],
    stageByVersion: {
      versions: ["0.1.0", "0.2.0", "0.3.0"], excludedVersions: [],
      rows: [stageRow("execution", { "0.1.0": cell(1), "0.2.0": cell(2), "0.3.0": cell(3) }, trend)],
    },
  })).stages.notes.risingStages;
  assert.deepEqual(risingWith("up"), ["execution"], "the control: the same cells do rise on an up trend");
  assert.deepEqual(risingWith("flat"), []);
});

test("rising and spike notes skip a version whose median leaves out unpriced requests, and say so", () => {
  const cells = { "0.1.0": cell(1), "0.2.0": cell(2), "0.3.0": cell(3) };
  const overview = buildOverview(risingInput(cells, {
    stageByVersion: {
      versions: ["0.1.0", "0.2.0", "0.3.0"], excludedVersions: ["0.2.0"],
      rows: [stageRow("execution", cells, "up")],
    },
  }));
  // Without 0.2.0 only two reliable cells remain.
  assert.deepEqual(overview.stages.notes.risingStages, []);
  assert.deepEqual(overview.stages.notes.skippedVersions, ["0.2.0"]);
  assert.match(text(overview), /Version-wide spike: none \(skips ⚠ version\(s\): 0\.2\.0\)/);
  assert.match(text(overview), /Medians for 0\.2\.0 leave out requests on a model with no exact price/);
});

test("a stage that is flat once the unpriced version is skipped is not steadily rising, though the report's trend said up", () => {
  const versions = ["0.1.0", "0.2.0", "0.3.0", "0.4.0"];
  const cells = { "0.1.0": cell(1), "0.2.0": cell(10), "0.3.0": cell(10), "0.4.0": cell(10) };
  const overview = buildOverview(input({
    cohorts: versions.map((v) => cohort(v)),
    stageWindow: [{ stage: "execution", total: 100 }],
    stageByVersion: { versions, excludedVersions: ["0.1.0"], rows: [stageRow("execution", cells, "up")] },
  }));
  assert.deepEqual(overview.stages.notes.risingStages, []);
  assert.match(text(overview), /^- Steadily rising: none \(skips ⚠ version\(s\): 0\.1\.0\)$/m);
});

test("at most three rising stages are listed, dearest first, with the rest counted", () => {
  const names = ["a", "b", "c", "d", "e"];
  const overview = buildOverview(input({
    cohorts: [cohort("0.1.0"), cohort("0.2.0"), cohort("0.3.0")],
    stageWindow: names.map((stage, i) => ({ stage, total: 50 - i })),
    stageByVersion: {
      versions: ["0.1.0", "0.2.0", "0.3.0"], excludedVersions: [],
      rows: names.map((n) => stageRow(n, { "0.1.0": cell(1), "0.2.0": cell(2), "0.3.0": cell(3) }, "up")),
    },
  }));
  assert.deepEqual(overview.stages.notes.risingStages, names);
  assert.match(text(overview), /^- Steadily rising: a, b, c \(\+2 more\)$/m);
});

// A version-wide spike fixture: N stages, each with reliable cells in 0.1.0 and 0.2.0.
const spikeInput = (pairs, over = {}) => input({
  cohorts: [cohort("0.1.0"), cohort("0.2.0")],
  stageWindow: pairs.map(([stage]) => ({ stage, total: 10 })),
  stageByVersion: {
    versions: ["0.1.0", "0.2.0"], excludedVersions: [],
    rows: pairs.map(([stage, before, after]) => stageRow(stage, { "0.1.0": cell(before), "0.2.0": cell(after) })),
  },
  ...over,
});

test("a version-wide spike is two thirds of at least three comparable stages rising past the spike band", () => {
  const spikes = (pairs, over) => buildOverview(spikeInput(pairs, over)).stages.notes.spikes;
  const past = 1 + (SPIKE_BAND_PCT + 5) / 100;
  const within = 1 + (SPIKE_BAND_PCT - 5) / 100;
  assert.deepEqual(spikes([["a", 10, 10 * past], ["b", 10, 10 * past], ["c", 10, 10]]), [
    { version: "0.2.0", comparable: 3, rose: 2 },
  ]);
  // One short of two thirds, and a rise inside the band, are not spikes.
  assert.deepEqual(spikes([["a", 10, 10 * past], ["b", 10, 10], ["c", 10, 10]]), []);
  assert.deepEqual(spikes([["a", 10, 10 * within], ["b", 10, 10 * within], ["c", 10, 10 * within]]), []);
  // Two comparable stages are too few to call a version-wide event.
  assert.deepEqual(spikes([["a", 10, 10 * past], ["b", 10, 10 * past]]), []);
});

test("a thin cell makes a stage not comparable, and an unpriced version is skipped at either end", () => {
  const spikesWith = (nOfC) => buildOverview(input({
    cohorts: [cohort("0.1.0"), cohort("0.2.0")],
    stageWindow: ["a", "b", "c"].map((stage) => ({ stage, total: 10 })),
    stageByVersion: {
      versions: ["0.1.0", "0.2.0"], excludedVersions: [],
      rows: [
        stageRow("a", { "0.1.0": cell(10), "0.2.0": cell(20) }),
        stageRow("b", { "0.1.0": cell(10), "0.2.0": cell(20) }),
        stageRow("c", { "0.1.0": cell(10, nOfC), "0.2.0": cell(20) }),
      ],
    },
  })).stages.notes.spikes;
  assert.equal(spikesWith(3).length, 1, "the control: with a reliable third cell the version spikes");
  assert.deepEqual(spikesWith(2), []);
  const pairs = [["a", 10, 20], ["b", 10, 20], ["c", 10, 20]];
  for (const excluded of [["0.1.0"], ["0.2.0"]])
    assert.deepEqual(buildOverview(spikeInput(pairs, {
      stageByVersion: spikeInput(pairs).stageByVersion && { ...spikeInput(pairs).stageByVersion, excludedVersions: excluded },
    })).stages.notes.spikes, []);
});

test("spikes are listed newest first, at most two", () => {
  const versions = ["0.1.0", "0.2.0", "0.3.0", "0.4.0"];
  const stages = ["a", "b", "c"];
  const overview = buildOverview(input({
    cohorts: versions.map((v) => cohort(v)),
    stageWindow: stages.map((stage) => ({ stage, total: 10 })),
    stageByVersion: {
      versions, excludedVersions: [],
      rows: stages.map((stage) => stageRow(stage, Object.fromEntries(versions.map((v, i) => [v, cell(10 * 2 ** i)])))),
    },
  }));
  assert.deepEqual(overview.stages.notes.spikes.map((s) => s.version), ["0.4.0", "0.3.0", "0.2.0"]);
  assert.match(text(overview), /^- Version-wide spike: 0\.4\.0 \(3 of 3 comparable stages rose >25%\), 0\.3\.0 \(3 of 3 comparable stages rose >25%\) \(\+1 more\)$/m);
});

test("the inferred or unknown share is dollars over the settled total", () => {
  const overview = build({
    cohorts: [cohort("0.1.0")], stageWindow: [{ stage: "execution", total: 200 }],
    shares: { inferredUnknownDollars: 50 },
  });
  assert.deepEqual(overview.stages.notes.inferredUnknown, { dollars: 50, sharePct: 25 });
  assert.match(text(overview), /^- Inferred or unknown stage: \$50\.00 \(25\.0% of settled spend\)$/m);
});

test("the trend summary is three bullets in a fixed order, and says no caveats when none apply", () => {
  const overview = build({
    cohorts: [cohort("0.1.0"), cohort("0.2.0", { total: 90 })], direction: DOWN,
    stageWindow: [{ stage: "execution", total: 130 }],
    stageByVersion: {
      versions: ["0.1.0", "0.2.0"], excludedVersions: [],
      rows: [stageRow("execution", { "0.1.0": cell(1), "0.2.0": cell(2) })],
    },
  });
  const lines = renderTrendSummary(overview);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^- Cost: direction down \(-50\.0% median cost, standard\|feature\|M, 0\.1\.0→0\.2\.0\); dearest version 0\.2\.0 \(\$90\.00\)$/);
  assert.equal(lines[1], "- Stages: dearest execution (100.0%); rising: none; version-wide spike: none");
  assert.equal(lines[2], "- Trust: no caveats");
});

test("every dollar and percent figure in the trend summary is one the overview prints", () => {
  const overview = build({
    cohorts: [cohort("0.1.0", { total: 30 }), cohort("0.2.0", { total: 70, excluded: 1 })],
    profileRows: [
      profileRow("0.1.0", "standard"),
      profileRow("0.2.0", "standard", { excluded: 1, delta: { state: "not-compared", pct: null, reason: "unpriced" } }),
    ],
    direction: DOWN,
    stageWindow: [{ stage: "execution", total: 60 }, { stage: "planning", total: 40 }],
    stageByVersion: {
      versions: ["0.1.0", "0.2.0"], excludedVersions: [],
      rows: [stageRow("execution", { "0.1.0": cell(1), "0.2.0": cell(2) })],
    },
    shares: { inferredUnknownDollars: 12 },
  });
  const printed = text(overview);
  const figures = renderTrendSummary(overview).join("\n").match(/\$[\d.]+|-?[\d.]+%/g);
  assert.ok(figures.length >= 4, "the summary carried too few figures for this check to mean anything");
  for (const figure of figures) assert.ok(printed.includes(figure), `the summary printed ${figure}, which the overview does not`);
});

test("an empty corpus renders both blocks with no NaN, no undefined and a reason for each empty table", () => {
  const overview = build();
  const out = [...renderOverview(overview), ...renderTrendSummary(overview)].join("\n");
  assert.doesNotMatch(out, /NaN|undefined|Infinity|null/);
  assert.match(out, /_No rows: no settled sessions in this corpus\._/);
  assert.match(out, /_No rows: no stage cost recorded among settled sessions\._/);
  assert.equal(overview.reconciliation.settledTotal, 0);
  assert.match(out, /Trust: .*direction undetermined/);
});

test("buildOverview and the renderers are deterministic and leave their input untouched", () => {
  const over = {
    cohorts: [cohort("0.1.0"), cohort("0.2.0")], direction: DOWN,
    stageWindow: [{ stage: "execution", total: 10 }],
    stageByVersion: { versions: ["0.1.0", "0.2.0"], excludedVersions: [], rows: [stageRow("execution", { "0.1.0": cell(1), "0.2.0": cell(2) })] },
  };
  assert.deepEqual(build(over), build(over));
  assert.ok(renderOverview(build(over)).length > 10, "the render was too short for this check to mean anything");
  assert.deepEqual(renderOverview(build(over)), renderOverview(build(over)));
});

test("doctor-overview imports only doctor-format and reads no file, clock or environment", () => {
  const source = readFileSync(new URL("../../scripts/doctor-overview.mjs", import.meta.url), "utf8");
  const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(imports, ["./doctor-format.mjs"]);
  assert.doesNotMatch(source, /\b(Date|process|readFileSync|Math\.random)\b/);
  assert.ok(!source.startsWith("#!"));
});
