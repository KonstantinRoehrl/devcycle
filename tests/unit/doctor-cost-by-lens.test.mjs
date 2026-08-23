import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { summarizeSession, lensCostTable } from "../../scripts/doctor.mjs";

const hashSession = (s) => createHash("sha256").update(s).digest("hex");

// A minimal session with one priced turn, plus a run record carrying two lens-cost lines.
const sessionId = "s".repeat(64);
const turn = {
  type: "assistant", timestamp: "2026-08-22T10:00:00Z", isSidechain: false,
  message: { model: "claude-opus-4-8", usage: { input_tokens: 10, output_tokens: 10 }, content: [] },
};
const record = {
  runId: "0".repeat(16), pluginVersion: "0.15.0", profile: "thorough", knobs: {},
  stages: [], dispatches: [], verdicts: [], events: [], workloads: [], workload: null,
  lensCosts: [
    { kind: "lens-cost", runId: "0".repeat(16), stage: "maintain", lens: "abstraction", cost: 0.42 },
    { kind: "lens-cost", runId: "0".repeat(16), stage: "maintain", lens: "history", cost: 0.10 },
  ],
};

test("summarizeSession builds costByLens from the run record's lensCosts", () => {
  const s = summarizeSession(sessionId, [turn], new Map([[hashSession(sessionId), record]]));
  assert.equal(s.costByLens.abstraction, 0.42);
  assert.equal(s.costByLens.history, 0.10);
});

test("lensCostTable aggregates + sorts a fixture pass, cost desc", () => {
  const s = summarizeSession(sessionId, [turn], new Map([[hashSession(sessionId), record]]));
  const rows = lensCostTable([s]);
  assert.deepEqual(rows.map((r) => r.lens), ["abstraction", "history"]);
  assert.equal(rows[0].total, 0.42);
});
