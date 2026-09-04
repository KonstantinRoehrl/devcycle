import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordMaintenanceFinding, matchMaintenanceFindings } from "../../scripts/maintenance-findings.mjs";

const DREAM = fileURLToPath(new URL("../../scripts/dream.mjs", import.meta.url));
const match = (root, files) =>
  execFileSync("node", [DREAM, "--match", "--stage", "audit", "--files", files], { encoding: "utf8", cwd: root });

const persisting = {
  findingKind: "maintenance-finding", findingId: "dead-abstraction:beef0001", culpritKind: "dead-abstraction",
  title: "pass-through wrapper", severity: "high", confidence: "verified",
  affectedFiles: ["scripts/wrap.mjs"], firstSeen: "2026-08-10", lastSeen: "2026-08-22", passes: 3,
};

test("a file with a persisting finding surfaces it via --match", () => {
  const root = mkdtempSync(join(tmpdir(), "match-"));
  recordMaintenanceFinding(root, persisting);
  const out = match(root, "scripts/wrap.mjs");
  assert.match(out, /persisting since 2026-08-10 \(3 passes\)/);
  assert.match(out, /dead-abstraction:beef0001/);
});

test("a file with no persisting finding surfaces nothing extra (silent-when-absent)", () => {
  const root = mkdtempSync(join(tmpdir(), "match-"));
  recordMaintenanceFinding(root, persisting);
  const out = match(root, "scripts/unrelated.mjs");
  assert.doesNotMatch(out, /dead-abstraction:beef0001/);
});

test("a new (one-pass) finding is not surfaced — persisting only", () => {
  const root = mkdtempSync(join(tmpdir(), "match-"));
  recordMaintenanceFinding(root, { ...persisting, findingId: "dead-abstraction:beef0002", passes: 1 });
  const out = match(root, "scripts/wrap.mjs");
  assert.doesNotMatch(out, /dead-abstraction:beef0002/);
});

test("matchMaintenanceFindings keeps a critical finding past the cap (M4)", () => {
  const mk = (findingId, severity) => ({
    findingId,
    severity,
    confidence: "verified",
    passes: 2,
    firstSeen: "2026-08-01",
    lifecycle: null,
    affectedFiles: ["scripts/target.mjs"],
  });
  // Six persisting matches; the sole critical is LAST in input (filename) order,
  // so the old filename-order slice(0, 5) dropped it.
  const records = [
    mk("low:1", "low"),
    mk("low:2", "low"),
    mk("low:3", "low"),
    mk("low:4", "low"),
    mk("low:5", "low"),
    mk("critical:9", "critical"),
  ];
  const out = matchMaintenanceFindings({ records, files: ["scripts/target.mjs"], cap: 5 });
  assert.equal(out.length, 5);
  assert.ok(out.some((r) => r.severity === "critical"), "the critical finding must survive the cap");
  assert.equal(out[0].severity, "critical", "critical ranks first after the sort");
});
