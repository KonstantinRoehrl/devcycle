import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verify, defaultRunCheck, skipRunCheck, VERIFY_TIMEOUT_MS } from "../../scripts/verification.mjs";

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

test("r3: runCheck status unrunnable renders unmeasurable, never held", () => {
  const p = [promo({ culpritId: "friction:c", rung: "r3", verify: "tests/fixtures/learn/candidates.json", landed: "2026-08-01" })];
  const skipped = verify(p, [], "0.14.0", { now: Date.parse("2026-08-20"), runCheck: () => ({ status: "unrunnable", detail: "unrunnable: check did not execute" }) });
  assert.equal(skipped.scoreboard[0].verdict, "unmeasurable");
  assert.match(skipped.scoreboard[0].detail, /unrunnable/); // the reason is annotated, distinct from a held/broken path
  const passed = verify(p, [], "0.14.0", { now: Date.parse("2026-08-20"), runCheck: () => ({ status: "ok", detail: null }) });
  assert.equal(passed.scoreboard[0].verdict, "held");
  assert.equal(passed.scoreboard[0].detail, "tests/fixtures/learn/candidates.json"); // held keeps the bare path
  const broke = verify(p, [], "0.14.0", { now: Date.parse("2026-08-20"), runCheck: () => ({ status: "failed", detail: null }) });
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
  assert.deepEqual(defaultRunCheck("fail.sh", { root }), { status: "failed", detail: null });
  assert.deepEqual(defaultRunCheck("pass.sh", { root }), { status: "ok", detail: null });
  assert.deepEqual(defaultRunCheck("data.json", { root }), { status: "unrunnable", detail: "unrunnable: check did not execute" });
});

test("defaultRunCheck reports an existing but non-runnable verify: path as unmeasurable, not held", () => {
  const dir = mkdtempSync(join(tmpdir(), "verif-"));
  writeFileSync(join(dir, "fixture.json"), "{}\n");           // exists, not runnable-as-a-check
  const r = defaultRunCheck("fixture.json", { root: dir });
  assert.deepEqual(r, { status: "unrunnable", detail: "unrunnable: check did not execute" });
});

test("verify() maps a non-runnable r3 verify: path to unmeasurable", () => {
  const promotions = [{ culpritId: "x:y", rung: "r3", verify: "fixture.json", landed: "2026-01-01" }];
  const dir = mkdtempSync(join(tmpdir(), "verif-"));
  writeFileSync(join(dir, "fixture.json"), "{}\n");
  const { scoreboard } = verify(promotions, [], "0.13.1", { root: dir, runCheck: defaultRunCheck });
  assert.equal(scoreboard[0].verdict, "unmeasurable");
});

test("F1: verify() executes nothing by default — a hostile verify: line has no side effect", () => {
  const root = mkdtempSync(join(tmpdir(), "verif-f1-"));
  const promotions = [{
    culpritId: "friction:hostile", rung: "r3", verify: `touch ${join(root, "pwned")}`,
    landed: "2026-01-01", aliases: [], lifecycle: null,
  }];
  const { scoreboard } = verify(promotions, [], "0.14.0", { root });
  assert.equal(existsSync(join(root, "pwned")), false, "the default runCheck must not execute anything");
  assert.equal(scoreboard[0].verdict, "unmeasurable");
  assert.match(scoreboard[0].detail, /not run: pass --run-checks/);
});

test("F1: passing defaultRunCheck explicitly opts back into execution", () => {
  const root = mkdtempSync(join(tmpdir(), "verif-f1-optin-"));
  const promotions = [{
    culpritId: "friction:hostile", rung: "r3", verify: `touch ${join(root, "pwned")}`,
    landed: "2026-01-01", aliases: [], lifecycle: null,
  }];
  const { scoreboard } = verify(promotions, [], "0.14.0", { root, runCheck: defaultRunCheck });
  assert.equal(existsSync(join(root, "pwned")), true, "--run-checks must actually run the check");
  assert.equal(scoreboard[0].verdict, "held");
});

test("skipRunCheck reports skipped and names the flag", () => {
  assert.deepEqual(skipRunCheck(), { status: "skipped", detail: "not run: pass --run-checks" });
});

test("F48: a check that outlives its timeout is errored, not unmeasurable and not broken", () => {
  const root = mkdtempSync(join(tmpdir(), "verif-timeout-"));
  const r = defaultRunCheck("sleep 30", { root, timeoutMs: 250 });
  assert.equal(r.status, "errored");
  assert.match(r.detail, /errored:/);
});

test("F48: a check that floods stdout past maxBuffer is errored, not unmeasurable", () => {
  const root = mkdtempSync(join(tmpdir(), "verif-enobuf-"));
  const r = defaultRunCheck("yes hello", { root, timeoutMs: 5000, maxBuffer: 64 });
  assert.equal(r.status, "errored");
  assert.match(r.detail, /errored:/);
});

test("F48: verify() maps an errored check to the errored verdict, distinct from unmeasurable", () => {
  const promotions = [{
    culpritId: "friction:slow", rung: "r3", verify: "sleep 30",
    landed: "2026-01-01", aliases: [], lifecycle: null,
  }];
  const { scoreboard } = verify(promotions, [], "0.14.0", {
    root: mkdtempSync(join(tmpdir(), "verif-errored-")), runCheck: defaultRunCheck, timeoutMs: 250,
  });
  assert.equal(scoreboard[0].verdict, "errored");
  assert.match(scoreboard[0].detail, /\(errored: /);
});

test("defaultRunCheck bounds are exported so callers cannot spawn unbounded", () => {
  assert.equal(typeof VERIFY_TIMEOUT_MS, "number");
  assert.ok(VERIFY_TIMEOUT_MS > 0 && VERIFY_TIMEOUT_MS <= 120_000);
});
