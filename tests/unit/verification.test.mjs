import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verify, defaultRunCheck } from "../../scripts/verification.mjs";

const ev = (culprit, ts, runId) => ({ event: "gate-fail", culprit, ts, runId });
const promo = (o) => ({ verify: "journal-recurrence", aliases: [], lifecycle: null, ...o });

test("r0-r2: zero runs after landed is unmeasurable, never held", () => {
  const p = [promo({ culpritId: "friction:a", rung: "r2", landed: "2026-08-01" })];
  const out = verify(p, [], "0.14.0", { now: Date.parse("2026-08-20") });
  assert.equal(out.scoreboard[0].verdict, "unmeasurable");
});

test("r0-r2: a run with no recurrence is held; a recurrence is recurred + escalation", () => {
  const runs = [ev(null, "2026-08-05T00:00:00Z", "r1")];
  const held = verify([promo({ culpritId: "friction:a", rung: "r2", landed: "2026-08-01" })], runs, "0.14.0", { now: Date.parse("2026-08-20") });
  assert.equal(held.scoreboard[0].verdict, "held");
  const recur = verify([promo({ culpritId: "friction:a", rung: "r2", landed: "2026-08-01" })],
    [...runs, ev("friction:a", "2026-08-06T00:00:00Z", "r2")], "0.14.0", { now: Date.parse("2026-08-20") });
  assert.equal(recur.scoreboard[0].verdict, "recurred");
  assert.equal(recur.candidates.escalation[0].culpritId, "friction:a");
});

test("retirement fires on held past 10 runs OR 90 days", () => {
  const runs = Array.from({ length: 11 }, (_, i) => ev(null, `2026-08-${String(i + 2).padStart(2, "0")}T00:00:00Z`, `r${i}`));
  const out = verify([promo({ culpritId: "friction:a", rung: "r2", landed: "2026-08-01" })], runs, "0.14.0", { now: Date.parse("2026-08-20") });
  assert.equal(out.candidates.retirement[0].culpritId, "friction:a");
});

test("r3: runCheck ran=false renders unmeasurable, never held", () => {
  const p = [promo({ culpritId: "friction:c", rung: "r3", verify: "tests/fixtures/learn/candidates.json", landed: "2026-08-01" })];
  const skipped = verify(p, [], "0.14.0", { now: Date.parse("2026-08-20"), runCheck: () => ({ ran: false, ok: false }) });
  assert.equal(skipped.scoreboard[0].verdict, "unmeasurable");
  const passed = verify(p, [], "0.14.0", { now: Date.parse("2026-08-20"), runCheck: () => ({ ran: true, ok: true }) });
  assert.equal(passed.scoreboard[0].verdict, "held");
  const broke = verify(p, [], "0.14.0", { now: Date.parse("2026-08-20"), runCheck: () => ({ ran: true, ok: false }) });
  assert.equal(broke.scoreboard[0].verdict, "broken");
});

test("resolved-in: recurrence after installed reached resolved-in is recurred; installed below is unmeasurable", () => {
  const vocab = [{ kind: "friction", slug: "flaky-test-retry", "resolved-in": "0.14.0" }];
  const releaseDates = new Map([["0.14.0", "2026-08-05"]]);
  const runs = [ev("friction:flaky-test-retry", "2026-08-10T00:00:00Z", "r1")];
  const below = verify([], runs, "0.13.0", { now: Date.parse("2026-08-20"), vocab, releaseDates });
  assert.equal(below.resolvedIn[0].verdict, "unmeasurable");
  const at = verify([], runs, "0.14.0", { now: Date.parse("2026-08-20"), vocab, releaseDates });
  assert.equal(at.resolvedIn[0].verdict, "recurred");
});

test("resolved-in: a post-release run for a different culprit is held (the previously-dead path)", () => {
  const vocab = [{ kind: "friction", slug: "flaky-test-retry", "resolved-in": "0.14.0" }];
  const releaseDates = new Map([["0.14.0", "2026-08-05"]]);
  const runs = [ev("friction:other", "2026-08-10T00:00:00Z", "r1")];
  const out = verify([], runs, "0.14.0", { now: Date.parse("2026-08-20"), vocab, releaseDates });
  assert.equal(out.resolvedIn[0].verdict, "held");
});

test("resolved-in: a culprit event dated before the release is not counted (date boundary)", () => {
  const vocab = [{ kind: "friction", slug: "flaky-test-retry", "resolved-in": "0.14.0" }];
  const releaseDates = new Map([["0.14.0", "2026-08-05"]]);
  const runs = [
    ev("friction:flaky-test-retry", "2026-01-01T00:00:00Z", "r0"),
    ev(null, "2026-08-10T00:00:00Z", "r1"),
  ];
  const out = verify([], runs, "0.14.0", { now: Date.parse("2026-08-20"), vocab, releaseDates });
  assert.equal(out.resolvedIn[0].verdict, "held");
});

test("resolved-in: reached but the resolving version has no CHANGELOG date is unmeasurable, never held", () => {
  const vocab = [{ kind: "friction", slug: "flaky-test-retry", "resolved-in": "0.14.0" }];
  const runs = [ev("friction:other", "2026-08-10T00:00:00Z", "r1")];
  const out = verify([], runs, "0.14.0", { now: Date.parse("2026-08-20"), vocab, releaseDates: new Map() });
  assert.equal(out.resolvedIn[0].verdict, "unmeasurable");
});

test("defaultRunCheck runs an existing runnable script/test and uses its exit code (F3)", () => {
  const root = mkdtempSync(join(tmpdir(), "verif-runcheck-"));
  writeFileSync(join(root, "fail.sh"), "exit 3\n");
  writeFileSync(join(root, "pass.sh"), "exit 0\n");
  writeFileSync(join(root, "data.json"), "{}\n");
  assert.deepEqual(defaultRunCheck("fail.sh", { root }), { ran: true, ok: false });
  assert.deepEqual(defaultRunCheck("pass.sh", { root }), { ran: true, ok: true });
  assert.deepEqual(defaultRunCheck("data.json", { root }), { ran: false, ok: false });
});

test("defaultRunCheck reports an existing but non-runnable verify: path as unmeasurable, not held", () => {
  const dir = mkdtempSync(join(tmpdir(), "verif-"));
  writeFileSync(join(dir, "fixture.json"), "{}\n");           // exists, not runnable-as-a-check
  const r = defaultRunCheck("fixture.json", { root: dir });
  assert.deepEqual(r, { ran: false, ok: false });
});

test("verify() maps a non-runnable r3 verify: path to unmeasurable", () => {
  const promotions = [{ culpritId: "x:y", rung: "r3", verify: "fixture.json", landed: "2026-01-01" }];
  const dir = mkdtempSync(join(tmpdir(), "verif-"));
  writeFileSync(join(dir, "fixture.json"), "{}\n");
  const { scoreboard } = verify(promotions, [], "0.13.1", { root: dir });
  assert.equal(scoreboard[0].verdict, "unmeasurable");
});
