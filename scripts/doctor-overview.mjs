// The per-version and per-stage overview every doctor reply carries, and the trend summary that
// closes it. Pure: it reads the tables doctor.mjs already built — never a file, a clock or the
// environment — and returns one object (buildOverview) plus the markdown lines rendered from it
// (renderOverview, renderTrendSummary), so the markdown report and --json print the same figures.
import {
  usd, markdownTable, deltaText, directionLine, directionPhrase, cohortSessionsText, unpricedMediansNote,
} from "./doctor-format.mjs";

// How many stages get their own row; the long tail folds into one "remaining N stages" row.
export const OVERVIEW_STAGES = 8;

// A version-wide spike: a version in which at least SPIKE_MIN_SHARE of at least SPIKE_MIN_STAGES
// comparable stages rose by more than SPIKE_BAND_PCT against the previous shown version. Chosen
// values, not measurements — tunables.
export const SPIKE_BAND_PCT = 25;
const SPIKE_MIN_STAGES = 3;
const SPIKE_MIN_SHARE = 2 / 3;

// A stage is steadily rising only on a series of at least this many reliable cells.
const RISING_MIN_CELLS = 3;

const MAX_RISING_LISTED = 3;
const MAX_SPIKES_LISTED = 2;

const byName = (a, b) => String(a).localeCompare(String(b));
const sumOf = (list, pick) => list.reduce((n, item) => n + pick(item), 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const percent = (v) => `${v.toFixed(1)}%`;

// The profile whose cycles the per-version $/cycle and Δ come from: the one with the most cycles
// across the shown versions, ties by name. "unknown" is the profile of a session with no run
// record, so it wins only when nothing else exists.
function profileSplit(profileRows, shownVersions) {
  const cycles = new Map();
  const sessions = new Map();
  for (const r of profileRows) {
    if (!shownVersions.includes(r.version)) continue;
    cycles.set(r.profile, (cycles.get(r.profile) ?? 0) + r.cycles);
    sessions.set(r.profile, (sessions.get(r.profile) ?? 0) + r.sessions);
  }
  const names = [...cycles.keys()];
  const named = names.filter((p) => p !== "unknown");
  const main = (named.length ? named : names)
    .sort((a, b) => cycles.get(b) - cycles.get(a) || byName(a, b))[0] ?? null;
  const others = names.filter((p) => p !== main).sort(byName)
    .map((profile) => ({ profile, cycles: cycles.get(profile), sessions: sessions.get(profile) }));
  return { main, others };
}

function versionRow(cohort, mainRow, minCohort) {
  const unpriced = (cohort.excluded ?? 0) > 0;
  return {
    version: cohort.version,
    sessions: cohort.sessions,
    sessionsLowConfidence: cohort.sessions < minCohort,
    total: cohort.total,
    medianPerSession: cohort.medianPerSession,
    unpriced,
    fullyUnpriced: unpriced && cohort.total === 0,
    medianPerCycle: mainRow?.medianCostPerCycle ?? null,
    cycleSessions: mainRow?.sessions ?? null,
    cycleLowConfidence: mainRow?.lowConfidence ?? false,
    cycleUnpriced: (mainRow?.excluded ?? 0) > 0,
    delta: mainRow?.delta ?? null,
    // Unpriced requests that all sit outside the main profile withhold no main-profile Δ to or from
    // this version, whatever its own Δ reads: the next version's Δ against it is still compared.
    viaOtherProfile: unpriced && Boolean(mainRow) && !((mainRow.excluded ?? 0) > 0),
    quality: cohort.quality ?? null,
  };
}

// The dearest version by total, over every known version (shown or older). A different version
// with the highest median $/session, over the same versions, is carried alongside so neither
// reading is lost, with the ⚠ and low-confidence marks its own table cells would carry.
function dearestOf(known, minCohort) {
  if (!known.length) return null;
  const byTotal = known.reduce((best, c) => (c.total >= best.total ? c : best));
  const byMedian = known.reduce((best, c) => (c.medianPerSession >= best.medianPerSession ? c : best));
  return {
    version: byTotal.version,
    total: byTotal.total,
    unpriced: (byTotal.excluded ?? 0) > 0,
    medianLeader: byMedian.version !== byTotal.version
      ? {
          version: byMedian.version,
          medianPerSession: byMedian.medianPerSession,
          unpriced: (byMedian.excluded ?? 0) > 0,
          sessions: byMedian.sessions,
          sessionsLowConfidence: byMedian.sessions < minCohort,
        }
      : null,
  };
}

// Rising on the report's own trend, with at least RISING_MIN_CELLS reliable cells (n at or above
// the trend gate), a net rise across them past the flat band, and no adjacent pair of them falling
// by more than that band. Cells of a version whose median leaves out unpriced requests are skipped:
// they can manufacture a rise — which is why the net rise is judged again on what is left, since the
// report's trend was computed with them in.
function isSteadilyRising(stageRow, versions, skipped, bands) {
  if (stageRow.trend !== "up") return false;
  const series = versions
    .filter((v) => !skipped.has(v))
    .map((v) => stageRow.byVersion[v])
    .filter((c) => c && c.n >= bands.minTrendN);
  if (series.length < RISING_MIN_CELLS) return false;
  const first = series[0].median;
  if (!(first > 0) || ((series.at(-1).median - first) / first) * 100 <= bands.flatBandPct) return false;
  for (let i = 1; i < series.length; i++) {
    const before = series[i - 1].median;
    if (before > 0 && ((series[i].median - before) / before) * 100 < -bands.flatBandPct) return false;
  }
  return true;
}

// Versions, newest first, in which most comparable stages rose together. A stage is comparable
// when both the version and the one before it carry a reliable cell for it; a comparison that
// touches a skipped (unpriced-distorted) version at either end is not taken.
function versionSpikes(stageRows, versions, skipped, bands) {
  const spikes = [];
  for (let i = versions.length - 1; i >= 1; i--) {
    const version = versions[i];
    const previous = versions[i - 1];
    if (skipped.has(version) || skipped.has(previous)) continue;
    let comparable = 0;
    let rose = 0;
    for (const row of stageRows) {
      const now = row.byVersion[version];
      const before = row.byVersion[previous];
      if (!now || !before || now.n < bands.minTrendN || before.n < bands.minTrendN || before.median <= 0) continue;
      comparable++;
      if (((now.median - before.median) / before.median) * 100 > SPIKE_BAND_PCT) rose++;
    }
    if (comparable >= SPIKE_MIN_STAGES && rose / comparable >= SPIKE_MIN_SHARE)
      spikes.push({ version, comparable, rose });
  }
  return spikes;
}

export function buildOverview(input) {
  const { scope, cohorts, profileRows, stageByVersion, stageWindow, direction, shares, inFlight, bands } = input;
  const shownVersions = stageByVersion.versions;
  const settledTotal = sumOf(stageWindow, (r) => r.total);
  const sharePct = (dollars) => (settledTotal === 0 ? 0 : (dollars / settledTotal) * 100);

  const known = cohorts.filter((c) => c.version !== "unknown");
  const shown = known.filter((c) => shownVersions.includes(c.version));
  const older = known.filter((c) => !shownVersions.includes(c.version));
  const unknownCohort = cohorts.find((c) => c.version === "unknown") ?? null;
  const { main, others } = profileSplit(profileRows, shownVersions);
  const rows = shown.map((c) =>
    versionRow(c, profileRows.find((r) => r.version === c.version && r.profile === main), bands.minCohort));
  const folded = older.length
    ? {
        count: older.length,
        sessions: sumOf(older, (c) => c.sessions),
        total: sumOf(older, (c) => c.total),
        unpriced: older.some((c) => (c.excluded ?? 0) > 0),
      }
    : null;
  const unknown = unknownCohort
    ? {
        sessions: unknownCohort.sessions,
        sessionsLowConfidence: unknownCohort.sessions < bands.minCohort,
        total: unknownCohort.total,
        medianPerSession: unknownCohort.medianPerSession,
        unpriced: (unknownCohort.excluded ?? 0) > 0,
        fullyUnpriced: (unknownCohort.excluded ?? 0) > 0 && unknownCohort.total === 0,
        quality: unknownCohort.quality ?? null,
      }
    : null;

  // Each window row beside the trend row of the same stage, which stageByVersionTable omits for a
  // stage with no spend in a shown version.
  const joined = stageWindow.map((w) => ({ window: w, trendRow: stageByVersion.rows.find((r) => r.stage === w.stage) ?? null }));
  const rendered = joined.slice(0, OVERVIEW_STAGES).map(({ window, trendRow }) => ({
    stage: window.stage,
    total: window.total,
    sharePct: sharePct(window.total),
    cells: shownVersions.map((v) => {
      const cell = trendRow?.byVersion[v] ?? null;
      return cell ? { median: cell.median, n: cell.n, lowN: cell.n < bands.minTrendN } : null;
    }),
    trend: trendRow?.trend ?? null,
  }));
  const rest = stageWindow.slice(OVERVIEW_STAGES);
  const remaining = rest.length
    ? { count: rest.length, total: sumOf(rest, (r) => r.total), sharePct: sharePct(sumOf(rest, (r) => r.total)) }
    : null;

  const skipped = new Set(stageByVersion.excludedVersions);
  const withTrend = joined.filter((s) => s.trendRow).map((s) => s.trendRow);
  const top = stageWindow[0] ?? null;
  const notes = {
    dearest: top ? { stage: top.stage, total: top.total, sharePct: sharePct(top.total) } : null,
    risingStages: withTrend.filter((r) => isSteadilyRising(r, shownVersions, skipped, bands)).map((r) => r.stage),
    spikes: versionSpikes(withTrend, shownVersions, skipped, bands),
    skippedVersions: [...skipped],
    inferredUnknown: {
      dollars: shares.inferredUnknownDollars,
      sharePct: sharePct(shares.inferredUnknownDollars),
    },
  };

  const lowNCells =
    rows.filter((r) => r.sessionsLowConfidence).length +
    rows.filter((r) => r.cycleLowConfidence && r.medianPerCycle !== null && !(r.cycleUnpriced && r.medianPerCycle === 0)).length +
    (unknown?.sessionsLowConfidence ? 1 : 0) +
    sumOf(rendered, (r) => r.cells.filter((c) => c?.lowN).length);

  return {
    scope,
    bands,
    reconciliation: {
      settledTotal,
      inFlightSessions: inFlight.sessions,
      inFlightDollars: inFlight.dollars,
    },
    versions: {
      main_profile: main,
      other_profiles: others,
      rows,
      folded,
      unknown,
      direction,
      dearest: dearestOf(known, bands.minCohort),
      sidelinedDollars: (unknown?.total ?? 0) + (folded?.total ?? 0),
    },
    stages: { versions: shownVersions, rows: rendered, remaining, notes },
    summary: {
      trust: {
        withheldVersions: rows.filter((r) => r.delta?.reason === "unpriced").map((r) => r.version),
        lowNCells,
        inferredUnknownSharePct: notes.inferredUnknown.dollars > 0 ? notes.inferredUnknown.sharePct : null,
        directionUndetermined: direction.direction === "insufficient-data",
      },
    },
  };
}

// A ⚠ after a figure, or before a label (`before`), for a version with requests left out as unpriced.
const flagged = (text, unpriced, before = false) => (unpriced ? (before ? `⚠ ${text}` : `${text} ⚠`) : text);
const moneyCell = (value, row) => (row.fullyUnpriced ? "⚠ unpriced" : flagged(usd(value), row.unpriced));
// The table's compact Sessions cell: the floor is stated once, in the legend, so a row that is both
// below it and has a withheld Δ still fits the terminal. The prose line keeps the full wording.
const sessionsCell = (sessions, low) => `${sessions}${low ? " (low n)" : ""}`;
// Bare figures: the units are named once, in the legend under the per-version table.
const qualityCell = (q) => (q ? `${q.roundsPerTask.toFixed(1)} · ${q.retries}/${q.tasks}` : null);
const stageCell = (c) => (c ? `${usd(c.median)} (n=${c.n}${c.lowN ? ", low n" : ""})` : null);

function cycleCell(row) {
  if (row.medianPerCycle === null) return null;
  if (row.cycleUnpriced && row.medianPerCycle === 0) return "⚠ unpriced";
  return `${usd(row.medianPerCycle)}${row.cycleLowConfidence ? ` (n=${row.cycleSessions})` : ""}`;
}

function listWithMore(items, max) {
  if (!items.length) return "none";
  const shown = items.slice(0, max).join(", ");
  return items.length > max ? `${shown} (+${items.length - max} more)` : shown;
}

// A footnote under a table: its own italic paragraph, because adjacent italic lines would run
// together into one paragraph when the markdown is rendered.
const note = (text) => ["", `_${text}_`];

const spikeText = (s) => `${s.version} (${s.rose} of ${s.comparable} comparable stages rose >${SPIKE_BAND_PCT}%)`;

export function renderOverview(overview) {
  const { versions, stages, reconciliation } = overview;
  const { minCohort } = overview.bands;
  const { settledTotal, inFlightSessions, inFlightDollars } = reconciliation;
  // No main profile at all means no version is detectable, so there is nothing to take cycles from;
  // its header reads as the unknown profile, like a corpus whose every cycle is under it.
  const noVersion = versions.main_profile === null;
  const unknownOnly = noVersion || versions.main_profile === "unknown";
  const mainLabel = unknownOnly ? "Median $/cycle (unknown)" : `Median $/cycle (${versions.main_profile})`;
  const L = [...(overview.scope ? [`Scope: ${overview.scope} · settled sessions only`, ""] : []), "**Per version**", ""];

  const versionRows = [
    ...versions.rows.map((r) => [
      r.unpriced ? `⚠ ${r.version}` : r.version,
      sessionsCell(r.sessions, r.sessionsLowConfidence),
      moneyCell(r.total, r),
      moneyCell(r.medianPerSession, r),
      cycleCell(r),
      r.delta ? deltaText(r.delta) : null,
      qualityCell(r.quality),
    ]),
    ...(versions.folded
      ? [[
          flagged(`${plural(versions.folded.count, "older version")}`, versions.folded.unpriced, true),
          versions.folded.sessions, flagged(usd(versions.folded.total), versions.folded.unpriced),
          null, null, null, null,
        ]]
      : []),
    ...(versions.unknown
      ? [[
          flagged("no version detectable", versions.unknown.unpriced, true),
          sessionsCell(versions.unknown.sessions, versions.unknown.sessionsLowConfidence),
          moneyCell(versions.unknown.total, versions.unknown),
          moneyCell(versions.unknown.medianPerSession, versions.unknown),
          null, null, qualityCell(versions.unknown.quality),
        ]]
      : []),
  ];
  L.push(...markdownTable(
    ["Version", "Sessions", "Total", "Median $/session", mainLabel, "Δ vs previous", "Quality"],
    versionRows,
    "no settled sessions in this corpus",
  ));
  L.push(...note(
    `Quality is review rounds per task · retries/tasks. A Sessions cell marked low n has fewer than ${minCohort} sessions.`,
  ));
  L.push("", directionLine(versions.direction));
  if (versions.dearest) {
    const d = versions.dearest;
    const m = d.medianLeader;
    L.push(
      "",
      `Dearest version: ${d.version} (${usd(d.total)}${d.unpriced ? " ⚠" : ""})` +
        (m
          ? `; highest median $/session: ${m.version} (${flagged(usd(m.medianPerSession), m.unpriced)}` +
            `${m.sessionsLowConfidence ? `, sessions: ${cohortSessionsText({ sessions: m.sessions, lowConfidence: true }, minCohort)}` : ""})`
          : ""),
    );
  }
  L.push(...note(
    `Total sums to ${usd(settledTotal)}, the settled sessions' spend.` +
      (inFlightSessions > 0
        ? ` ${plural(inFlightSessions, "in-flight session")} (${usd(inFlightDollars)}) ${inFlightSessions === 1 ? "is" : "are"} not in these tables; the full report's window table still counts ${inFlightSessions === 1 ? "it" : "them"}.`
        : ""),
  ));
  const unknownProfile =
    "Profile `unknown` is either a session with no run record (which forms a one-session cycle, " +
    "so its $/cycle is really per-session) or a run record that names no profile.";
  L.push(...note(
    noVersion
      ? `No version is detectable, so no per-version Median $/cycle or Δ is computed. ${unknownProfile}`
      : unknownOnly
      ? `${unknownProfile} Every cycle here is under it, so Median $/cycle is a per-session median.`
      : `Sessions, Total, Median $/session and Quality cover every profile; Median $/cycle and Δ are the ${versions.main_profile} profile's.` +
        (versions.other_profiles.length
          ? ` Other profiles: ${versions.other_profiles.map((p) => `${p.profile} (${plural(p.cycles, "cycle")}, ${plural(p.sessions, "session")})`).join(", ")}.`
          : "") +
        ` ${unknownProfile}`,
  ));
  if (
    versions.rows.some((r) => r.unpriced || r.delta?.reason === "unpriced") ||
    versions.folded?.unpriced || versions.unknown?.unpriced
  )
    L.push(...note("⚠ marks a version with requests on a model with no exact price: they are left out of its dollar figures, and any Δ that compares a profile row holding them is withheld."));
  const other = versions.rows.filter((r) => r.viaOtherProfile).map((r) => r.version);
  if (other.length)
    L.push(...note(`⚠ via another profile: ${other.join(", ")} — the unpriced requests sit outside the ${versions.main_profile} profile, so they withhold no ${versions.main_profile}-profile Δ to or from ${other.length === 1 ? "it" : "any of them"}.`));
  L.push(...note("Δ is profile-matched, not workload-adjusted: direction, not verdict."));

  L.push("", "**Per stage**", "");
  const stageRows = [
    ...stages.rows.map((r) => [r.stage, usd(r.total), percent(r.sharePct), r.trend]),
    ...(stages.remaining
      ? [[`remaining ${plural(stages.remaining.count, "stage")}`, usd(stages.remaining.total), percent(stages.remaining.sharePct), null]]
      : []),
  ];
  L.push(...markdownTable(["Stage", "Total", "Share", "Trend"], stageRows, "no stage cost recorded among settled sessions"));
  // The per-version medians sit beneath the table, one bullet per stage, so the table stays narrow
  // enough to render in a terminal.
  if (stages.rows.length)
    L.push(
      "", "**Per stage, by version**",
      ...note("Version cells are per-session medians (n = sessions with that stage). A stage with no version cell has no per-version data: `—`, never `insufficient data`."),
      "",
      ...stages.rows.map((r) => {
        const byVersion = stages.versions.flatMap((v, i) => (r.cells[i] ? [`${v} ${stageCell(r.cells[i])}`] : []));
        return `- ${r.stage}: ${byVersion.length ? byVersion.join(" · ") : "—"}`;
      }),
    );
  L.push(...note("Total and Share are over the settled sessions' spend."));
  if (versions.sidelinedDollars > 0)
    L.push(...note(`${usd(versions.sidelinedDollars)} (${percent(settledTotal === 0 ? 0 : (versions.sidelinedDollars / settledTotal) * 100)} of settled spend) sits in sessions with no detectable version or in versions older than the columns shown: it is in Total and Share but in no version column.`));
  if (stages.notes.skippedVersions.length) L.push("", unpricedMediansNote(stages.notes.skippedVersions));

  const n = stages.notes;
  const skipNotice = n.skippedVersions.length ? ` (skips ⚠ version(s): ${n.skippedVersions.join(", ")})` : "";
  L.push(
    "",
    `- Dearest stage: ${n.dearest ? `${n.dearest.stage} (${usd(n.dearest.total)}, ${percent(n.dearest.sharePct)} of settled spend)` : "none recorded"}`,
    `- Steadily rising: ${listWithMore(n.risingStages, MAX_RISING_LISTED)}${skipNotice}`,
    `- Version-wide spike: ${listWithMore(n.spikes.map(spikeText), MAX_SPIKES_LISTED)}${skipNotice}`,
    `- Inferred or unknown stage: ${usd(n.inferredUnknown.dollars)} (${percent(n.inferredUnknown.sharePct)} of settled spend)`,
  );
  return L;
}

export function renderTrendSummary(overview) {
  const { versions, stages, summary } = overview;
  const { dearest } = versions;
  const n = stages.notes;
  const cost = `- Cost: direction ${directionPhrase(versions.direction)}` +
    (dearest ? `; dearest version ${dearest.version} (${usd(dearest.total)}${dearest.unpriced ? " ⚠" : ""})` : "");
  const stageLine = `- Stages: dearest ${n.dearest ? `${n.dearest.stage} (${percent(n.dearest.sharePct)})` : "none"}; ` +
    `rising: ${listWithMore(n.risingStages, MAX_RISING_LISTED)}; ` +
    `version-wide spike: ${listWithMore(n.spikes.map((s) => s.version), MAX_SPIKES_LISTED)}`;
  const t = summary.trust;
  const caveats = [
    t.withheldVersions.length ? `⚠ Δ withheld for ${t.withheldVersions.join(", ")}` : null,
    t.lowNCells > 0 ? `${plural(t.lowNCells, "low-n cell")}` : null,
    t.inferredUnknownSharePct !== null ? `${percent(t.inferredUnknownSharePct)} of spend has an inferred or unknown stage` : null,
    t.directionUndetermined ? "direction undetermined" : null,
  ].filter(Boolean);
  return [cost, stageLine, `- Trust: ${caveats.length ? caveats.join(" · ") : "no caveats"}`];
}
