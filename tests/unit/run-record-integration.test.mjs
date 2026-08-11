import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordPath, hashSession } from "../../scripts/run-record.mjs";
import { readRunRecords, summarizeSession } from "../../scripts/doctor.mjs";

const SCRIPT = new URL("../../scripts/run-record.mjs", import.meta.url).pathname;

function runRecord(args, runsDir) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, DEVCYCLE_RUNS_DIR: runsDir },
  });
}

test("a real run/session/dispatch/verdict/commit chain, written via the real CLI, joins in doctor's read path — not forward-filled", () => {
  const runs = mkdtempSync(join(tmpdir(), "runs-"));
  const repo = "/tmp/acceptance-demo";
  const sessionId = ["11111111", "2222", "3333", "4444", "555555555555"].join("-");

  const runId = runRecord(
    ["new", "--repo", repo, "--plugin-version", "0.13.0", "--plugin-sha", "ded29c6a1b2c3d4e5f6",
     "--profile", "thorough"], runs
  ).stdout.trim();
  assert.match(runId, /^[0-9a-f]{16}$/);

  const startedAt = "2026-08-11T10:00:00Z", endedAt = "2026-08-11T10:05:00Z";
  for (const args of [
    ["append", "--run", runId, "--repo", repo, "--kind", "session", "--sessionId", sessionId],
    ["append", "--run", runId, "--repo", repo, "--kind", "stage", "--stage", "execution",
     "--startedAt", startedAt, "--endedAt", endedAt, "--outcome", "complete"],
    ["append", "--run", runId, "--repo", repo, "--kind", "dispatch", "--taskId", "49",
     "--agentType", "devcycle:implementer", "--model", "claude-sonnet-5",
     "--modelSource", "explicit", "--startedAt", startedAt, "--endedAt", endedAt,
     "--outcome", "complete", "--reviewRound", "0", "--retryIndex", "0"],
    ["append", "--run", runId, "--repo", repo, "--kind", "verdict", "--taskId", "49",
     "--round", "1", "--blockingCount", "0", "--evidenceClass", "red-green",
     "--conformance", "pass"],
    ["append", "--run", runId, "--repo", repo, "--kind", "commit", "--taskId", "49",
     "--sha", "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d"],
  ]) {
    const r = runRecord(args, runs);
    assert.strictEqual(r.status, 0, `${args.join(" ")}\n${r.stderr}`);
  }

  const byHash = readRunRecords(runs); // doctor.mjs reads DEVCYCLE_RUNS_DIR the same way
  const record = byHash.get(hashSession(sessionId));
  assert.ok(record, "the written chain must be readable back by hashed session id");
  assert.strictEqual(record.pluginVersion, "0.13.0");
  assert.strictEqual(record.dispatches.length, 1);
  assert.strictEqual(record.verdicts.length, 1);

  // A turn timestamped inside the dispatch window, with no transcript-extractable plugin version,
  // must attribute via the record — not fall back to forward-fill.
  const turns = [{
    timestamp: "2026-08-11T10:02:00Z", isSidechain: false,
    message: { model: "claude-sonnet-5", usage: {}, content: [] },
  }];
  const summary = summarizeSession(sessionId, turns, byHash);
  assert.strictEqual(summary.attributionSource, "record");
  assert.strictEqual(summary.pluginVersion, "0.13.0");
});
