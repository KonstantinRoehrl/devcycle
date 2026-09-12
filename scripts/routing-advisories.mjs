// The pure half of the routing advisory: it takes priced dispatch rows and the run journal and
// returns cells, comparisons, verdicts and exclusion counts. It reads no files and spawns nothing,
// matching scripts/impact-ledger.mjs's contract, which is what makes it testable from fixtures.
//
// The quantity every verdict trades in is cost per ACCEPTED task: price and quality combined into
// one measured figure, in dollars, with no free parameter. A cell is compared against its class's
// cheapest cell by mean cost per dispatch, by resampling whole dispatches -- which carries
// uncertainty in cost and in acceptance together, with no distributional assumption.

// A cell must be attributable on every axis at once. Each guard below is also an exclusion the
// artifact names, because a silently dropped record reads as a complete picture.
const EXCLUSION_KEYS = [
  "unparseableTask", "unknownRequestKind", "missingTranscript",
  "unpricedModel", "multiModel", "noVerdict", "noPricedTurns",
];

// Plain code-unit comparison, never a locale-aware collation -- the two call sites below (the
// tie ladder's last-resort rung and the canonical cells sort) exist only for determinism, and
// `localeCompare` ties that determinism to the runtime's collation locale for no benefit. It also
// returns 0 for strings a collation treats as equivalent, which would leave a caller's `<= 0`
// deciding by argument order instead.
function compareCodeUnits(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

// The ladder that decides which of two cells tied on meanUSD is the class's baseline. Real signal
// first, arbitrary determinism last. The canonical (requestKind, model) sort below already fixes
// each cell's position in `cells`, so this rung never needs array position to begin with -- it
// decides from the cells' own fields, keeping `cheapest` independent of how `own` was assembled:
//   1. lower cost per ACCEPTED task -- the quantity every verdict actually trades in -- breaks most
//      ties for real. `costPerAccepted` is null when a cell accepted nothing; a null must never
//      look cheaper than a real number, or a cell that shipped nothing would read as the bargain.
//   2. more dispatches -- a larger sample is the more trustworthy one.
//   3. only when two cells are identical on every metric above does this fall back to the
//      lexicographically lower model id -- a bare alphabetical compare. It is not principled, but
//      it is reached only once nothing meaningful is left to decide, and its only job is
//      determinism. No fixture in this module's tests reaches a genuine triple tie, and that is
//      not a coverage gap to close with one: `own`'s reduce (below) is fed by `cells`, which the
//      (requestKind, model) sort at its own definition already orders, so the accumulator always
//      already holds the lexicographically lower model id by the time a triple tie is reached --
//      behaviourally equivalent while that sort stands. This rung is the guard that would matter
//      if that sort were ever removed.
function cheaperOfTie(a, b) {
  const capA = a.costPerAccepted, capB = b.costPerAccepted;
  if (capA !== capB) {
    if (capA == null) return b;
    if (capB == null) return a;
    return capA < capB ? a : b;
  }
  if (a.dispatches !== b.dispatches) return a.dispatches > b.dispatches ? a : b;
  return compareCodeUnits(a.model, b.model) <= 0 ? a : b;
}

// Deterministic PRNG (mulberry32). The bootstrap must be reproducible: the same corpus yields the
// same interval on every run, and the tests are not flaky.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Dollars per accepted task over a sample. A sample that accepted nothing has no cost per accepted
// task -- that is unmeasurable, never 0, and never a hedge.
export function costPerAccepted(rows) {
  let accepted = 0, usd = 0;
  for (const r of rows) { usd += r.usd; if (r.accepted) accepted += 1; }
  return accepted === 0 ? null : usd / accepted;
}

function resample(rows, rng) {
  const out = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) out[i] = rows[Math.floor(rng() * rows.length)];
  return out;
}

// Oriented `compared / cheapest`, so a value above 1.0 means the compared cell costs more per
// accepted task. Returns null when no resample produced an accepted task in both cells -- there is
// no interval to report, and inventing one would be the hedge this design refuses.
function bootstrapRatio(compared, cheapest, { resamples, confidence, rng }) {
  const ratios = [];
  for (let i = 0; i < resamples; i++) {
    const a = costPerAccepted(resample(compared, rng));
    const b = costPerAccepted(resample(cheapest, rng));
    if (a == null || b == null) continue;
    ratios.push(a / b);
  }
  if (!ratios.length) return null;
  ratios.sort((x, y) => x - y);
  const alpha = (1 - confidence) / 2;
  const at = (p) => ratios[Math.min(ratios.length - 1, Math.floor(p * ratios.length))];
  return { median: at(0.5), low: at(alpha), high: at(1 - alpha), draws: ratios.length };
}

function verdictFor(interval) {
  if (!interval) return "unresolved";
  if (interval.low > 1) return "premium-not-justified";
  if (interval.high < 1) return "premium-justified";
  return "unresolved";
}

export function routingAdvisories({ dispatches, runRecords, confidence, resamples, seed = 20260912 }) {
  const exclusions = Object.fromEntries(EXCLUSION_KEYS.map((k) => [k, 0]));
  let measuredUSD = null, unmeasurable = 0;
  let withTask = 0, withKind = 0, withVerdict = 0;

  // Rework-free acceptance, per class of task rather than per verdict: references/culprits.json
  // defines first-round-clean-accept as passing "on its first round, with no rework", and a
  // round === 1 verdict is the first REVIEW round, which can follow several dispatch attempts.
  const eligible = [];
  for (const d of dispatches) {
    if (d.usd == null) unmeasurable += 1; else measuredUSD = (measuredUSD ?? 0) + d.usd;

    const record = runRecords.get(d.sessionHash) ?? null;
    const requestKind = record?.triage?.requestKind ?? record?.workload?.requestKind ?? null;
    if (d.taskId != null) withTask += 1;
    if (requestKind) withKind += 1;

    const verdict = record?.verdicts?.find((v) => String(v.taskId) === String(d.taskId) && v.round === 1) ?? null;
    if (verdict) withVerdict += 1;

    // Ordered so each record is charged to exactly one class, most specific first.
    if (d.measurement === "missing-transcript") { exclusions.missingTranscript += 1; continue; }
    if (d.measurement === "no-priced-turns") { exclusions.noPricedTurns += 1; continue; }
    if (d.measurement.startsWith("unpriced-model")) { exclusions.unpricedModel += 1; continue; }
    if (d.measurement === "multi-model") { exclusions.multiModel += 1; continue; }
    // Backstop for any future measurement value this module doesn't yet name explicitly -- every
    // arm above must stay ahead of this one, or its case silently reads as a missing transcript.
    if (d.measurement !== "ok") { exclusions.missingTranscript += 1; continue; }
    if (d.taskId == null) { exclusions.unparseableTask += 1; continue; }
    if (!requestKind) { exclusions.unknownRequestKind += 1; continue; }
    if (!verdict) { exclusions.noVerdict += 1; continue; }

    const attempts = (record.dispatches ?? []).filter((x) => String(x.taskId) === String(d.taskId));
    const reworked = attempts.some((x) => x.retryIndex > 0 || x.outcome === "blocked");
    eligible.push({
      requestKind,
      model: d.models[0],
      usd: d.usd,
      accepted: verdict.blockingCount === 0 && verdict.conformance === "pass" && !reworked,
    });
  }

  const byCell = new Map();
  for (const r of eligible) {
    const key = `${r.requestKind} ${r.model}`;
    if (!byCell.has(key)) byCell.set(key, []);
    byCell.get(key).push(r);
  }
  // Canonical intra-cell row order -- by usd, then accepted -- derived from each row's own content
  // rather than from whichever order `dispatches` happened to join them in. `resample` below draws
  // row *indices* off a seeded stream, so byte-identical rows arriving in a different order would
  // otherwise feed different rows to the same draws and move the reported bootstrap interval (and,
  // in rarer cases, the verdict word riding on it) for facts that did not change. Sorting changes
  // nothing a cell's summary depends on: totalUSD and accepted are order-independent sums/counts.
  // `usd` then `accepted` is a TOTAL order, not just a good-enough one: an eligible row (below)
  // carries no field beyond requestKind/model/usd/accepted, and the first two are already fixed by
  // the cell key, so this pair exhausts everything left to compare -- two rows that tie on both are
  // identical in content and interchangeable. That is what keeps this total: the day a third field
  // lands on an eligible row, this comment is the flag that the pair below needs a third term too.
  for (const rows of byCell.values()) {
    rows.sort((a, b) => a.usd - b.usd || Number(a.accepted) - Number(b.accepted));
  }

  const cells = [...byCell].map(([key, rows]) => {
    const [requestKind, model] = key.split(" ");
    const totalUSD = rows.reduce((n, r) => n + r.usd, 0);
    const accepted = rows.filter((r) => r.accepted).length;
    return {
      requestKind, model, dispatches: rows.length, accepted, totalUSD,
      meanUSD: totalUSD / rows.length,
      costPerAccepted: accepted === 0 ? null : totalUSD / accepted,
    };
  })
    // Canonical listing order -- (requestKind, model) ascending -- so the array itself, and every
    // per-class slice cut from it below, is a total order derived from the cells' own content
    // rather than from whichever order `dispatches` happened to join them in.
    .sort((a, b) => compareCodeUnits(a.requestKind, b.requestKind) || compareCodeUnits(a.model, b.model));

  const rng = mulberry32(seed);
  const classes = [...new Set(cells.map((c) => c.requestKind))].sort().map((requestKind) => {
    const own = cells.filter((c) => c.requestKind === requestKind);
    // The comparator is the class's cheapest cell by MEASURED mean cost per dispatch, not by list
    // price: references/config.md § Model tiers ranks models, but a rank is not a cost per task.
    // An exact meanUSD tie breaks via the cheaperOfTie ladder above -- never toward whichever of
    // `a`/`b` the reduce happened to be holding, which is what let a reordered-but-identical
    // corpus flip which cell counted as cheapest.
    const cheapestCell = own.reduce((a, b) => {
      if (b.meanUSD !== a.meanUSD) return b.meanUSD < a.meanUSD ? b : a;
      return cheaperOfTie(a, b);
    });
    const rowsOf = (c) => byCell.get(`${c.requestKind} ${c.model}`);
    const comparisons = own.map((cell) => {
      // The cheapest cell in a class is its own baseline: there is nothing to compare it against,
      // so it always reports no-comparator, whether or not the class holds other cells.
      if (cell.model === cheapestCell.model) {
        return { model: cell.model, state: "no-comparator", interval: null, cell, comparator: null };
      }
      const interval = bootstrapRatio(rowsOf(cell), rowsOf(cheapestCell), { resamples, confidence, rng });
      return { model: cell.model, state: verdictFor(interval), interval, cell, comparator: cheapestCell };
    });
    return { requestKind, cheapest: cheapestCell.model, comparisons };
  });

  return {
    corpus: {
      joined: dispatches.length, withTask, withKind, withVerdict, measuredUSD, unmeasurable,
    },
    exclusions, cells, classes,
  };
}
