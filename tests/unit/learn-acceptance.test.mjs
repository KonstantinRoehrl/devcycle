import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoSlug } from "../../scripts/run-record.mjs";

const SCRIPT = new URL("../../scripts/dream.mjs", import.meta.url).pathname;
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
  for (const cand of c.candidates)
    if (cand.sensitive || cand.culpritId.startsWith("contradiction:"))
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

test("criterion 10: a promotion with no observed runs after it landed is unmeasurable", () => {
  const { root, env } = world({ journal: false });
  const out = JSON.parse(cli(root, env, ["--check-recurrence"]).stdout);
  assert.ok(out.results.length >= 1);
  for (const r of out.results) {
    assert.equal(r.runsObserved, 0);
    assert.equal(r.verdict, "unmeasurable");
  }
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

test("criterion 5 is asserted where the merge happens, and this harness says so", () => {
  // Merging two independently-worded novel: slugs is a model judgement made inside the clustering
  // dispatch, not a function this CLI exposes — so the mechanical half is what --novel-slugs
  // returns, and that is what is asserted here. Recorded rather than silently skipped.
  const { root, env } = world();
  const res = cli(root, env, ["--novel-slugs"]);
  assert.equal(res.status, 0);
  assert.ok(Array.isArray(JSON.parse(res.stdout).slugs));
});
