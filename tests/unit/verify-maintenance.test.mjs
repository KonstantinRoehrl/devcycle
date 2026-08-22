import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyMaintenance } from "../../scripts/verification.mjs";

const rec = (over) => ({
  findingId: "dead-code:aaaa1111", findingKind: "maintenance-finding", passes: 1,
  firstSeen: "2026-08-20", severity: "medium", confidence: "verified", verify: null, lifecycle: null, ...over,
});

test("detected & prior passes → persisting with an incremented count", () => {
  const out = verifyMaintenance([rec({ passes: 1 })], { detectedIds: new Set(["dead-code:aaaa1111"]) });
  assert.equal(out.sections.persisting.length, 1);
  assert.equal(out.sections.persisting[0].passes, 2);
  assert.equal(out.gaps.length, 0);
});

test("a detected id with no stored record is new (returned as newIds, not a scoreboard row)", () => {
  const out = verifyMaintenance([], { detectedIds: new Set(["dead-code:new00001"]) });
  assert.deepEqual(out.newIds, ["dead-code:new00001"]);
  assert.equal(out.scoreboard.length, 0);
});

test("a re-detected dismissed finding is not treated as new", () => {
  const out = verifyMaintenance([rec({ lifecycle: "dismissed", dismissedReason: "x" })], { detectedIds: new Set(["dead-code:aaaa1111"]) });
  assert.equal(out.newIds.length, 0);
  assert.equal(out.scoreboard.length, 0);
});

test("undetected active → resolved and emitted to gaps (uncorroborated)", () => {
  const out = verifyMaintenance([rec()], { detectedIds: new Set() });
  assert.equal(out.sections.resolved.length, 1);
  assert.equal(out.gaps.length, 1);
  assert.match(out.gaps[0].note, /uncorroborated|rename|move/);
});

test("resolved-then-detected → regressed", () => {
  const out = verifyMaintenance([rec({ lifecycle: "resolved" })], { detectedIds: new Set(["dead-code:aaaa1111"]) });
  assert.equal(out.sections.regressed.length, 1);
});

test("dismissed is excluded from scoring entirely", () => {
  const out = verifyMaintenance([rec({ lifecycle: "dismissed" })], { detectedIds: new Set(["dead-code:aaaa1111"]) });
  assert.equal(out.scoreboard.length, 0);
});

test("resolved-stable (locked resolved, still undetected) is not re-scored", () => {
  const out = verifyMaintenance([rec({ lifecycle: "resolved" })], { detectedIds: new Set() });
  assert.equal(out.scoreboard.length, 0);
});

test("detectedIds dedupes — the pass counter never double-counts", () => {
  const out = verifyMaintenance([rec({ passes: 1 })], { detectedIds: ["dead-code:aaaa1111", "dead-code:aaaa1111"] });
  assert.equal(out.sections.persisting[0].passes, 2);
});

test("a passing mechanical verify: corroborates a resolve — no gap", () => {
  const runCheck = () => ({ status: "ok", detail: null });
  const out = verifyMaintenance([rec({ verify: "test.sh" })], { detectedIds: new Set() }, { runCheck });
  assert.equal(out.sections.resolved.length, 1);
  assert.equal(out.sections.resolved[0].verdict, "held");
  assert.equal(out.gaps.length, 0);
});
