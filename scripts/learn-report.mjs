#!/usr/bin/env node
// D9's report, rendered once and used twice: the same function produces the proposal a Confirm
// batch is read against and the outcome written after Land, so the two are diffable by
// construction rather than by discipline. Pure — it is handed data and returns markdown.

const RUNGS = ["r3", "r2", "r1", "r0"];
const RUNG_LABEL = { r3: "r3 mechanical", r2: "r2 digest line", r1: "r1 always-loaded", r0: "r0 memory" };

const usd = (n) => (typeof n === "number" ? `$${n.toFixed(2)}` : "unmeasurable");
const days = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

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
  return { byRung, sourced, transitions: { r2r3: median(spans), r2retired: median(retirementDeltas) }, unbucketed };
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

export function renderLearnReport({ candidates, promotions, outcome = false, verification = null, budget = null }) {
  const { corpus, checkpoint, attribution } = candidates;
  const cands = candidates.candidates ?? [];
  const roll = allTimeRollup(promotions ?? []);
  const vcands = {
    escalation: verification?.candidates?.escalation ?? [],
    retirement: verification?.candidates?.retirement ?? [],
  };
  const landed = cands.filter((c) => c.disposition === "landed");
  const rest = cands.filter((c) => c.disposition !== "landed");
  // Unmeasurable is not zero (`references/impact-scoring.md`): summing a non-numeric impact in as
  // 0 would let a mixed batch's partial subtotal read as the whole run, and a run with nothing
  // scorable read as a measured $0.00. Only scored candidates are summed, and the line says how
  // many of the landed set that sum covers.
  const scored = landed.filter((c) => typeof c.impact === "number");
  const unscored = landed.length - scored.length;
  const impact = scored.reduce((n, c) => n + c.impact, 0);
  const impactLine = unscored === 0
    ? `Impact addressed this run: ${usd(impact)}`
    : (scored.length
        ? `Impact addressed this run: ${usd(impact)} across ${scored.length} of ${landed.length} landed · ` +
          `${unscored} unmeasurable`
        : `Impact addressed this run: unmeasurable · 0 of ${landed.length} landed scored`) +
      " (no attributable cost — see `references/impact-scoring.md`)";
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
    impactLine,
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
    "### Escalation (r2 → r3)",
    "",
    vcands.escalation.length
      ? vcands.escalation.map((c) => `- \`${c.culpritId}\` (${c.rung}) — ${c.reason}`).join("\n")
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
