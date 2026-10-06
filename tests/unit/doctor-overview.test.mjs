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
  assert.match(text(overview), /^\| unversioned-stage \| \$80\.00 \| 80\.0% \| — \|$/m);
  assert.match(text(overview), /^- unversioned-stage: —$/m);
  // The dropped spend is named, in words that are not the report's own "Excluded from this table".
  assert.match(text(overview), /\$80\.00 \(80\.0% of settled spend\) sits in sessions with no detectable version/);
  assert.doesNotMatch(text(overview), /Excluded from this table/);
});

test("the stage table shows the top stages and folds the tail into one remaining row", () => {
  // The window arrives dearest first, so the shown rows are its head and the dearest stage its first.
  const stageWindow = Array.from({ length: OVERVIEW_STAGES + 2 }, (_, i) => ({ stage: `s${i}`, total: 100 - i }));
  const overview = build({
    cohorts: [cohort("0.1.0")],
    stageWindow,
    stageByVersion: { versions: ["0.1.0"], excludedVersions: [], rows: [] },
  });
  assert.deepEqual(overview.stages.rows.map((r) => r.stage), stageWindow.slice(0, OVERVIEW_STAGES).map((r) => r.stage));
  assert.deepEqual(overview.stages.remaining, {
    count: 2, total: 100 - 8 + (100 - 9), sharePct: ((100 - 8 + (100 - 9)) / sumOf(stageWindow, (r) => r.total)) * 100,
  });
  assert.equal(
    sumOf(overview.stages.rows, (r) => r.total) + overview.stages.remaining.total,
    overview.reconciliation.settledTotal,
  );
  assert.match(text(overview), /^\| remaining 2 stages \| \$183\.00 \| [\d.]+% \| — \|$/m);
  // s0 is $100.00 of the window's $955.00.
  assert.match(text(overview), /^- Dearest stage: s0 \(\$100\.00, 10\.5% of settled spend\)$/m);
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
  // With no unknown-version row, the folded versions are the whole of the spend no column shows.
  assert.equal(overview.versions.unknown, null);
  assert.match(text(overview), /^_\$12\.00 \(23\.1% of settled spend\) sits in sessions with no detectable version or in versions older than the columns shown/m);
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

test("the main profile is counted over the shown versions only, so an older folded version cannot pick it", () => {
  const profileRows = [
    profileRow("0.1.0", "lean", { cycles: 50, sessions: 50 }),
    profileRow("0.2.0", "standard", { cycles: 4 }),
    profileRow("0.2.0", "lean", { cycles: 1, sessions: 1 }),
  ];
  const splitShowing = (versions) => build({
    cohorts: [cohort("0.1.0"), cohort("0.2.0")], profileRows,
    stageByVersion: { versions, excludedVersions: [], rows: [] },
  }).versions;
  // The control: with 0.1.0 shown, its 50 lean cycles do make lean the main profile.
  assert.equal(splitShowing(["0.1.0", "0.2.0"]).main_profile, "lean");
  const shownOnly = splitShowing(["0.2.0"]);
  assert.equal(shownOnly.main_profile, "standard");
  assert.deepEqual(shownOnly.other_profiles, [{ profile: "lean", cycles: 1, sessions: 1 }]);
});

test("an all-unknown-profile corpus is headed unknown profile and says the figure is per-session", () => {
  const overview = build({
    cohorts: [cohort("0.1.0")], profileRows: [profileRow("0.1.0", "unknown")],
    stageByVersion: { versions: ["0.1.0"], excludedVersions: [], rows: [] },
  });
  assert.match(text(overview), /\| Median \$\/cycle \(unknown profile\) \|/);
  assert.match(text(overview), /Median \$\/cycle is a per-session median/);
  // One sentence naming both things the profile covers; a tail-only match let the clauses drift apart.
  assert.ok(text(overview).includes(
    "Profile `unknown` is either a session with no run record (which forms a one-session cycle, " +
      "so its $/cycle is really per-session) or a run record that names no profile.",
  ));
  // A detectable version whose every cycle is under unknown keeps the per-session wording whole; only
  // a corpus with no detectable version says no figure is computed.
  assert.ok(text(overview).includes(
    "or a run record that names no profile. Every cycle here is under it, so Median $/cycle is a per-session median._",
  ));
  assert.doesNotMatch(text(overview), /No version is detectable/);
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
  assert.match(text(overview), /^_Δ is profile-matched, not workload-adjusted: direction, not verdict\._$/m);
});

test("a low-confidence cohort is marked in the Sessions cell and in the $/cycle cell by its own session count", () => {
  const overview = build({
    cohorts: [cohort("0.1.0", { sessions: 2 })],
    profileRows: [profileRow("0.1.0", "standard", { sessions: 2, lowConfidence: true })],
    stageByVersion: { versions: ["0.1.0"], excludedVersions: [], rows: [] },
  });
  assert.match(text(overview), /^\| 0\.1\.0 \| 2 \(low confidence: n<3\) \| \$40\.00 \| \$10\.00 \| \$10\.00 \(n=2\) \| first seen \| — \|$/m);
  // A version of five sessions, two of them in the main profile: the $/cycle n is the profile's two.
  const mixed = build({
    cohorts: [cohort("0.1.0", { sessions: 5 })],
    profileRows: [
      profileRow("0.1.0", "standard", { sessions: 2, lowConfidence: true }),
      profileRow("0.1.0", "lean", { cycles: 1, sessions: 3 }),
    ],
    stageByVersion: { versions: ["0.1.0"], excludedVersions: [], rows: [] },
  });
  assert.equal(mixed.versions.main_profile, "standard");
  assert.match(text(mixed), /^\| 0\.1\.0 \| 5 \| \$40\.00 \| \$10\.00 \| \$10\.00 \(n=2\) \| first seen \| — \|$/m);
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
  assert.match(flaggedUnknown, /^\| ⚠ no version detectable \| 4 \| \$40\.00 ⚠ \| \$10\.00 ⚠ \| — \| — \| — \|$/m);
  assert.match(flaggedUnknown, /^Dearest version: 0\.1\.0 \(\$90\.00 ⚠\)$/m);
  const fullyUnpriced = text(build({
    cohorts: [cohort("unknown", { total: 0, medianPerSession: 0, excluded: 2 })],
  }));
  assert.match(fullyUnpriced, /^\| ⚠ no version detectable \| 4 \| ⚠ unpriced \| ⚠ unpriced \| — \| — \| — \|$/m);
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

test("a version unpriced only outside the main profile is footnoted whatever its own delta, and the next version's delta against it is a real percentage", () => {
  // 0.2.0 is unpriced only in lean, so its standard row holds none of those requests: they withhold no
  // standard-profile Δ to or from it, and 0.3.0's Δ against it is compared.
  const threeVersions = (ownDelta, previous = profileRow("0.1.0", "standard", { cycles: 9 })) => text(build({
    cohorts: [cohort("0.1.0", { excluded: previous.excluded }), cohort("0.2.0", { excluded: 2 }), cohort("0.3.0")],
    profileRows: [
      previous,
      profileRow("0.2.0", "standard", { cycles: 9, delta: ownDelta }),
      profileRow("0.2.0", "lean", { cycles: 1, excluded: 2 }),
      profileRow("0.3.0", "standard", { cycles: 9, medianCostPerCycle: 15, delta: { state: "compared", pct: 50 } }),
    ],
    stageByVersion: { versions: ["0.1.0", "0.2.0", "0.3.0"], excludedVersions: [], rows: [] },
  }));
  const cases = {
    "first seen": threeVersions({ state: "first-seen", pct: null }, profileRow("0.1.0", "lean", { cycles: 1 })),
    // Withheld because the previous version's main-profile row is unpriced, not because of 0.2.0's own requests.
    "not compared \\(⚠ unpriced\\)": threeVersions(
      { state: "not-compared", pct: null, reason: "unpriced" },
      profileRow("0.1.0", "standard", { cycles: 9, excluded: 1 }),
    ),
    "\\+25\\.0%": threeVersions({ state: "compared", pct: 25 }),
  };
  for (const [ownDelta, out] of Object.entries(cases)) {
    assert.match(out, new RegExp(`^\\| ⚠ 0\\.2\\.0 \\|.* \\| ${ownDelta} \\| — \\|$`, "m"));
    assert.match(out, /^\| 0\.3\.0 \|.* \| \+50\.0% \| — \|$/m);
    assert.ok(out.includes(
      "_⚠ via another profile: 0.2.0 — the unpriced requests sit outside the standard profile, " +
        "so they withhold no standard-profile Δ to or from it._",
    ), `no 'via another profile' footnote when 0.2.0's own Δ is ${ownDelta}`);
    // The legend scopes the withheld Δ to a profile row holding the unpriced requests, so 0.3.0's
    // compared Δ against ⚠ 0.2.0 does not contradict it.
    assert.ok(out.includes(
      "_⚠ marks a version with requests on a model with no exact price: they are left out of its dollar " +
        "figures, and any Δ that compares a profile row holding them is withheld._",
    ));
    assert.doesNotMatch(out, /so that Δ is the profile's own|any Δ that compares against it/);
  }
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
  // The unknown-version row's Sessions cell is one like any other.
  const unknownWith = (sessions) => build({ cohorts: [cohort("0.1.0"), cohort("unknown", { sessions })] });
  assert.equal(unknownWith(3).summary.trust.lowNCells, 0, "the control: an unknown row at the minimum is no low-n cell");
  const thinUnknown = unknownWith(2);
  assert.match(text(thinUnknown), /^\| no version detectable \| 2 \(low confidence: n<3\) \|/m);
  assert.equal(thinUnknown.summary.trust.lowNCells, 1);
  assert.match(renderTrendSummary(thinUnknown).join("\n"), /Trust: 1 low-n cell\b/);
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
  assert.deepEqual(dearest.medianLeader, {
    version: "0.1.0", medianPerSession: 100, unpriced: false, sessions: 3, sessionsLowConfidence: false,
  });
  assert.match(text(overview), /Dearest version: 0\.2\.0 \(\$800\.00\); highest median \$\/session: 0\.1\.0 \(\$100\.00\)/);
  assert.equal(build({ cohorts: [cohort("unknown")] }).versions.dearest, null);
});

test("the highest median is taken over every known version, so a thin version with the top median is named and a cheaper median never is", () => {
  // 0.2.0 has two sessions: the dearest by total and by median. 0.1.0 has three sessions and a lower
  // median, so it must not be named "highest median".
  const dearestIsMedianLeader = build({
    cohorts: [
      cohort("0.1.0", { sessions: 3, total: 10, medianPerSession: 3.4 }),
      cohort("0.2.0", { sessions: 2, total: 204.7, medianPerSession: 102.3 }),
    ],
  });
  assert.equal(dearestIsMedianLeader.versions.dearest.medianLeader, null);
  assert.doesNotMatch(text(dearestIsMedianLeader), /highest median/);
  // A thin version genuinely holding the top median is named beside the dearest by total.
  const thinLeader = build({
    cohorts: [
      cohort("0.1.0", { sessions: 40, total: 800, medianPerSession: 20 }),
      cohort("0.2.0", { sessions: 1, total: 60, medianPerSession: 60 }),
    ],
  });
  assert.equal(thinLeader.versions.dearest.medianLeader.version, "0.2.0");
  assert.match(text(thinLeader), /Dearest version: 0\.1\.0 \(\$800\.00\); highest median \$\/session: 0\.2\.0 \(\$60\.00, /);
});

test("the highest median $/session carries the ⚠ and the low-confidence mark its own table cells carry", () => {
  const leaderLine = (leader) => text(build({
    cohorts: [cohort("0.1.0", { sessions: 10, total: 200, medianPerSession: 20 }), cohort("0.2.0", leader)],
  })).split("\n").find((line) => line.startsWith("Dearest version:"));
  // The control: a priced leader at the cohort minimum is named bare.
  assert.equal(
    leaderLine({ sessions: 3, total: 90, medianPerSession: 30 }),
    "Dearest version: 0.1.0 ($200.00); highest median $/session: 0.2.0 ($30.00)",
  );
  assert.equal(
    leaderLine({ sessions: 3, total: 90, medianPerSession: 30, excluded: 3 }),
    "Dearest version: 0.1.0 ($200.00); highest median $/session: 0.2.0 ($30.00 ⚠)",
  );
  // The mark is the Sessions cell's own wording, so the line and the table cannot disagree on n.
  assert.equal(
    leaderLine({ sessions: 1, total: 83.7, medianPerSession: 83.7 }),
    "Dearest version: 0.1.0 ($200.00); highest median $/session: 0.2.0 ($83.70, sessions: 1 (low confidence: n<3))",
  );
  assert.equal(
    leaderLine({ sessions: 1, total: 83.7, medianPerSession: 83.7, excluded: 1 }),
    "Dearest version: 0.1.0 ($200.00); highest median $/session: 0.2.0 ($83.70 ⚠, sessions: 1 (low confidence: n<3))",
  );
});

test("a corpus with no detectable version is headed unknown profile and says no per-version figure is computed", () => {
  // Without run records every cycle is under unknown; with them, the runs here name standard. Either
  // way no version row exists to take a $/cycle or Δ from.
  const corpora = {
    "no run records": [profileRow("unknown", "unknown", { sessions: 3, cycles: 3 })],
    "run records naming standard": [
      profileRow("unknown", "standard", { sessions: 2, cycles: 1 }),
      profileRow("unknown", "unknown", { sessions: 1, cycles: 1 }),
    ],
  };
  for (const [corpus, profileRows] of Object.entries(corpora)) {
    const overview = build({ cohorts: [cohort("unknown", { sessions: 3 })], profileRows });
    assert.equal(overview.versions.main_profile, null, corpus);
    const out = text(overview);
    assert.match(out, /\| Median \$\/cycle \(unknown profile\) \|/);
    assert.match(out, /^\| no version detectable \| 3 \|.* \| — \| — \| — \|$/m);
    assert.ok(out.includes("No version is detectable, so no per-version Median $/cycle or Δ is computed."), corpus);
    assert.doesNotMatch(out, /Every cycle here is under it|Median \$\/cycle is a per-session median|main profile's/, corpus);
  }
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
  assert.match(text(overview), /^\| execution \| \$10\.00 \| 100\.0% \| insufficient data \(n=3→1\) \|$/m);
  assert.match(text(overview), /^- execution: 0\.1\.0 \$1\.00 \(n=3\) · 0\.2\.0 \$2\.00 \(n=1, low n\)$/m);
});

// The per-stage table keeps only the columns that fit a terminal; the per-version medians follow it
// as one bullet per stage. The version-bearing cells render through stageCell alone.
const STAGE_TABLE_HEADER = "| Stage | Total | Share | Trend |";

test("the stage table is four columns wide and each stage's version medians follow it as one bullet", () => {
  const stageWindow = [
    { stage: "execution", total: 50 }, { stage: "planning", total: 30 }, { stage: "review", total: 10 },
    // Two stages past the shown ones, so the table ends in a remaining row.
    ...Array.from({ length: OVERVIEW_STAGES - 3 + 2 }, (_, i) => ({ stage: `tail${i}`, total: 1 })),
  ];
  const overview = build({
    cohorts: [cohort("0.1.0"), cohort("0.2.0"), cohort("0.3.0")],
    stageWindow,
    stageByVersion: {
      versions: ["0.1.0", "0.2.0", "0.3.0"], excludedVersions: [],
      rows: [
        // Cells for the first and last shown version only; the middle one is skipped, in order.
        stageRow("execution", { "0.1.0": cell(1, 4), "0.3.0": cell(3, 2) }, "insufficient data (n=4→2)"),
        stageRow("planning", {}, null),
      ],
    },
  });
  const lines = renderOverview(overview);
  const header = lines.indexOf(STAGE_TABLE_HEADER);
  // Vacuity guards: the layout under test is on the page, and the corpus has both a remaining row
  // and a stage with a cell, or the checks below pass on an empty list.
  assert.ok(header !== -1, `no four-column stage table header in:\n${lines.join("\n")}`);
  assert.ok(overview.stages.remaining, "the corpus has no remaining row");
  assert.ok(overview.stages.rows.some((r) => r.cells.some((c) => c !== null)), "no stage has a version cell");

  const tableEnd = lines.findIndex((l, i) => i > header && !l.startsWith("|"));
  const tableRows = lines.slice(header + 2, tableEnd);
  assert.ok(tableRows.every((l) => l.split(" | ").length === 4), `a stage row is wider than four columns:\n${tableRows.join("\n")}`);
  assert.ok(!lines.slice(header, tableEnd).join("\n").includes("$1.00 (n=4)"), "a version cell is still in the table");

  assert.equal(lines[tableEnd + 1], "**Per stage, by version**");
  const legend = lines[tableEnd + 3];
  assert.match(legend, /^_.*per-session medians.*n = sessions with that stage.*`—`/);
  const bullets = lines.slice(tableEnd + 5, tableEnd + 5 + overview.stages.rows.length);
  assert.deepEqual(bullets, [
    "- execution: 0.1.0 $1.00 (n=4) · 0.3.0 $3.00 (n=2, low n)",
    "- planning: —",
    "- review: —",
    ...Array.from({ length: OVERVIEW_STAGES - 3 }, (_, i) => `- tail${i}: —`),
  ]);
  assert.equal(overview.stages.rows.length, OVERVIEW_STAGES);
  // The remaining row has a table row and no bullet.
  assert.ok(tableRows.some((l) => l.startsWith("| remaining ")));
  assert.ok(!lines.some((l) => l.startsWith("- remaining")));
  // The bullets sit between the table and the notes: the first note follows the last bullet.
  const afterBullets = lines.slice(tableEnd + 5 + bullets.length);
  assert.equal(afterBullets[0], "");
  assert.match(afterBullets[1], /^_Total and Share are over the settled sessions' spend/);
  assert.ok(lines.findIndex((l) => l.startsWith("- Dearest stage")) > lines.lastIndexOf(bullets.at(-1)), "the summary bullets do not follow the stage bullets");
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

// Medians over a base of 100 put each move exactly on the 5% flat band, with no rounding either side.
test("the flat band is inclusive: a net rise of exactly 5% is flat, and a dip of exactly 5% does not break a run", () => {
  const rising = (cells) => buildOverview(risingInput(cells)).stages.notes.risingStages;
  assert.equal(BANDS.flatBandPct, 5, "the fixture's band moved, so these medians no longer sit on it");
  assert.deepEqual(rising({ "0.1.0": cell(100), "0.2.0": cell(102), "0.3.0": cell(106) }), ["execution"], "the control: 6% rises");
  assert.deepEqual(rising({ "0.1.0": cell(100), "0.2.0": cell(102), "0.3.0": cell(105) }), []);
  assert.deepEqual(rising({ "0.1.0": cell(100), "0.2.0": cell(94), "0.3.0": cell(200) }), [], "the control: a 6% dip breaks the run");
  assert.deepEqual(rising({ "0.1.0": cell(100), "0.2.0": cell(95), "0.3.0": cell(200) }), ["execution"]);
});

// The thin-middle-cell assertion above also trips the adjacent-dip rule (50 then 3), so it would
// stay empty with the n>=3 gate deleted. These cells climb with no dip, so only the gate holds
// the thin one out: remove it and each of the thin series below reads as steadily rising.
test("a cell below n=3 anchors no trend: the gate, not the dip rule, keeps a thin cell out of a rising series", () => {
  const rising = (cells) => buildOverview(risingInput(cells)).stages.notes.risingStages;
  // The control: the same climb with every cell at n=3, the smallest n the gate admits, rises.
  assert.deepEqual(rising({ "0.1.0": cell(1, 3), "0.2.0": cell(2, 3), "0.3.0": cell(3, 3) }), ["execution"]);
  // One cell short of n=3 leaves two reliable cells, in any position.
  assert.deepEqual(rising({ "0.1.0": cell(1, 3), "0.2.0": cell(2, 2), "0.3.0": cell(3, 3) }), []);
  assert.deepEqual(rising({ "0.1.0": cell(1, 2), "0.2.0": cell(2, 3), "0.3.0": cell(3, 3) }), []);
  assert.deepEqual(rising({ "0.1.0": cell(1, 3), "0.2.0": cell(2, 3), "0.3.0": cell(3, 2) }), []);
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

test("a version-wide spike needs a rise strictly past the spike band and a share of at least two thirds", () => {
  const spikes = (pairs) => buildOverview(spikeInput(pairs)).stages.notes.spikes;
  // Over a base of 100 the band is an exact median, so a rise lands on it with no rounding.
  const onBand = 100 + SPIKE_BAND_PCT;
  assert.deepEqual(spikes([["a", 100, onBand + 1], ["b", 100, onBand + 1], ["c", 100, onBand + 1]]), [
    { version: "0.2.0", comparable: 3, rose: 3 },
  ], "the control: one past the band spikes");
  assert.deepEqual(spikes([["a", 100, onBand], ["b", 100, onBand], ["c", 100, onBand]]), []);
  // Two of four is a half, short of two thirds; three of four is past it.
  assert.deepEqual(spikes([["a", 10, 20], ["b", 10, 20], ["c", 10, 20], ["d", 10, 10]]), [
    { version: "0.2.0", comparable: 4, rose: 3 },
  ], "the control: three of four comparable stages spike");
  assert.deepEqual(spikes([["a", 10, 20], ["b", 10, 20], ["c", 10, 10], ["d", 10, 10]]), []);
});

test("a thin cell on either side makes a stage not comparable, and an unpriced version is skipped at either end", () => {
  const spikesWith = ({ nBefore = 3, nNow = 3 } = {}) => buildOverview(input({
    cohorts: [cohort("0.1.0"), cohort("0.2.0")],
    stageWindow: ["a", "b", "c"].map((stage) => ({ stage, total: 10 })),
    stageByVersion: {
      versions: ["0.1.0", "0.2.0"], excludedVersions: [],
      rows: [
        stageRow("a", { "0.1.0": cell(10), "0.2.0": cell(20) }),
        stageRow("b", { "0.1.0": cell(10), "0.2.0": cell(20) }),
        stageRow("c", { "0.1.0": cell(10, nBefore), "0.2.0": cell(20, nNow) }),
      ],
    },
  })).stages.notes.spikes;
  assert.equal(spikesWith().length, 1, "the control: with a reliable third cell the version spikes");
  assert.deepEqual(spikesWith({ nBefore: 2 }), []);
  assert.deepEqual(spikesWith({ nNow: 2 }), []);
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

test("the four stage notes are consecutive lines in a fixed order", () => {
  const lines = renderOverview(build({ cohorts: [cohort("0.1.0")], stageWindow: [{ stage: "execution", total: 10 }] }));
  const at = lines.findIndex((l) => l.startsWith("- Dearest stage:"));
  assert.ok(at !== -1, "the overview printed no Dearest stage note");
  assert.deepEqual(lines.slice(at, at + 4).map((l) => l.slice(2, l.indexOf(":"))), [
    "Dearest stage", "Steadily rising", "Version-wide spike", "Inferred or unknown stage",
  ]);
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

// The module's code with its comments removed: a comment may name the very things the code must not
// use. Only the module's own comment style is dropped, whole-line `//` comments and `/* */` blocks
// that open a line, so a `//` or `/*` inside a string can never swallow the code after it.
const codeOf = (source) => source.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, "").replace(/^[ \t]*\/\/.*$/gm, "");
const IMPURE = /\b(Date|process|readFileSync|Math\.random)\b/;

test("doctor-overview imports only doctor-format and reads no file, clock or environment", () => {
  const source = readFileSync(new URL("../../scripts/doctor-overview.mjs", import.meta.url), "utf8");
  const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(imports, ["./doctor-format.mjs"]);
  // The stripping keeps code and drops only comments, or the check below would pass vacuously.
  assert.match(codeOf("// a process step\n/* a Date */ const at = Date.now();"), IMPURE);
  assert.doesNotMatch(codeOf("// one process step over the rows\n/* no Date here */\nconst x = 1;"), IMPURE);
  // A `//` or `/*` inside a string is not a comment, so the clock call after it stays in the code.
  assert.match(codeOf("const note = (t) => [\"\", `_${t} // see below_`, String(Date.now())];"), IMPURE);
  assert.match(codeOf("const glob = \"dir/*\"; const at = process.env.X; const end = \"*/\";"), IMPURE);
  assert.doesNotMatch(codeOf("  // stamps nothing with Date.now()\nconst x = 1;"), IMPURE);
  assert.ok(codeOf(source).includes("export function buildOverview("), "stripping comments removed code");
  assert.doesNotMatch(codeOf(source), IMPURE);
  assert.ok(!source.startsWith("#!"));
});
