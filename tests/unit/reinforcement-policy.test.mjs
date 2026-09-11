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
// under the same bare/novel: normalization + routing to candidates[list]. "a" recurs once — below
// culpritRecurrenceBar — so only its priced severity can escalate it, which proves the cost wiring;
// the win recurs winRecurrenceBar times and lands in the new reinforcement list.
test("verify(): a priced recurrence escalates on severity and a grounded win reinforces", () => {
  const ev = (culprit, ts, runId) => ({ event: "gate-fail", culprit, ts, runId });
  const promotions = [
    { verify: "journal-recurrence", aliases: [], lifecycle: null, culpritId: "friction:a", rung: "r2", landed: "2026-08-01" },
    { verify: "journal-reinforcement", aliases: [], lifecycle: null, culpritId: "win:clean-round-one", rung: "r2", landed: "2026-08-01" },
  ];
  const winEvents = Array.from({ length: P.winRecurrenceBar }, (_, i) =>
    ev("clean-round-one", `2026-08-${String(i + 10).padStart(2, "0")}T00:00:00Z`, `w${i}`));
  const journal = [ev("a", "2026-08-05T00:00:00Z", "r1"), ...winEvents];
  // A priced corpus at/above minPricedKeysForPercentile so a cutoff derives; "a" is the dear key.
  const costByKey = { a: 10, "cheap-one": 0.1, "cheap-two": 0.2 };
  const out = verify(promotions, journal, "0.14.0",
    { now: Date.parse("2026-08-20"), costByKey, profile: "standard" });
  assert.ok(out.candidates.escalation.some((e) => e.culpritId === "friction:a"),
    "the priced single recurrence escalates on severity");
  assert.ok(out.candidates.reinforcement.some((r) => r.culpritId === "win:clean-round-one"),
    "the grounded win lands in the reinforcement list");
});
