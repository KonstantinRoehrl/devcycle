// The pure half of the routing advisory: it takes priced dispatch rows and the run journal and
// returns cells, comparisons, verdicts and exclusion counts. It reads no files and spawns nothing,
// matching scripts/impact-ledger.mjs's contract, which is what makes it testable from fixtures.
//
// The quantity every verdict trades in is cost per ACCEPTED task: price and quality combined into
// one measured figure, in dollars, with no free parameter. A cell is compared against its class's
// cheapest cell by mean cost per dispatch -- among the cells holding at least `comparatorFloor`
// dispatches -- by resampling whole dispatches, which carries uncertainty in cost and in
// acceptance together, with no distributional assumption.

// A cell must be attributable on every axis at once. Each guard below is also an exclusion the
// artifact names, because a silently dropped record reads as a complete picture.
const EXCLUSION_KEYS = [
  "unjoinedSession", "unparseableTask", "unknownRequestKind", "missingTranscript",
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
//      not a coverage gap to close with one: the comparator reduce (below) is fed by a filter of
//      `cells`, which the (requestKind, model) sort at its own definition already orders and a
//      filter preserves, so the accumulator always already holds the lexicographically lower model
//      id by the time a triple tie is reached -- behaviourally equivalent while that sort stands.
//      This rung is the guard that would matter if that sort were ever removed.
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
//
// A resample where either cell drew zero accepts has no cost per accepted task, so it is skipped:
// the interval is conditional on both cells accepting, which is not quite the quantity above. The
// skip is directional -- draws where the CHEAPEST cell accepts nothing are the ones arguing hardest
// for premium-justified -- so `discarded` rides with every interval and is rendered beside it,
// which is § 6's every-exclusion-is-counted rule applied to the bootstrap's own exclusions.
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
  return {
    median: at(0.5), low: at(alpha), high: at(1 - alpha),
    draws: ratios.length, discarded: resamples - ratios.length, resamples,
  };
}

// Which way the price runs between a compared cell and its comparator, on the same measured
// mean-cost-per-dispatch ranking that selects the comparator. Before the comparator floor this was
// always "premium": the comparator WAS the class's cheapest cell, so every compared cell was
// pricier or tied. With the floor the comparator is the cheapest ELIGIBLE cell, so a below-floor
// cell can sit below it -- and for that row an interval under 1.0 says the cheap cell won, not that
// a premium paid off. § 5's premium words are reachable only from a genuine premium.
function directionOf(cell, comparator) {
  if (cell.meanUSD > comparator.meanUSD) return "premium";
  return cell.meanUSD < comparator.meanUSD ? "discount" : "same-price";
}

// The criterion is that the interval EXCLUDES 1.0, so a bound sitting exactly on 1.0 has not
// excluded it and stays unresolved. Both comparisons are strict for that reason. Which word the
// exclusion earns depends on the direction above: only a cell that actually pays more per dispatch
// can have that premium called justified or not. A cell that pays the same or less is reported in
// the plain terms of what was measured -- it costs less, or more, per accepted task.
function verdictFor(interval, direction) {
  if (!interval) return "unresolved";
  if (interval.low > 1) return direction === "premium" ? "premium-not-justified" : "costs-more-per-accepted";
  if (interval.high < 1) return direction === "premium" ? "premium-justified" : "costs-less-per-accepted";
  return "unresolved";
}

// The journal is keyed by session; a run is not. `readRunRecords` (scripts/doctor.mjs) windows
// `workload` per session, and a run predating the `triage` row writes its workload line at the
// finish stage -- the last window -- so an implementer dispatched in an earlier window resolves
// `workload: null` on its own session record and loses its class. § 2's join table keys the task
// class, the round-1 verdict and the rework attempts on runId, so this folds the per-session
// records of one run into one scope. It is done here rather than in `readRunRecords` because that
// reader's other consumers (doctor's own per-session summarizers) want the per-session view.
function runScopes(runRecords) {
  const scopeOf = new Map();  // sessionHash -> the scope its run shares
  const byRun = new Map();
  for (const [hash, record] of runRecords) {
    // A record carrying no `run` line has no runId to join on. It stays its own scope rather than
    // pooling with every other runId-less record, which would cross-attribute their classes.
    const key = record.runId ?? `session:${hash}`;
    let scope = byRun.get(key);
    if (!scope) { scope = { requestKind: null, verdicts: [], dispatches: [] }; byRun.set(key, scope); }
    scope.requestKind ??= record.triage?.requestKind ?? record.workload?.requestKind ?? null;
    scope.verdicts.push(...(record.verdicts ?? []));
    scope.dispatches.push(...(record.dispatches ?? []));
    scopeOf.set(hash, scope);
  }
  return scopeOf;
}

// `playbooks/executing-waves.md` writes the dispatched subagent's transcript id in its filename
// form (`agent-<hash>`), which is the form scripts/dispatch-cost.mjs reads off the sidecar too --
// but a turn elsewhere in the journal carries the bare `<hash>`, and compared raw across that
// boundary the join silently never matches. Two absent ids are never a match.
const bareAgentId = (id) => (id == null ? null : String(id).replace(/^agent-/, ""));
function sameAgent(a, b) {
  const x = bareAgentId(a), y = bareAgentId(b);
  return x != null && y != null && x === y;
}

export function routingAdvisories({
  dispatches, runRecords, confidence, resamples, comparatorFloor, seed = 20260912,
}) {
  // The floor is policy (references/reinforcement-policy.md), never a default hidden in this
  // signature: an absent one would silently make every cell ineligible and report a corpus-wide
  // no-comparator that reads like a finding about the data.
  if (!Number.isInteger(comparatorFloor) || comparatorFloor < 1)
    throw new Error(`routingAdvisories: comparatorFloor must be an integer >= 1, got ${JSON.stringify(comparatorFloor)}`);

  const exclusions = Object.fromEntries(EXCLUSION_KEYS.map((k) => [k, 0]));
  let measuredUSD = null, unmeasurable = 0;
  let joined = 0, withTask = 0, withKind = 0, withVerdict = 0;
  let taskFromRecord = 0, taskFromDescription = 0;
  const scopeOf = runScopes(runRecords);

  // Rework-free acceptance, per class of task rather than per verdict: references/culprits.json
  // defines first-round-clean-accept as passing "on its first round, with no rework", and a
  // round === 1 verdict is the first REVIEW round, which can follow several dispatch attempts.
  const eligible = [];
  for (const d of dispatches) {
    // Joined means joined. A transcript whose session appears in no journal line was never joined
    // to a run, so it carries no class, no verdict and no run to attribute its dollars to; counting
    // it as joined and billing it to "unknown requestKind" reported a corpus that never existed.
    const scope = scopeOf.get(d.sessionHash) ?? null;
    if (!scope) { exclusions.unjoinedSession += 1; continue; }
    joined += 1;

    if (d.usd == null) unmeasurable += 1; else measuredUSD = (measuredUSD ?? 0) + d.usd;

    const requestKind = scope.requestKind;
    // § 8: the dispatch record carries the subagent's own transcript id, which is exact. The
    // sidecar description parse stays for runs written before that field existed, and how many
    // dispatches each source attributed is reported rather than assumed.
    const recorded = scope.dispatches.find((x) => sameAgent(x.agentId, d.agentId)) ?? null;
    const taskId = recorded?.taskId ?? d.taskId ?? null;
    if (taskId != null) {
      withTask += 1;
      if (recorded?.taskId != null) taskFromRecord += 1; else taskFromDescription += 1;
    }
    if (requestKind) withKind += 1;

    const verdict = taskId == null ? null
      : scope.verdicts.find((v) => String(v.taskId) === String(taskId) && v.round === 1) ?? null;
    if (verdict) withVerdict += 1;

    // Ordered so each record is charged to exactly one class, most specific first.
    if (d.measurement === "missing-transcript") { exclusions.missingTranscript += 1; continue; }
    if (d.measurement === "no-priced-turns") { exclusions.noPricedTurns += 1; continue; }
    if (d.measurement.startsWith("unpriced-model")) { exclusions.unpricedModel += 1; continue; }
    if (d.measurement === "multi-model") { exclusions.multiModel += 1; continue; }
    // Backstop for any future measurement value this module doesn't yet name explicitly -- every
    // arm above must stay ahead of this one, or its case silently reads as a missing transcript.
    if (d.measurement !== "ok") { exclusions.missingTranscript += 1; continue; }
    if (taskId == null) { exclusions.unparseableTask += 1; continue; }
    if (!requestKind) { exclusions.unknownRequestKind += 1; continue; }
    if (!verdict) { exclusions.noVerdict += 1; continue; }

    const attempts = scope.dispatches.filter((x) => String(x.taskId) === String(taskId));
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
    // § 4.1: only a cell holding at least `comparatorFloor` dispatches may be the comparator. The
    // comparator is picked by a point estimate and only the ratio is bootstrapped, so a two-row
    // comparator's own thinness enters no interval -- its near-constant denominator makes every
    // ratio in the class narrow and far from 1.0. The floor is on eligibility to be the comparator
    // only: a below-floor cell is still compared and still reported, flagged rather than dropped,
    // because there § 4's self-reporting argument does hold.
    const eligibleCells = own.filter((c) => c.dispatches >= comparatorFloor);
    // The comparator is the cheapest ELIGIBLE cell by MEASURED mean cost per dispatch, not by list
    // price: references/config.md § Model tiers ranks models, but a rank is not a cost per task.
    // An exact meanUSD tie breaks via the cheaperOfTie ladder above -- never toward whichever of
    // `a`/`b` the reduce happened to be holding, which is what let a reordered-but-identical
    // corpus flip which cell counted as cheapest.
    const comparator = eligibleCells.length
      ? eligibleCells.reduce((a, b) => {
        if (b.meanUSD !== a.meanUSD) return b.meanUSD < a.meanUSD ? b : a;
        return cheaperOfTie(a, b);
      })
      : null;
    const rowsOf = (c) => byCell.get(`${c.requestKind} ${c.model}`);
    const comparisons = own.map((cell) => {
      // `direction` is null on every arm that reports no ratio: there is no comparison to have a
      // direction. It is set, not omitted, so a consumer never has to tell "absent" from "n/a".
      const base = {
        model: cell.model, cell, direction: null,
        comparatorEligible: cell.dispatches >= comparatorFloor,
      };
      // Two different absences, told apart: § 5's no-comparator is "the class holds one priced
      // cell", and a class whose every cell is below the floor has nothing eligible to compare
      // against either. Both say which one they are.
      if (own.length === 1)
        return { ...base, state: "no-comparator", reason: "single-priced-cell", interval: null, comparator: null };
      if (!comparator)
        return { ...base, state: "no-comparator", reason: "no-cell-meets-floor", interval: null, comparator: null };
      // This row IS the class's baseline -- a different fact from having nothing to compare
      // against, and the one every baseline row used to report as no-comparator.
      if (cell.model === comparator.model)
        return { ...base, state: "baseline", interval: null, comparator: null };
      // A cell that accepted nothing has no cost per accepted task, so no ratio against it exists
      // in either direction. Running the bootstrap anyway returns null for every resample and
      // falls through to "unresolved", which reads as no data for a cell that spent real money and
      // shipped nothing -- the strongest signal in the corpus, rendered as an absence.
      if (cell.accepted === 0 || comparator.accepted === 0) {
        const noAccepts = cell.accepted === 0 && comparator.accepted === 0 ? "both"
          : cell.accepted === 0 ? "compared" : "comparator";
        return { ...base, state: "no-accepts", noAccepts, interval: null, comparator };
      }
      const direction = directionOf(cell, comparator);
      const interval = bootstrapRatio(rowsOf(cell), rowsOf(comparator), { resamples, confidence, rng });
      return { ...base, state: verdictFor(interval, direction), direction, interval, comparator };
    });
    return { requestKind, cheapest: comparator?.model ?? null, comparatorFloor, comparisons };
  });

  return {
    corpus: {
      // Transcripts found is every implementer dispatch the reader walked; joined is the subset
      // whose session the journal knows. Every other count below is over the joined subset.
      transcripts: dispatches.length, joined, withTask, withKind, withVerdict,
      taskFromRecord, taskFromDescription, measuredUSD, unmeasurable,
    },
    exclusions, cells, classes,
  };
}
