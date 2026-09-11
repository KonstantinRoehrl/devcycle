import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePolicy, readPolicy, severityPercentile, derivedSeverityThreshold,
} from "../../scripts/reinforcement-policy.mjs";
import { classifyCandidate, verify } from "../../scripts/verification.mjs";

const GOOD = `<!-- reinforcement-policy:begin -->
\`\`\`json
{ "severityPercentileByProfile": { "lean": 70, "standard": 60, "thorough": 50 },
  "culpritRecurrenceBar": 2, "winRecurrenceBar": 3, "graduationRuns": 3, "minPricedKeysForPercentile": 3 }
\`\`\`
<!-- reinforcement-policy:end -->`;

test("parsePolicy: happy path returns the typed object", () => {
  const p = parsePolicy(GOOD);
  assert.equal(p.culpritRecurrenceBar, 2);
  assert.equal(p.severityPercentileByProfile.thorough, 50);
});

test("parsePolicy: throws on each invariant", () => {
  assert.throws(() => parsePolicy(GOOD.replace('"graduationRuns": 3,', "")), /graduationRuns/);
  assert.throws(() => parsePolicy(GOOD.replace('"culpritRecurrenceBar": 2', '"culpritRecurrenceBar": 1.5')), /culpritRecurrenceBar/);
  assert.throws(() => parsePolicy(GOOD.replace('"lean": 70', '"lean": 100')), /\(0,100\)/);
  assert.throws(() => parsePolicy(GOOD.replace('"winRecurrenceBar": 3', '"winRecurrenceBar": 2')), /strictly greater/);
});

test("readPolicy: the shipped file parses and holds the asymmetry", () => {
  const p = readPolicy();
  assert.ok(p.winRecurrenceBar > p.culpritRecurrenceBar);
});

test("severityPercentile: falls back to standard for an unknown profile", () => {
  const p = parsePolicy(GOOD);
  assert.equal(severityPercentile(p, "thorough"), 50);
  assert.equal(severityPercentile(p, "bogus"), 60);
});

test("derivedSeverityThreshold: pinned percentile math and min-sample guard", () => {
  const p = readPolicy();
  const vals = [2.57, 7.07, 8.46, 8.57, 11.01]; // N=5
  // standard P=60 -> idx = floor(0.6*5)=3 -> sorted[3] = 8.57
  assert.equal(derivedSeverityThreshold(vals, severityPercentile(p, "standard"), p.minPricedKeysForPercentile), 8.57);
  // thorough P=50 -> idx = floor(0.5*5)=2 -> sorted[2] = 8.46
  assert.equal(derivedSeverityThreshold(vals, severityPercentile(p, "thorough"), p.minPricedKeysForPercentile), 8.46);
  // below minKeys -> null
  assert.equal(derivedSeverityThreshold([2.57, 7.07], severityPercentile(p, "standard"), p.minPricedKeysForPercentile), null);
});

// The propose-gate decision at its module boundary (QC4): every policy constant is read from
// readPolicy(); the cutoff is an explicit given so no fixed-point can form between it and a
// distribution that would include these fixtures.
const P = readPolicy();
const CUT = 8.57;          // an explicit given, not derived from the fixtures
const belowBar = P.culpritRecurrenceBar - 1;
const belowRuns = P.graduationRuns - 1;

test("classifyCandidate: high-severity culprit escalates on severity alone", () => {
  const r = classifyCandidate(
    { verify: "journal-recurrence", verdict: "recurred", rung: "r2", recurrences: belowBar, runsObserved: belowRuns },
    P, { costPerOccurrence: CUT + 1, severityCutoff: CUT });
  assert.equal(r.list, "escalation");
});

test("classifyCandidate: low-severity single-recurrence culprit is held", () => {
  const r = classifyCandidate(
    { verify: "journal-recurrence", verdict: "recurred", rung: "r2", recurrences: belowBar, runsObserved: belowRuns },
    P, { costPerOccurrence: 0.01, severityCutoff: CUT });
  assert.equal(r, null);
});

test("classifyCandidate: under-threshold win is held", () => {
  const r = classifyCandidate(
    { verify: "journal-reinforcement", verdict: "held", rung: "r1", recurrences: P.winRecurrenceBar - 1, runsObserved: 1 },
    P, { costPerOccurrence: null, severityCutoff: CUT });
  assert.equal(r, null);
});

test("classifyCandidate: over-threshold win reinforces", () => {
  const r = classifyCandidate(
    { verify: "journal-reinforcement", verdict: "held", rung: "r1", recurrences: P.winRecurrenceBar, runsObserved: 1 },
    P, { costPerOccurrence: null, severityCutoff: CUT });
  assert.equal(r.list, "reinforcement");
});

// The wiring inside verify(): percentile derivation from costByKey + per-promotion cost lookup
// under the same bare/novel: normalization + routing to candidates[list]. friction:a is isolated so
// that ONLY the derived severity cutoff can escalate it — its window holds just its own single
// recurrence, so recurrences (1) < culpritRecurrenceBar and runsObserved (1) < graduationRuns, and
// neither the recurrence-floor nor the stuck-runs safety-net disjunct can fire. The win lands
// earlier, still sees its winRecurrenceBar grounding events, and reinforces on its own path. This
// is the classifyCandidate severity fixture lifted to the verify() level, so the escalation
// assertion can only pass because the costByKey → severityCutoff → per-promotion-lookup wiring works.
test("verify(): a priced recurrence escalates on severity and a grounded win reinforces", () => {
  const ev = (culprit, ts, runId) => ({ event: "gate-fail", culprit, ts, runId });
  // A single recurrence in a window of its own is below both non-severity disjuncts only when each
  // bar exceeds 1; the shipped asymmetry (winRecurrenceBar > culpritRecurrenceBar >= 1) and
  // graduationRuns guarantee it. Assert it so a policy edit that flattened a bar would fail here.
  assert.ok(P.culpritRecurrenceBar > 1 && P.graduationRuns > 1);
  const promotions = [
    // The win lands first, so its window captures the winRecurrenceBar grounding events below.
    { verify: "journal-reinforcement", aliases: [], lifecycle: null, culpritId: "win:clean-round-one", rung: "r2", landed: "2026-07-01" },
    // friction:a lands AFTER every win event, so its window holds only its own single recurrence.
    { verify: "journal-recurrence", aliases: [], lifecycle: null, culpritId: "friction:a", rung: "r2", landed: "2026-08-01" },
  ];
  const winEvents = Array.from({ length: P.winRecurrenceBar }, (_, i) =>
    ev("clean-round-one", `2026-07-${String(i + 2).padStart(2, "0")}T00:00:00Z`, `w${i}`));
  const journal = [...winEvents, ev("a", "2026-08-02T00:00:00Z", "ra")];
  // A culprit-only priced corpus at minPricedKeysForPercentile. standard's P=60 derives
  // idx = floor(0.6 * 3) = 1 -> cutoff $7.07, which the dear key "a" clears on its single
  // recurrence ($11.01) while the cheap keys sit below it — so severity is the sole escalation path.
  const costByKey = { a: 11.01, "cheap-one": 2.57, "cheap-two": 7.07 };
  const out = verify(promotions, journal, "0.14.0",
    { now: Date.parse("2026-08-05"), costByKey, profile: "standard" });
  const escalated = out.candidates.escalation.find((e) => e.culpritId === "friction:a");
  assert.ok(escalated,
    "the priced single recurrence escalates — via the derived severity cutoff, not the floor or safety-net");
  assert.match(escalated.reason, /^severity \$/,
    "and it escalates on the severity disjunct specifically, not `recurred N×` or `stuck M runs`");
  assert.ok(out.candidates.reinforcement.some((r) => r.culpritId === "win:clean-round-one"),
    "the grounded win lands in the reinforcement list");
});
