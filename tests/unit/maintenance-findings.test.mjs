import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import {
  maintDir, findingId, validateMaintenanceFinding, recordMaintenanceFinding,
  readMaintenanceFindings, findMaintenanceFindingById, rankByTrending,
  removeMaintenanceFinding, parseMaintenanceFinding, matchMaintenanceFindings,
} from "../../scripts/maintenance-findings.mjs";

const root = () => makeTempDir("maint-");
const base = {
  findingKind: "maintenance-finding", findingId: "dead-code:a1b2c3d4", culpritKind: "dead-code",
  title: "Unreachable helper", severity: "medium", confidence: "verified",
  affectedFiles: ["scripts/x.mjs"], firstSeen: "2026-08-22", lastSeen: "2026-08-22", passes: 1,
};

test("findingId is line-agnostic and deterministic", () => {
  assert.equal(findingId("dead-code", "scripts/x.mjs#helper"), findingId("dead-code", "scripts/x.mjs#helper"));
  assert.notEqual(findingId("dead-code", "scripts/x.mjs#helper"), findingId("dead-code", "scripts/y.mjs#helper"));
  assert.match(findingId("dead-code", "scripts/x.mjs#helper"), /^dead-code:[0-9a-f]{8}$/);
  assert.throws(() => findingId("Dead Code", "x"), /invalid culprit-kind/);
});

test("round-trips a maintenance-finding record", () => {
  const r = root();
  recordMaintenanceFinding(r, base);
  const [rec] = readMaintenanceFindings(r);
  assert.equal(rec.findingKind, "maintenance-finding");
  assert.equal(rec.findingId, "dead-code:a1b2c3d4");
  assert.equal(rec.passes, 1);
  assert.deepEqual(rec.affectedFiles, ["scripts/x.mjs"]);
  assert.equal(rec.lifecycle, null);
});

test("record is idempotent by id — a re-record overwrites, one file", () => {
  const r = root();
  recordMaintenanceFinding(r, base);
  recordMaintenanceFinding(r, { ...base, passes: 2, lastSeen: "2026-08-23" });
  const recs = readMaintenanceFindings(r);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].passes, 2);
});

test("removeMaintenanceFinding deletes a resolved finding's file", () => {
  const r = root();
  const path = recordMaintenanceFinding(r, base);
  assert.ok(existsSync(path));
  const removed = removeMaintenanceFinding(r, base.findingId);
  assert.equal(removed, path);
  assert.equal(existsSync(path), false);
  assert.equal(readMaintenanceFindings(r).length, 0);
});

test("removeMaintenanceFinding is idempotent — a missing file is a no-op, not an error", () => {
  const r = root();
  assert.equal(removeMaintenanceFinding(r, "dead-code:doesnotexist"), null);
});

test("dismissed requires a load-bearing reason", () => {
  assert.throws(() => validateMaintenanceFinding({ ...base, lifecycle: "dismissed" }), /load-bearing/);
  assert.doesNotThrow(() => validateMaintenanceFinding({ ...base, lifecycle: "dismissed", dismissedReason: "volatility boundary for payments" }));
});

test("findMaintenanceFindingById resolves via filename-slug fallback", () => {
  const r = root();
  recordMaintenanceFinding(r, base);
  assert.equal(findMaintenanceFindingById(readMaintenanceFindings(r), "dead-code-a1b2c3d4").findingId, "dead-code:a1b2c3d4");
});

test("rankByTrending: severity primary, tie-break confidence→passes→first-seen within a tier", () => {
  const f = (over) => ({ findingId: over.findingId, severity: over.severity, confidence: over.confidence ?? "verified", passes: over.passes ?? 1, firstSeen: over.firstSeen ?? "2026-08-22" });
  const ranked = rankByTrending([
    f({ findingId: "a", severity: "low", passes: 9, firstSeen: "2020-01-01" }),   // old, persistent, but low
    f({ findingId: "b", severity: "critical", passes: 1 }),                        // new critical
    f({ findingId: "c", severity: "medium", confidence: "suspected", passes: 5 }),
    f({ findingId: "d", severity: "medium", confidence: "verified", passes: 2 }),
  ]);
  assert.deepEqual(ranked.map((x) => x.findingId), ["b", "d", "c", "a"]);
});

const ACTIVE =
  "# Unreachable helper\n- finding-kind: maintenance-finding\n- finding-id: dead-code:a1b2c3d4\n" +
  "- culprit-kind: dead-code\n- severity: medium\n- confidence: verified\n- affected-files: scripts/x.mjs\n" +
  "- first-seen: 2026-08-22\n- last-seen: 2026-08-22\n- passes: 1\n- verify: \n";
const DISMISSED = ACTIVE + "- lifecycle: dismissed\n- dismissed-reason: volatility boundary for payments\n";
const LEGACY_RESOLVED =
  "# Old helper\n- finding-kind: maintenance-finding\n- finding-id: dead-code:a1b2c3d4\n" +
  "- culprit-kind: dead-code\n- severity: medium\n- confidence: verified\n- affected-files: scripts/x.mjs\n" +
  "- first-seen: 2026-08-01\n- last-seen: 2026-08-10\n- passes: 3\n- origin: lens\n- verify: \n" +
  "- lifecycle: resolved\n- dismissed-reason: \n";
const put = (r, name, text) => {
  mkdirSync(maintDir(r), { recursive: true });
  writeFileSync(join(maintDir(r), name), text);
};

test("the validator rejects a blank or whitespace-only title", () => {
  assert.throws(() => validateMaintenanceFinding({ ...base, title: "" }), /blank title/);
  assert.throws(() => validateMaintenanceFinding({ ...base, title: "   " }), /blank title/);
});

test("the validator accepts no lifecycle but dismissed", () => {
  assert.throws(() => validateMaintenanceFinding({ ...base, lifecycle: "resolved" }), /invalid lifecycle/);
});

test("the validator rejects the retired github-issue kind", () => {
  assert.throws(() => validateMaintenanceFinding({ ...base, findingKind: "github-issue" }), /finding-kind/);
});

test("an active record is written with no lifecycle, dismissed-reason, or origin line", () => {
  const r = root();
  assert.equal(readFileSync(recordMaintenanceFinding(r, base), "utf8"), ACTIVE);
});

test("a read → write round-trip is byte-identical for an active and a dismissed record", () => {
  for (const text of [ACTIVE, DISMISSED]) {
    const r = root();
    put(r, "fixture.md", text);
    const [rec] = readMaintenanceFindings(r);
    assert.equal(readFileSync(recordMaintenanceFinding(r, rec), "utf8"), text);
  }
});

test("the reader maps no origin or issue field", () => {
  const r = root();
  put(r, "legacy.md", LEGACY_RESOLVED);
  const [rec] = readMaintenanceFindings(r);
  assert.equal("origin" in rec, false);
  assert.equal("issue" in rec, false);
  assert.equal(rec.lifecycle, "resolved", "a legacy lifecycle is read as-is");
});

test("--match still skips a legacy resolved record", () => {
  const r = root();
  put(r, "legacy.md", LEGACY_RESOLVED);
  assert.deepEqual(matchMaintenanceFindings({ records: readMaintenanceFindings(r), files: ["scripts/x.mjs"] }), []);
});

test("every tracked record in this repo's store validates", () => {
  // Validate-only: a pass run by an older installed plugin that writes an issue shell or a blank
  // title fails here, which is the intended signal.
  const repo = fileURLToPath(new URL("../..", import.meta.url));
  const tracked = execFileSync("git", ["ls-files", "-z", "docs/devcycle/maintenance-findings"], { cwd: repo, encoding: "utf8" })
    .split("\0")
    .filter((p) => p.endsWith(".md") && !p.endsWith("/README.md"));
  assert.ok(tracked.length > 0, "the store has no tracked records, so this test would pass vacuously");
  for (const rel of tracked)
    assert.doesNotThrow(() => validateMaintenanceFinding(parseMaintenanceFinding(readFileSync(join(repo, rel), "utf8"), rel)), rel);
});

const CLI = fileURLToPath(new URL("../../scripts/maintenance-findings.mjs", import.meta.url));
const cli = (args, opts = {}) => spawnSync("node", [CLI, ...args], { encoding: "utf8", ...opts });
const entry = (over = {}) => ({
  culpritKind: "dead-code", canonicalLocation: "scripts/x.mjs#helper", title: "Unreachable helper",
  severity: "medium", confidence: "verified", affectedFiles: ["scripts/x.mjs"], ...over,
});
const passFile = (entries) => {
  const p = join(makeTempDir("pass-"), "pass.json");
  writeFileSync(p, typeof entries === "string" ? entries : JSON.stringify(entries));
  return p;
};
const apply = (r, entries, date, extra = []) => {
  const res = cli(["apply-pass", "--pass", passFile(entries), "--date", date, "--root", r, ...extra]);
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
};
const rejects = (r, args, pattern) => {
  const res = cli(["apply-pass", ...args, "--root", r]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, pattern);
};
const snapshot = (r) => existsSync(maintDir(r))
  ? readdirSync(maintDir(r)).sort().map((f) => [f, readFileSync(join(maintDir(r), f), "utf8")])
  : [];
const ID = findingId("dead-code", "scripts/x.mjs#helper");

test("apply-pass: a first sighting is new, written with passes 1", () => {
  const r = root();
  const out = apply(r, [entry()], "2026-09-01");
  assert.deepEqual(out.new.map((x) => [x.id, x.passes, x.firstSeen, x.lastSeen]), [[ID, 1, "2026-09-01", "2026-09-01"]]);
  assert.deepEqual(out.written, [`docs/devcycle/maintenance-findings/${ID.replace(":", "-")}.md`]);
  assert.equal(readMaintenanceFindings(r)[0].title, "Unreachable helper");
});

test("apply-pass: a same-day re-run stays new with no double increment", () => {
  const r = root();
  apply(r, [entry()], "2026-09-01");
  const out = apply(r, [entry()], "2026-09-01");
  assert.equal(out.new.length, 1);
  assert.equal(out.new[0].passes, 1);
});

test("apply-pass: persisting keeps first-seen, increments once per date, never lowers severity", () => {
  const r = root();
  apply(r, [entry()], "2026-09-01");
  const out = apply(r, [entry({ severity: "low", title: "Unreachable helper, renamed" })], "2026-09-08");
  assert.deepEqual(out.persisting.map((x) => [x.passes, x.firstSeen, x.lastSeen, x.severity, x.title]),
    [[2, "2026-09-01", "2026-09-08", "medium", "Unreachable helper, renamed"]]);
  assert.equal(apply(r, [entry()], "2026-09-08").persisting[0].passes, 2, "a same-date re-run is idempotent");
});

test("apply-pass: a persisting build clears a legacy resolved lifecycle", () => {
  const r = root();
  put(r, `${ID.replace(":", "-")}.md`, LEGACY_RESOLVED.replace("dead-code:a1b2c3d4", ID));
  const out = apply(r, [entry()], "2026-09-01");
  assert.deepEqual(out.persisting.map((x) => x.passes), [4]);
  assert.doesNotMatch(readFileSync(join(maintDir(r), `${ID.replace(":", "-")}.md`), "utf8"), /lifecycle|origin/);
});

test("apply-pass: a --date before a stored last-seen rejects the pass", () => {
  const r = root();
  apply(r, [entry()], "2026-09-08");
  rejects(r, ["--pass", passFile([entry()]), "--date", "2026-09-01"], /never move backwards/);
});

test("apply-pass: two entries deriving one id reject the pass", () => {
  rejects(root(), ["--pass", passFile([entry(), entry({ title: "dup" })]), "--date", "2026-09-01"], /duplicate finding-id/);
});

test("apply-pass: a missing mandatory field rejects the pass and leaves the store byte-identical", () => {
  const r = root();
  apply(r, [entry()], "2026-09-01");
  const before = snapshot(r);
  const { title, ...untitled } = entry({ canonicalLocation: "scripts/y.mjs#other" });
  void title;
  rejects(r, ["--pass", passFile([entry(), untitled]), "--date", "2026-09-08"], /entry 1: missing mandatory field title/);
  assert.deepEqual(snapshot(r), before);
});

test("apply-pass: without --resolve an undetected record is untouched, in no bucket, with no gaps", () => {
  const r = root();
  apply(r, [entry()], "2026-09-01");
  const out = apply(r, [entry({ canonicalLocation: "scripts/y.mjs#other" })], "2026-09-08");
  assert.ok(existsSync(join(maintDir(r), `${ID.replace(":", "-")}.md`)));
  assert.deepEqual([out.persisting, out.resolved, out.gaps, out.deleted], [[], [], [], []]);
});

test("apply-pass: with --resolve an undetected record is deleted and listed in gaps", () => {
  const r = root();
  apply(r, [entry()], "2026-09-01");
  const out = apply(r, [entry({ canonicalLocation: "scripts/y.mjs#other" })], "2026-09-08", ["--resolve"]);
  assert.deepEqual(out.resolved.map((x) => x.id), [ID]);
  assert.deepEqual(out.gaps.map((g) => g.id), [ID]);
  assert.deepEqual(out.deleted, [`docs/devcycle/maintenance-findings/${ID.replace(":", "-")}.md`]);
  assert.equal(existsSync(join(maintDir(r), `${ID.replace(":", "-")}.md`)), false);
});

test("apply-pass: --resolve retires a legacy github-issue shell, which is otherwise left alone", () => {
  const r = root();
  const shell = "# old issue\n- finding-kind: github-issue\n- finding-id: github-issue:44\n- issue: 44\n" +
    "- severity: low\n- confidence: verified\n- affected-files: x\n- first-seen: 2026-08-01\n" +
    "- last-seen: 2026-08-01\n- passes: 1\n- origin: github-issue #44\n- verify: \n- lifecycle: \n- dismissed-reason: \n";
  put(r, "github-issue-44.md", shell);
  assert.deepEqual(apply(r, [entry()], "2026-09-01").deleted, []);
  assert.ok(existsSync(join(maintDir(r), "github-issue-44.md")));
  const out = apply(r, [entry()], "2026-09-01", ["--resolve"]);
  assert.deepEqual(out.gaps.map((g) => g.id), ["github-issue:44"]);
  assert.equal(existsSync(join(maintDir(r), "github-issue-44.md")), false);
});

test("apply-pass: a dismissed record lands in dismissed and is not rewritten", () => {
  const r = root();
  const name = `${ID.replace(":", "-")}.md`;
  const text = DISMISSED.replace("dead-code:a1b2c3d4", ID);
  put(r, name, text);
  const out = apply(r, [entry()], "2026-09-01", ["--resolve"]);
  assert.deepEqual([out.dismissed.map((x) => x.id), out.written, out.resolved], [[ID], [], []]);
  assert.equal(readFileSync(join(maintDir(r), name), "utf8"), text);
});

test("apply-pass: --dry-run writes and deletes nothing", () => {
  const r = root();
  const out = apply(r, [entry()], "2026-09-01", ["--dry-run"]);
  assert.equal(out.new.length, 1);
  assert.deepEqual([out.written, snapshot(r)], [[], []]);
});

test("apply-pass: --root targets that tree, not the cwd", () => {
  const r = root();
  const res = cli(["apply-pass", "--pass", passFile([entry()]), "--date", "2026-09-01", "--root", r], { cwd: makeTempDir("elsewhere-") });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(readMaintenanceFindings(r).length, 1);
});

test("apply-pass: --dry-run --ref reads the store as committed at that ref", () => {
  const r = root();
  const git = (...args) => execFileSync("git", args, { cwd: r, encoding: "utf8" });
  git("init", "-q");
  apply(r, [entry()], "2026-09-01");
  assert.equal(readMaintenanceFindings(r).length, 1, "the pass wrote the record the commit captures");
  git("add", ".");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "store");
  const atWorktree = apply(r, [entry()], "2026-09-08", ["--dry-run"]);
  rmSync(maintDir(r), { recursive: true, force: true });
  const atRef = apply(r, [entry()], "2026-09-08", ["--dry-run", "--ref", "HEAD"]);
  assert.deepEqual(atRef, atWorktree);
  assert.equal(atRef.persisting[0].passes, 2);
});

test("apply-pass: --ref without --dry-run is refused", () => {
  rejects(root(), ["--pass", passFile([entry()]), "--date", "2026-09-01", "--ref", "HEAD"], /--ref .*--dry-run/);
});

test("apply-pass: malformed JSON, a missing --date, an unknown flag, or an unknown verb exit non-zero", () => {
  const r = root();
  rejects(r, ["--pass", passFile("[{"), "--date", "2026-09-01"], /pass file/);
  rejects(r, ["--pass", passFile([entry()])], /--date/);
  rejects(r, ["--pass", passFile([entry()]), "--date", "2026-09-01", "--bogus"], /unrecognised flag --bogus/);
  const res = cli(["frobnicate"]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /unknown verb "frobnicate"/);
});
