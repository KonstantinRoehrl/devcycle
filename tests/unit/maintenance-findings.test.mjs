import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
