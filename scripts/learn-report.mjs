// D9's report, rendered once and used twice: the same function produces the proposal a Confirm
// batch is read against and the outcome written after Land, so the two are diffable by
// construction rather than by discipline. Pure — it is handed data and returns markdown.

import { median } from "./doctor.mjs";

// doctor's median returns 0 for an empty list and does not round. Both matter here and neither
// belongs in a second implementation: a span of zero days is a real measurement, so "nothing
// measured" must stay distinguishable as null, and a fractional day count would render wrong.
const spanMedian = (xs) => (xs.length ? Math.round(median(xs)) : null);

const RUNGS = ["r3", "r2", "r1", "r0"];
const RUNG_LABEL = { r3: "r3 mechanical", r2: "r2 digest line", r1: "r1 always-loaded", r0: "r0 memory" };

const usd = (n) => (typeof n === "number" ? `$${n.toFixed(2)}` : "unmeasurable");
const days = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

export function allTimeRollup(promotions) {
  const byRung = Object.fromEntries(RUNGS.map((r) => [r, { landed: 0, retired: 0, net: 0 }]));
  let unbucketed = 0;
  const sourced = { memory: 0, mining: 0 };
  // A retirement lifecycle record (Phase 4) is a transition out, not a landing: it counts toward
  // its rung's retired total and carries the (at − landed) day-delta this phase can now time. Any
  // other lifecycle record (e.g. a revert) is neither a landing nor a retirement count.
  const retirementDeltas = [];
  for (const p of promotions) {
    if (p.lifecycle === "retirement") {
      if (p.rung && byRung[p.rung]) byRung[p.rung].retired += 1;
      if (p.landed && p.at) retirementDeltas.push(days(p.landed, p.at));
      continue;
    }
    if (p.lifecycle) continue;
    if (p.rung && byRung[p.rung]) byRung[p.rung].landed += 1;
    else unbucketed += 1;
    if (p.sourcedFromMemory === true) sourced.memory += 1;
    else if (p.sourcedFromMemory === false) sourced.mining += 1;
  }
  for (const r of RUNGS) byRung[r].net = byRung[r].landed - byRung[r].retired;

  // An escalation is one culprit-id appearing at r2 and later at r3 — landings only, so a
  // retirement record sharing the id is excluded from the span. Retirement now has its own record
  // kind, so its median is measured from the retirement records' day-deltas rather than held null.
  const byId = new Map();
  for (const p of promotions) {
    if (p.lifecycle || !p.culpritId) continue;
    if (!byId.has(p.culpritId)) byId.set(p.culpritId, []);
    byId.get(p.culpritId).push(p);
  }
  const spans = [];
  for (const records of byId.values()) {
    const from = records.filter((p) => p.rung === "r2").map((p) => p.landed).sort()[0];
    const to = records.filter((p) => p.rung === "r3").map((p) => p.landed).sort().at(-1);
    if (from && to && to > from) spans.push(days(from, to));
  }
  return { byRung, sourced, transitions: { r2r3: spanMedian(spans), r2retired: spanMedian(retirementDeltas) }, unbucketed };
}

function summaryTable(cands, roll) {
  const count = (rung, disposition) =>
    cands.filter((c) => c.rung === rung && c.disposition === disposition).length;
  const rows = RUNGS.map((r) =>
    `| ${RUNG_LABEL[r].padEnd(16)} | ${count(r, "landed")} | ${count(r, "declined")} | ` +
    `${count(r, "deferred")} | ${roll.byRung[r].landed} | ${roll.byRung[r].retired} | ${roll.byRung[r].net} |`,
  );
  return [
    "| Rung             | This run: Landed | Declined | Deferred | All-time: Landed | Retired | Net |",
    "|------------------|-----------------:|---------:|---------:|-----------------:|--------:|----:|",
    ...rows,
  ].join("\n");
}

function landedEntry(c) {
  const trend = c.trend === "recurring" ? `recurring, seen ${c.priorOccurrences} times before` : c.trend;
  return [
    `### ${c.title} — \`${c.culpritId}\``,
    `- Rung: ${c.rung} — why not higher: ${c.whyNotHigher}`,
    `- Location(s): ${c.locations.length ? c.locations.join(", ") : "memory (no file)"}`,
    `- Fault / scope: ${c.fault} · ${c.scope ?? "n/a (pipeline fault never lands locally)"}`,
    `- Impact: ${usd(c.impact)} (${c.occurrences} occurrences) · trend: ${trend}`,
    `- Evidence: ${c.evidenceSessions} sessions`,
    `- Verify: ${c.verify}`,
    `- Sensitive: ${c.sensitive ? "yes" : "no"}`,
    ...(c.legacyDuplicateOf ? [`- Possible duplicate of legacy record: ${c.legacyDuplicateOf} (hint only)`] : []),
  ].join("\n");
}

// The ledger is rendered, never computed: scripts/impact-ledger.mjs owns every figure here and
// this file stays pure. `usd` already prints the literal "unmeasurable" for a non-number, which
// is what keeps a null from ever reaching the page as $0.00.
function ledgerSection(l) {
  const rows = l.rows.length
    ? l.rows.map((r) =>
        `| \`${r.win}\` | ${r.occurrences} | ` +
        `${r.prevents.length ? r.prevents.map((k) => `\`${k}\``).join(", ") : "(none declared)"} | ` +
        `${usd(r.savings)}${r.reason ? ` — ${r.reason}` : ""} |`)
    : ["| (no held win-kind lessons this period) | — | — | — |"];
  return [
    `Period: ${l.from} → ${l.to} · ${l.sessions} sessions · ` +
      `baseline window: ${l.baseline.from} → ${l.baseline.to} (${l.baseline.sessions} sessions)`,
    "",
    "| Held win | Occurrences | Prevents | Savings |",
    "|---|---:|---|---:|",
    ...rows,
    "",
    `Win savings: ${usd(l.savings)}` +
      `${l.unpriced ? ` (${l.unpriced} of ${l.rows.length} rows unpriced)` : ""} · ` +
      `Culprit cost: ${usd(l.cost)} · Net: ${usd(l.net)}`,
    `Excluded: ${l.excluded.events} events unattributable to a stage`,
    "",
    "*Net is avoided cost minus incurred cost within this period — not profit, and not a rate.*",
  ].join("\n");
}

const times = (v) => `${v.toFixed(2)}x`;

const EXCLUSION_LABELS = [
  ["unparseableTask", "unparseable task attribution"],
  ["unknownRequestKind", "unknown requestKind"],
  ["missingTranscript", "missing transcript"],
  ["noPricedTurns", "no priced turns"],
  ["unpricedModel", "unpriceable turn model"],
  ["multiModel", "multi-model subagent"],
  ["noVerdict", "no round-1 verdict"],
];

// The routing advisory, as a report section and as the body of
// docs/devcycle/routing-advisories.md. Advisory only: nothing dispatches on it. Routing changes
// when a human reads this and sets a *Model knob, which references/config.md's resolution order
// already treats as the one thing that beats the profile.
export function routingAdvisoriesSection(a) {
  const lines = [];
  if (!a.cells.length) {
    lines.push(
      "No measurable dispatch reached a cell this run — every joined dispatch fell into an",
      "exclusion below. No recommendation is made in either direction.",
      "",
    );
  }
  for (const klass of a.classes) {
    lines.push(`### ${klass.requestKind}`, "");
    lines.push(`Compared against the cheapest cell by measured mean cost per dispatch: \`${klass.cheapest}\`.`, "");
    lines.push("| Model | Dispatches | Rework-free accepts | Cost / accepted task | Ratio vs. cheapest | Verdict |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const c of klass.comparisons) {
      const interval = c.interval
        ? `${times(c.interval.median)} [${times(c.interval.low)}, ${times(c.interval.high)}]`
        : "—";
      lines.push(`| \`${c.model}\` | ${c.cell.dispatches} | ${c.cell.accepted} | ${usd(c.cell.costPerAccepted)} | ${interval} | ${c.state} |`);
    }
    lines.push("");
  }

  lines.push("### Corpus and exclusions", "");
  lines.push(`Joined implementer dispatches: ${a.corpus.joined} · with a task number: ${a.corpus.withTask} · with a known requestKind: ${a.corpus.withKind} · with a round-1 verdict: ${a.corpus.withVerdict}.`);
  lines.push(`Measured spend: ${usd(a.corpus.measuredUSD)}, of which ${a.corpus.unmeasurable} dispatch(es) could not be priced.`, "");
  for (const [key, label] of EXCLUSION_LABELS) lines.push(`- ${label} — ${a.exclusions[key]}`);
  lines.push("");

  lines.push("### Confounds this advisory does not correct", "");
  lines.push(
    "- **Task selection.** The `auto` predicates in `references/config.md` § Model tiers chose each",
    "  dispatch's model from task complexity, so pricier cells hold systematically harder and larger",
    "  tasks. The measured ratio is not a causal efficiency claim about the models.",
    "- **Multiplicity.** One comparison per cell against its class's cheapest, with the comparator",
    "  chosen by cost after the data was seen. Each interval is per comparison, not family-wise.",
    "- **Same-tier cells.** Two models that price identically differ here only in acceptance and",
    "  token use. That comparison is reported, not suppressed.",
    "- **Window.** The corpus is whatever the journal and transcripts hold, not a controlled trial;",
    "  a cell's composition shifts as the repo's work shifts.",
    "",
    "Nothing reads this advisory. Routing changes only when a human sets a `*Model` knob via",
    "`claude plugin install --config`.",
  );
  return lines.join("\n");
}

export function renderLearnReport({ candidates, promotions, outcome = false, verification = null, budget = null, ledger = null, routingAdvisories = null }) {
  const { corpus, checkpoint, attribution } = candidates;
  const cands = candidates.candidates ?? [];
  const roll = allTimeRollup(promotions ?? []);
  const vcands = {
    escalation: verification?.candidates?.escalation ?? [],
    retirement: verification?.candidates?.retirement ?? [],
    reinforcement: verification?.candidates?.reinforcement ?? [],
  };
  const landed = cands.filter((c) => c.disposition === "landed");
  const rest = cands.filter((c) => c.disposition !== "landed");
  const journal = corpus.journalEmpty
    ? "Journal: empty (no run records yet)"
    : `Journal: ${corpus.journalEvents} events (${corpus.journalEvents === 0 ? "read, nothing in window" : "read"})`;

  const L = [
    `# Learn Report (${outcome ? "outcome" : "proposal"}) — ${candidates.repo} — ${candidates.generatedAt.slice(0, 10)}`,
    "",
    `Profile: ${candidates.profile} · Corpus: ${corpus.sessions} sessions (${corpus.from} → ${corpus.to}) · ` +
      `Capped: ${corpus.capped ? "yes" : "no"}`,
    journal,
    `Checkpoint: ${checkpoint.before ?? "never"} → ${checkpoint.after}`,
    `Attributed: ${attribution.vocabulary} vocabulary · ${attribution.novel} novel`,
    "",
    "## Summary",
    "",
    summaryTable(cands, roll),
    "",
    `*All-time columns are a scan of \`docs/devcycle/promotions/\`. ${roll.unbucketed} ` +
      (roll.unbucketed === 1 ? "record predates `rung:` and does not bucket" : "records predate `rung:` and do not bucket") +
      "; the all-time count accumulates from this phase's ship date.*",
    "",
    `Sourced this run: ${landed.filter((c) => c.sourcedFromMemory).length} from memory · ` +
      `${landed.filter((c) => !c.sourcedFromMemory).length} from journal/transcript mining`,
    `Sourced all-time: ${roll.sourced.memory} from memory · ${roll.sourced.mining} from journal/transcript mining`,
    "",
    `Rung-transition timing (all-time): r2 → r3 escalation, median ` +
      `${roll.transitions.r2r3 === null ? "— (no escalation recorded yet)" : `${roll.transitions.r2r3} days`} · ` +
      `r2 → retired (held out), median ` +
      `${roll.transitions.r2retired === null ? "— (no retirement recorded yet)" : `${roll.transitions.r2retired} days`}`,
    ...(budget
      ? [`Always-loaded budget: ${budget.netBytes} bytes ` +
         `(${budget.withinBudget ? "within budget" : "over budget — a same-run retirement is required"})`]
      : []),
    "",
    ...(ledger ? ["## Ledger", "", ledgerSection(ledger), ""] : []),
    ...(routingAdvisories ? ["## Routing advisories", "", routingAdvisoriesSection(routingAdvisories), ""] : []),
    "## Landed",
    "",
    landed.length ? landed.map(landedEntry).join("\n\n") : "(none this run)",
    "",
    "## Declined / deferred",
    "",
    rest.length
      ? rest.map((c) =>
          `- ${c.title} · ${c.culpritId} · ${c.rung} · ${c.declineReason ?? "no reason recorded"} · ` +
          `sensitive: ${c.sensitive ? "yes" : "no"}`,
        ).join("\n")
      : "(none this run)",
    "",
    "## Evictions",
    "",
    (candidates.evictions ?? []).length
      ? candidates.evictions.map((e) => `- landing evicts \`${e.culpritId}\` from \`${e.section}\` (${e.reason})`).join("\n")
      : "(none this run)",
    "",
    "## Contradictions resolved",
    "",
    "| Culprit-id | Side A | Side B | Chosen |",
    "|---|---|---|---|",
    ...(candidates.contradictions ?? []).map((c) => `| ${c.culpritId} | ${c.sideA} | ${c.sideB} | ${c.chosen} |`),
    "",
    "## Verification candidates",
    "",
    "### Graduation (r1/r2 → r3)",
    "",
    vcands.escalation.length
      ? vcands.escalation.map((c) => `- \`${c.culpritId}\` (${c.rung}) — ${c.reason}`).join("\n")
      : "(none this run)",
    "",
    "### Reinforcement",
    "",
    vcands.reinforcement.length
      ? vcands.reinforcement.map((c) => `- \`${c.culpritId}\` (${c.rung}) — ${c.reason}`).join("\n")
      : "(none this run)",
    "",
    "### Retirement",
    "",
    vcands.retirement.length
      ? vcands.retirement.map((c) => `- \`${c.culpritId}\` (${c.rung}) — ${c.reason}`).join("\n")
      : "(none this run)",
    "",
    "## Previously promoted — did it hold",
    "",
    candidates.recurrence ?? "(rendered from `--check-recurrence`; see the run's own output)",
    "",
  ];
  return L.join("\n");
}
