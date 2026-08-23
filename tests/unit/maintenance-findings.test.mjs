import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  maintDir, findingId, validateMaintenanceFinding, recordMaintenanceFinding,
  readMaintenanceFindings, findMaintenanceFindingById, rankByTrending,
} from "../../scripts/maintenance-findings.mjs";

const root = () => mkdtempSync(join(tmpdir(), "maint-"));
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

test("round-trips a github-issue record keyed by issue number", () => {
  const r = root();
  recordMaintenanceFinding(r, {
    findingKind: "github-issue", findingId: "github-issue:44", issue: 44,
    title: "version sort is lexicographic", severity: "high", confidence: "verified",
    affectedFiles: ["scripts/doctor.mjs"], firstSeen: "2026-08-22", lastSeen: "2026-08-22", passes: 1,
    origin: "github-issue #44",
  });
  const [rec] = readMaintenanceFindings(r);
  assert.equal(rec.findingKind, "github-issue");
  assert.equal(rec.issue, 44);
  assert.equal(findMaintenanceFindingById(readMaintenanceFindings(r), "github-issue:44").issue, 44);
});

test("dismissed requires a load-bearing reason", () => {
  assert.throws(() => validateMaintenanceFinding({ ...base, lifecycle: "dismissed" }), /load-bearing/);
  assert.doesNotThrow(() => validateMaintenanceFinding({ ...base, lifecycle: "dismissed", dismissedReason: "volatility boundary for payments" }));
});

test("github-issue finding-id must match its issue number", () => {
  assert.throws(() => validateMaintenanceFinding({
    findingKind: "github-issue", findingId: "github-issue:9", issue: 44,
    title: "x", severity: "low", confidence: "suspected",
    affectedFiles: [], firstSeen: "2026-08-22", lastSeen: "2026-08-22", passes: 1,
  }), /github-issue finding-id/);
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
