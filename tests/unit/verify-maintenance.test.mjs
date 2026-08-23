import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyMaintenance } from "../../scripts/verification.mjs";
import { findingId } from "../../scripts/maintenance-findings.mjs";

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

test("file-rename fixture: an id that changes across a structural move stops being scored — visibly, not silently", () => {
  // Spec (Component 2 "Known limit" + Testing item 4): the engine cannot tell a rename apart from a
  // genuine fix plus an unrelated new finding. Compose BOTH halves in one pass: the OLD id (built from
  // the pre-rename canonicalLocation) goes undetected, while a DIFFERENT, NEW id (built from the
  // post-rename canonicalLocation) is detected — simulating the same underlying finding surviving a
  // structural move without the engine being able to link the two.
  const oldId = findingId("dead-code", "scripts/old-name.mjs");
  const newId = findingId("dead-code", "scripts/renamed-name.mjs");
  assert.notEqual(oldId, newId, "the fixture must use genuinely different ids, or it doesn't exercise rename-drift");

  const out = verifyMaintenance([rec({ findingId: oldId })], { detectedIds: new Set([newId]) });

  // The old id stops being scored: its record lands in resolved, not persisting or regressed.
  assert.equal(out.sections.resolved.length, 1);
  assert.equal(out.sections.resolved[0].id, oldId);
  // Drift stays visible: the old id is flagged in gaps rather than reading as a silent clean resolve.
  assert.equal(out.gaps.length, 1);
  assert.equal(out.gaps[0].id, oldId);
  assert.match(out.gaps[0].note, /rename|move/);
  // The new id reads as an unrelated new finding — exactly the documented limit: the engine has no
  // way to tell "this is the old finding, renamed" from "the old finding was fixed and a new,
  // unrelated one appeared".
  assert.deepEqual(out.newIds, [newId]);
});

test("a passing mechanical verify: corroborates a resolve — no gap", () => {
  const runCheck = () => ({ status: "ok", detail: null });
  const out = verifyMaintenance([rec({ verify: "test.sh" })], { detectedIds: new Set() }, { runCheck });
  assert.equal(out.sections.resolved.length, 1);
  assert.equal(out.sections.resolved[0].verdict, "held");
  assert.equal(out.gaps.length, 0);
});
