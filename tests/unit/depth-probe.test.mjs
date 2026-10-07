import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { transcriptStats, resolveDepth, windowFor, depthLine, ASSUMED_WINDOW } from "../../scripts/depth-probe.mjs";

const SCRIPT = new URL("../../scripts/depth-probe.mjs", import.meta.url).pathname;
const usage = (i, cc, cr, o) => ({ input_tokens: i, cache_creation_input_tokens: cc, cache_read_input_tokens: cr, output_tokens: o });
const assistant = (model, u, ts, content = []) => ({ type: "assistant", timestamp: ts, message: { model, usage: u, content } });

function writeJsonl(path, records) {
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

test("transcriptStats: final depth, model, tool uses and duration from one subagent transcript", () => {
  const dir = makeTempDir("depth-probe");
  const file = join(dir, "agent-a1.jsonl");
  writeJsonl(file, [
    { type: "user", timestamp: "2026-10-07T07:18:05.680Z", message: { content: "go" } },
    assistant("claude-haiku-4-5-20251001", usage(8, 100, 0, 5), "2026-10-07T07:18:07.000Z",
      [{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
    assistant("claude-haiku-4-5-20251001", usage(8, 1986, 14155, 38), "2026-10-07T07:18:12.261Z",
      [{ type: "text", text: "PONG" }]),
  ]);
  assert.deepEqual(transcriptStats(file), { depth: 16149, model: "claude-haiku-4-5-20251001", toolUses: 1, durationMs: 6581 });
});

test("transcriptStats: a transcript with no usage record is null", () => {
  const dir = makeTempDir("depth-probe");
  const file = join(dir, "agent-a2.jsonl");
  writeJsonl(file, [{ type: "user", timestamp: "2026-10-07T07:18:05.680Z", message: { content: "go" } }]);
  assert.equal(transcriptStats(file), null);
});

test("windowFor: an unpriced model is measured against an assumed window and says so", () => {
  assert.deepEqual(windowFor("claude-mythos-9"), { window: ASSUMED_WINDOW, windowAssumed: true });
});

test("resolveDepth: --agent resolves <session>/subagents/agent-<id>.jsonl under the cwd slug", () => {
  const root = makeTempDir("depth-probe-root");
  const cwd = "/work/repo";
  const sessionDir = join(root, cwd.replaceAll("/", "-"), "sess-1", "subagents");
  mkdirSync(sessionDir, { recursive: true });
  writeJsonl(join(sessionDir, "agent-abc123.jsonl"), [assistant("claude-opus-5", usage(100, 200, 300, 5), "2026-10-07T07:00:00Z")]);
  const r = resolveDepth({ CLAUDE_CODE_SESSION_ID: "sess-1", CLAUDE_DOCTOR_PROJECTS: root }, cwd, { agentId: "abc123" });
  assert.equal(r.depth, 600);
  assert.equal(r.band, "ok");
});

test("depthLine: an assumed window is labelled with the file that would fix it", () => {
  const line = depthLine({ depth: 600, model: "claude-mythos-9", window: ASSUMED_WINDOW, windowAssumed: true, fraction: 0.0006, band: "ok" });
  assert.equal(line, "depth: 600 tokens (0.1% of 1000000, model claude-mythos-9, window assumed — model not in scripts/pricing.mjs) — band: ok");
});

test("cli: --transcript prints one depth line and exits 0", () => {
  const dir = makeTempDir("depth-probe");
  const file = join(dir, "t.jsonl");
  writeJsonl(file, [assistant("claude-opus-5", usage(52340, 0, 100000, 9), "2026-10-07T07:00:00Z")]);
  const r = spawnSync(process.execPath, [SCRIPT, "--transcript", file], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "depth: 152340 tokens (15.2% of 1000000, model claude-opus-5) — band: over-budget");
});

test("cli: a failure exits 1 with one depth-probe line on stderr", () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", env: { ...process.env, CLAUDE_CODE_SESSION_ID: "" } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^depth-probe: CLAUDE_CODE_SESSION_ID is not set/);
});
