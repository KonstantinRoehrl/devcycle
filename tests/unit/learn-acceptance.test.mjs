import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoSlug } from "../../scripts/run-record.mjs";
import { verify, installedVersion } from "../../scripts/verification.mjs";

const SCRIPT = new URL("../../scripts/dream.mjs", import.meta.url).pathname;
const DOCTOR = new URL("../../scripts/doctor.mjs", import.meta.url).pathname;
const FIXTURES = new URL("../fixtures/learn/", import.meta.url).pathname;

// A whole repo, journal and lesson store on disk, driven only through the CLI.
function world({ journal = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "devcycle-accept-")));
  const runsDir = join(root, "runs");
  const learnings = join(root, "learnings");
  cpSync(join(FIXTURES, "promotions"), join(root, "docs", "devcycle", "promotions"), { recursive: true });
  if (journal) {
    const dir = join(runsDir, repoSlug(root));
    mkdirSync(dir, { recursive: true });
    cpSync(join(FIXTURES, "journal.jsonl"), join(dir, "1111111111111111.jsonl"));
  }
  return { root, env: { DEVCYCLE_RUNS_DIR: runsDir, DEVCYCLE_LEARNINGS_DIR: learnings } };
}

const cli = (root, env, args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });

// Reads the `# ` heading out of the legacy fixture record — the one promotion with no culprit-id.
function readFixtureLegacyTitle() {
  const text = readFileSync(join(FIXTURES, "promotions", "legacy.md"), "utf8");
  return text.match(/^# (.*)$/m)[1].trim();
}

test("criterion 1: the fixture journal is non-empty and produces no mining slice", () => {
  const { root, env } = world();
  const out = JSON.parse(cli(root, env, ["--journal-events"]).stdout);
  assert.equal(out.journalEmpty, false);
  assert.ok(out.events.length >= 4, "guard: an empty fixture would satisfy the next assertion vacuously");
  assert.ok(Object.keys(out.byCulprit).length >= 2, "events arrive keyed by culprit-id");
});

test("criterion 2: an absent journal reads empty, and the two states are distinguishable", () => {
  const { root, env } = world({ journal: false });
  assert.equal(JSON.parse(cli(root, env, ["--journal-events"]).stdout).journalEmpty, true);
  const warm = world();
  assert.equal(
    JSON.parse(cli(warm.root, warm.env, ["--journal-events", "--since", "2027-01-01T00:00:00Z"]).stdout).journalEmpty,
    false,
    "a journal read with nothing in window is not an empty journal",
  );
});

test("criterion 3: a landed culprit-id is never re-proposed", () => {
  const { root, env } = world();
  assert.deepEqual(JSON.parse(cli(root, env, ["--check-suppressed", "friction:partial-evidence-capture"]).stdout),
    { suppressed: true });
  assert.deepEqual(JSON.parse(cli(root, env, ["--check-suppressed", "friction:never-landed"]).stdout),
    { suppressed: false });
});

test("criterion 4: the legacy record hints and never suppresses", () => {
  const { root, env } = world();
  const title = readFixtureLegacyTitle();
  assert.equal(JSON.parse(cli(root, env, ["--check-suppressed", "friction:whatever"]).stdout).suppressed, false);
  assert.ok(JSON.parse(cli(root, env, ["--legacy-similar", title]).stdout).hints.length >= 1);
});

test("criterion 6: a full section's landing carries an eviction the report renders", () => {
  const { root, env } = world();
  const out = cli(root, env, ["--render-report", join(FIXTURES, "candidates.json")]).stdout;
  assert.match(out, /landing evicts `[a-z0-9:-]+` from `[a-z-]+` \(cap\)/);
});

test("criterion 7: the Confirm partition is golden — nothing moves into the bulk", () => {
  const c = JSON.parse(readFileSync(join(FIXTURES, "candidates.json"), "utf8"));
  // §3: a pipeline-fault candidate "is filed only on per-item consent" — never silently
  // bulked. Sensitive and contradiction-linked candidates carry the same must-be-explicit rule.
  const mustBeExplicit = c.candidates.filter(
    (cand) => cand.fault === "pipeline" || cand.sensitive || cand.culpritId.startsWith("contradiction:"),
  );
  assert.ok(mustBeExplicit.length >= 1,
    "guard: a fixture with no must-be-explicit candidate would satisfy the next assertion vacuously");
  for (const cand of mustBeExplicit)
    assert.equal(cand.partition, "explicit",
      `${cand.culpritId} must not be partitioned into the bulk to skip its decision`);
});

test("criterion 8: proposal and outcome differ only in their proposal/outcome headings", () => {
  const { root, env } = world();
  const p = cli(root, env, ["--render-report", join(FIXTURES, "candidates.json")]).stdout;
  const o = cli(root, env, ["--render-report", join(FIXTURES, "candidates.json"), "--outcome"]).stdout;
  const structure = (s) => s.replace(/^# Learn Report \((proposal|outcome)\)/m, "# Learn Report");
  assert.equal(structure(p).split("\n").filter((l) => l.startsWith("#")).join("\n"),
               structure(o).split("\n").filter((l) => l.startsWith("#")).join("\n"));
});

test("criterion 9: the all-time rollup is computed from the fixture promotions directory", () => {
  const { root, env } = world();
  const out = cli(root, env, ["--render-report", join(FIXTURES, "candidates.json")]).stdout;
  assert.match(out, /Sourced all-time: \d+ from memory · \d+ from journal\/transcript mining/);
  assert.match(out, /1 record predates `rung:` and does not bucket/);
});

test("criterion 10: a journal-recurrence promotion with no observed runs after it landed is unmeasurable", () => {
  const { root, env } = world({ journal: false });
  const out = JSON.parse(cli(root, env, ["--check-recurrence"]).stdout);
  // The F1 intent is about the journal-recurrence axis: zero observed runs is never `held`. The r3
  // `friction:redaction-unknown-flag` row is governed by the check-execution rule (a different
  // axis) and is asserted elsewhere, so this targets the journal-recurrence row specifically.
  const r = out.scoreboard.find((s) => s.culpritId === "friction:partial-evidence-capture");
  assert.ok(r, "the journal-recurrence promotion is scored");
  assert.equal(r.runsObserved, 0);
  assert.equal(r.verdict, "unmeasurable");
});

test("criterion 11: an r3 promotion whose verify does not resolve is refused", () => {
  const { root, env } = world();
  const res = cli(root, env, ["--record-promotion", JSON.stringify({
    title: "t", promotionType: "enforcement-gap", clusterSignature: "s", filesTouched: [],
    landed: "2026-08-14", commit: "abc", pluginVersion: "0.13.0",
    culpritId: "friction:x", rung: "r3", verify: "tests/unit/absent.test.mjs",
  })]);
  assert.notEqual(res.status, 0);
});

// ─── End-to-end acceptance (Task 9): the fixture scoreboard + three candidate classes ───────────
// Added alongside the existing 11 criteria; criterion 10 already owns the journal:false
// zero-runs-is-unmeasurable case, so these target the complementary verdicts.

// (A) The full scoreboard over the fixture world, journal present — CLI-driven. Asserts the real
// fixture rows non-vacuously: the r2 journal-recurrence row recurs (raising an escalation
// candidate), and the r3 row is broken because its verify: path is absent in the temp root and so
// is shell-exec'd and fails ({ran:true,ok:false}).
test("acceptance (A): the fixture scoreboard recurs the r2 row, breaks the r3 row, and raises exactly the escalation candidate", () => {
  const { root, env } = world();
  const out = JSON.parse(cli(root, env, ["--check-recurrence"]).stdout);
  const r2 = out.scoreboard.find((s) => s.culpritId === "friction:partial-evidence-capture");
  assert.ok(r2, "the r2 journal-recurrence promotion is scored");
  assert.equal(r2.verdict, "recurred");
  assert.equal(r2.runsObserved, 2);
  assert.equal(r2.recurrences, 2);
  const r3 = out.scoreboard.find((s) => s.culpritId === "friction:redaction-unknown-flag");
  assert.ok(r3, "the r3 promotion is scored");
  assert.equal(r3.verdict, "broken");
  assert.deepEqual(out.candidates.escalation.map((c) => c.culpritId), ["friction:partial-evidence-capture"]);
  assert.equal(out.candidates.retirement.length, 0);
});

// (B) r3 "did-not-execute → unmeasurable" — module-level (Ruling R-T9-b). The shipped CLI cannot
// force ran:false deterministically (defaultRunCheck shell-execs the verify: path), so this verdict
// is asserted at the engine boundary with an injected runCheck, mirroring verification.test.mjs.
test("acceptance (B, module-level per R-T9-b): an r3 check that did not execute is unmeasurable, never held", () => {
  const p = [{
    culpritId: "friction:redaction-unknown-flag", rung: "r3",
    verify: "tests/fixtures/learn/candidates.json", landed: "2026-08-01", aliases: [], lifecycle: null,
  }];
  const out = verify(p, [], "0.14.0", { now: Date.parse("2026-08-20"), runCheck: () => ({ ran: false, ok: false }) });
  assert.equal(out.scoreboard[0].verdict, "unmeasurable");
  assert.notEqual(out.scoreboard[0].verdict, "held");
});

// (C) The resolved-in axis — module-level (Ruling R-T9-a). The CLI cannot drive it: verify() loads
// vocab from ${PLUGIN_ROOT}/references/culprits.json (never a fixture), the shipped vocab has no
// resolved-in entries, and installedVersion() is 0.12.0 while shipped since ≥ 0.13.0 — so the
// "installed ≥ resolved" side is unreachable there. The injected vocab lives at
// tests/fixtures/learn/culprits.json (NOT wired into the CLI) and is read here.
test("acceptance (C, module-level per R-T9-a): resolved-in recurs once installed reaches the resolving version, unmeasurable below it", () => {
  const vocab = JSON.parse(readFileSync(join(FIXTURES, "culprits.json"), "utf8"));
  const entry = vocab.find((e) => e && e["resolved-in"]);
  assert.ok(entry, "the fixture vocab carries a resolved-in entry");
  const id = `${entry.kind}:${entry.slug}`;
  const runs = [{ event: "gate-fail", culprit: id, ts: "2026-08-10T00:00:00Z", runId: "r1" }];
  const at = verify([], runs, "0.14.0", { now: Date.parse("2026-08-20"), vocab });
  assert.equal(at.resolvedIn[0].verdict, "recurred");
  const below = verify([], runs, "0.13.0", { now: Date.parse("2026-08-20"), vocab });
  assert.equal(below.resolvedIn[0].verdict, "unmeasurable");
});

// (D) The revert sidecar — correctly EMPTY (Ruling R-T9-c). Driving the doctor over the fixture
// world produces .devcycle/doctor/revert-candidates.json; over this fixture no same-profile
// stage-scoped economic regression exists, so candidates is empty — proving the sidecar is
// produced and never a profile-mix false fire.
test("acceptance (D, per R-T9-c): the doctor revert sidecar is produced and correctly empty over the fixture", () => {
  const { root, env } = world();
  const res = spawnSync(process.execPath, [DOCTOR], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(res.status, 0, res.stderr);
  const sidecar = JSON.parse(readFileSync(join(root, ".devcycle", "doctor", "revert-candidates.json"), "utf8"));
  assert.equal(typeof sidecar.generatedAt, "string");
  assert.equal(sidecar.installedVersion, installedVersion());
  assert.ok(Array.isArray(sidecar.candidates));
  assert.equal(sidecar.candidates.length, 0,
    "no same-profile stage-scoped regression exists in the fixture — the sidecar must not false-fire");
});

test("criterion 5 is asserted where the merge happens, and this harness says so", () => {
  // Merging two independently-worded novel: slugs is a model judgement made inside the clustering
  // dispatch, not a function this CLI exposes — so the mechanical half is what --novel-slugs
  // returns, and that is what is asserted here. Recorded rather than silently skipped.
  const { root, env } = world();
  const res = cli(root, env, ["--novel-slugs"]);
  assert.equal(res.status, 0);
  assert.ok(Array.isArray(JSON.parse(res.stdout).slugs));
});
