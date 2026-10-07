import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
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

// Sonnet 4.5 and Opus 4.1 ran a 200k window: measured against the assumed 1M, 190k would read as
// 19% (over-budget) instead of 95% of the window. An unknown window must stay unknown.
test("windowFor: an older member of a priced family has no knowable window, never the assumed one", () => {
  assert.equal(windowFor("claude-sonnet-4-5-20250929"), null);
  assert.equal(windowFor("claude-opus-4-1-20250805"), null);
  assert.equal(windowFor("claude-3-5-sonnet-20241022"), null);
});

test("windowFor: every current canonical id resolves to its priced or provisional window", () => {
  assert.deepEqual(windowFor("claude-opus-5-5"), { window: 1_000_000 });
  assert.deepEqual(windowFor("claude-fable-5-1"), { window: 1_000_000 });
  assert.deepEqual(windowFor("claude-sonnet-5-5"), { window: 1_000_000 });
  assert.deepEqual(windowFor("claude-haiku-4-5-20251001"), { window: 200_000 });
  assert.deepEqual(windowFor("claude-haiku-4-5"), { window: 200_000, windowProvisionalAs: "claude-haiku-4-5-20251001" });
  assert.deepEqual(windowFor("claude-opus-6"), { window: 1_000_000, windowProvisionalAs: "claude-opus-5-5" });
});

// Hosting platforms and Claude Code wrap the id they report; the wrapped model is still the priced one.
test("windowFor: a wrapped id of a priced model resolves to that model's window", () => {
  assert.deepEqual(windowFor("claude-opus-5-5[1m]"), { window: 1_000_000 });
  assert.deepEqual(windowFor("us.anthropic.claude-opus-5-5-v1:0"), { window: 1_000_000 });
  assert.deepEqual(windowFor("claude-opus-5-5@20260901"), { window: 1_000_000 });
  assert.equal(windowFor("us.anthropic.claude-sonnet-4-5-20250929-v1:0"), null);
});

test("windowFor: an id that does not parse as a family and version falls back to the assumed window", () => {
  assert.deepEqual(windowFor("claude-opus-6-preview"), { window: ASSUMED_WINDOW, windowAssumed: true });
});

// A dated snapshot of a priced version is that version: its window is known, not unknown.
test("windowFor: a dated snapshot of a priced version takes that version's window", () => {
  assert.deepEqual(windowFor("claude-opus-4-8-20260101"), { window: 1_000_000, windowProvisionalAs: "claude-opus-4-8" });
});

test("cli: an unpriced version between two priced ones is not called older than every priced model", () => {
  const dir = makeTempDir("depth-probe");
  const file = join(dir, "t.jsonl");
  writeJsonl(file, [assistant("claude-opus-5-1", usage(10, 0, 0, 1), "2026-10-07T07:00:00Z")]);
  const r = spawnSync(process.execPath, [SCRIPT, "--transcript", file], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.equal(r.stderr, "depth-probe: no context window known for claude-opus-5-1 (not priced, and older than its " +
    "family's newest priced model; add it to scripts/pricing.mjs) — 10 tokens, band unknown\n");
});

test("cli: an older model of a priced family exits 1 with its depth unbanded", () => {
  const dir = makeTempDir("depth-probe");
  const file = join(dir, "t.jsonl");
  writeJsonl(file, [assistant("claude-sonnet-4-5-20250929", usage(90000, 0, 100000, 9), "2026-10-07T07:00:00Z")]);
  const r = spawnSync(process.execPath, [SCRIPT, "--transcript", file], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^depth-probe: no context window known for claude-sonnet-4-5-20250929 .*190000 tokens/);
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

test("cli: a --transcript that does not exist says so, not that it holds no usage record", () => {
  const missing = join(makeTempDir("depth-probe"), "nonexistent.jsonl");
  const r = spawnSync(process.execPath, [SCRIPT, "--transcript", missing], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.equal(r.stderr, `depth-probe: transcript not found: ${missing}\n`);
});

// doctor.mjs and hooks/dispatch-sensor.mjs import this module, so its main-entry gate runs under
// any argv[1] — including one that names no file.
test("import: an entry path that does not exist does not throw", () => {
  const r = spawnSync(process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(SCRIPT).href)})`, "no-such-entry"],
    { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});
