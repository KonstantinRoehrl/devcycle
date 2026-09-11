// The symmetric half of references/impact-scoring.md. That file prices culprit-kind lessons;
// this prices the win side against the same formula so one period can carry a single net figure.
// Pure — handed aggregates and records, returns numbers. It reads no files and spawns nothing;
// scripts/dream.mjs owns every transcript read that produces its input.

// The stage sentinel that can never price. references/impact-scoring.md states that no stage
// window matches it, so a key on it yields null by construction rather than from a gap in the
// data. Such a key is excluded from every total AND from the poison set: poisoning on a value
// that is unmeasurable by definition would render the net unmeasurable in most real periods.
export const UNATTRIBUTED = "unattributed";

const isExcluded = (key) => key.endsWith(`:${UNATTRIBUTED}`);

// Fold doctor's per-session impact rows into one key-addressed aggregate. `measurable` is sticky:
// one unpriced contribution makes the whole key unpriced, because a partial sum reported as a
// total would read as complete when it is not.
export function aggregateKeys(summaries) {
  const byKey = new Map();
  for (const s of summaries ?? [])
    for (const row of s.impact ?? []) {
      const agg = byKey.get(row.key) ?? { impact: 0, frequency: 0, measurable: true };
      agg.frequency += row.frequency;
      if (row.impact === null) agg.measurable = false;
      else agg.impact += row.impact;
      byKey.set(row.key, agg);
    }
  return byKey;
}

// Mean cost of one occurrence of `key` over the baseline window. Null — never 0 — when the window
// priced nothing for it: an unpriced key is unmeasurable, not free.
export function costPerOccurrence(key, baseline) {
  const agg = baseline?.get(key);
  if (!agg || !agg.measurable || agg.frequency === 0) return null;
  return agg.impact / agg.frequency;
}

// Every impact key that counts as a win rather than a cost. `observes` is what makes a win
// countable at all: the journal names win events (first-round-accept) while the vocabulary names
// win slugs (first-round-clean-accept), and nothing else joins the two namespaces.
export function winKeySet(vocab) {
  const keys = new Set();
  for (const e of vocab ?? []) {
    if (e?.kind !== "win") continue;
    keys.add(e.slug);
    keys.add(`novel:${e.slug}`);
    for (const k of e.observes ?? []) keys.add(k);
  }
  return keys;
}

// Culprit-only per-occurrence cost map: non-win (winKeySet), non-`unattributed`, measurable only.
// The severity gate reads exactly these values; an unpriced key is absent, never $0.
export function culpritCostByKey(baseline, vocab) {
  const wins = winKeySet(vocab);
  const out = {};
  for (const key of baseline?.keys() ?? []) {
    if (wins.has(key) || key === "unattributed") continue;
    const cost = costPerOccurrence(key, baseline);
    if (cost != null) out[key] = cost;
  }
  return out;
}

function entryFor(culpritId, vocab) {
  const slug = String(culpritId).split(":").pop();
  return { slug, entry: (vocab ?? []).find((e) => e?.slug === slug) ?? null };
}

export function periodLedger({ period, baseline, promotions, vocab, scoreboard, from, to, sessions,
  baselineFrom, baselineTo, baselineSessions }) {
  const held = new Set((scoreboard ?? []).filter((r) => r.verdict === "held").map((r) => r.culpritId));
  // One row per unique held win culprit-id, not per landing record: a win escalated across rungs
  // writes one promotion record per landing, and pricing per record would double its occurrences and
  // savings. `allTimeRollup` (scripts/learn-report.mjs) dedups the same list by culprit-id for the
  // same reason; the two paths must agree.
  const byId = new Set();
  for (const p of promotions ?? []) {
    if (p.lifecycle || !p.culpritId || !held.has(p.culpritId)) continue;
    byId.add(p.culpritId);
  }
  const rows = [];
  for (const culpritId of byId) {
    const { slug, entry } = entryFor(culpritId, vocab);
    if (entry?.kind !== "win") continue;
    const observed = new Set([slug, `novel:${slug}`, ...(entry.observes ?? [])]);
    let occurrences = 0;
    for (const [key, agg] of period) if (observed.has(key)) occurrences += agg.frequency;
    const prevents = entry.prevents ?? [];
    const prices = prevents.map((k) => costPerOccurrence(k, baseline));
    let savings = null, reason = null;
    if (occurrences === 0) reason = "no occurrences in period";
    else if (prevents.length === 0) reason = "declares no prevents";
    else if (prices.some((c) => c === null)) reason = "a prevented key is unpriced";
    else savings = occurrences * (prices.reduce((a, b) => a + b, 0) / prices.length);
    rows.push({ win: culpritId, occurrences, prevents, savings, reason });
  }

  const winKeys = winKeySet(vocab);
  let cost = 0, costMeasurable = true, excludedEvents = 0;
  const excludedKeys = new Set();
  for (const [key, agg] of period) {
    if (isExcluded(key)) { excludedEvents += agg.frequency; excludedKeys.add(key); continue; }
    if (winKeys.has(key)) continue;
    if (!agg.measurable) { costMeasurable = false; continue; }
    cost += agg.impact;
  }

  const unpriced = rows.filter((r) => r.savings === null).length;
  const measuredSavings = rows.reduce((a, r) => a + (r.savings ?? 0), 0);
  // An empty held-win set is a true 0 (spec §136: Σ over the empty set), not an absence of
  // measurement — so net = 0 − cost. savings stays null ONLY when a held win exists but cannot be
  // priced (unpriced > 0), which is where "unmeasured is never $0" applies.
  const savings = unpriced > 0 ? null : measuredSavings;
  const totalCost = costMeasurable ? cost : null;
  const net = savings === null || totalCost === null ? null : savings - totalCost;

  return {
    from, to, sessions,
    baseline: { from: baselineFrom, to: baselineTo, sessions: baselineSessions },
    rows,
    savings, cost: totalCost, net,
    unpriced,
    measured: { savings: measuredSavings, cost },
    excluded: { events: excludedEvents, keys: [...excludedKeys].sort() },
  };
}
