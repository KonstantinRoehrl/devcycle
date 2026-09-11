import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePolicy, readPolicy, severityPercentile, derivedSeverityThreshold,
} from "../../scripts/reinforcement-policy.mjs";

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
