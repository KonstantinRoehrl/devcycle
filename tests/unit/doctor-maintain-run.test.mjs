import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { hashSession } from "../../scripts/run-record.mjs";
import { readRunRecords, emitComplianceCandidates } from "../../scripts/doctor.mjs";

// A maintain pass mints its own run: a run row, a session row, lens-cost rows and the sweep rows,
// with no triage, workload or commit row. Doctor must read it without a compliance candidate.
test("a maintain-minted run reads cleanly and raises no workload or sensor candidate", () => {
  const dir = makeTempDir("runs-");
  const runId = "1".repeat(16), sessionId = "m".repeat(36);
  mkdirSync(join(dir, "repo-00000000"), { recursive: true });
  const rows = [
    { kind: "run", runId, schemaVersion: 1, pluginVersion: "0.33.0", pluginSha: "a".repeat(40),
      repoSlug: "repo-00000000", profile: "standard", knobs: {}, startedAt: "2026-11-22T12:00:00Z" },
    { kind: "session", runId, sessionHash: hashSession(sessionId) },
    { kind: "sweep-consent", runId, consentExecuting: false, consentCoverage: false },
    { kind: "lens-cost", runId, stage: "maintain", lens: "abstraction", cost: 0.42 },
    { kind: "sweep-count", runId, sweep: "dead-code", category: "over-exported", verified: 3, suspected: 1, cleared: 0 },
  ];
  writeFileSync(join(dir, "repo-00000000", `${runId}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const record = readRunRecords(dir).get(hashSession(sessionId));
  assert.ok(record, "the session's window is read");
  assert.equal(record.lensCosts.length, 1, "lens-cost rows still attach to the session window");
  const types = emitComplianceCandidates([], record).map((c) => c.type);
  assert.ok(!types.some((t) => /missing-workload|sensor-inactive/.test(t)), `unexpected: ${types.join(", ")}`);
});
