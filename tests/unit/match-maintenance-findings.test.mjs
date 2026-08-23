import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordMaintenanceFinding } from "../../scripts/maintenance-findings.mjs";

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
