// Metric computation and safety rules in scripts/session-metrics.mjs, exercised
// against synthetic transcripts. No real session transcript is ever read.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  parseArgs, isDevcycleSession, contextDepth, costUnits, median,
  summarizeSession, formatReport,
} from "../../scripts/session-metrics.mjs";

const SCRIPT = new URL("../../scripts/session-metrics.mjs", import.meta.url).pathname;

const usage = (i, cw, cr, o) => ({
  input_tokens: i, cache_creation_input_tokens: cw,
  cache_read_input_tokens: cr, output_tokens: o,
});
const turn = (over = {}) => ({
  sessionId: "sess-abcdef123456", isSidechain: false, type: "assistant",
  timestamp: "2026-07-20T10:00:00.000Z", cwd: "/secret/project/path",
  gitBranch: "secret-branch",
  message: { model: "claude-opus-5", usage: usage(10, 100, 1000, 20) },
  ...over,
});

// --- pure helpers ---

test("parseArgs: defaults resolve the transcript dir under the home directory", () => {
  const a = parseArgs([]);
  assert.equal(a.json, false);
  assert.equal(a.since, null);
  assert.equal(a.until, null);
  assert.match(a.dir, /\.claude[/\\]projects$/);
});

test("parseArgs: every flag is read", () => {
  const a = parseArgs(["--dir", "/tmp/x", "--since", "2026-07-01", "--until", "2026-07-31", "--json"]);
  assert.deepEqual(a, { dir: "/tmp/x", since: "2026-07-01", until: "2026-07-31", json: true });
});

test("isDevcycleSession: a devcycle attributionSkill includes the session", () => {
  assert.equal(isDevcycleSession([turn({ attributionSkill: "devcycle:executing-waves" })]), true);
});

test("isDevcycleSession: another plugin's bare skill name does not include it", () => {
  assert.equal(isDevcycleSession([turn({ attributionSkill: "graphify" })]), false);
  assert.equal(isDevcycleSession([turn({ attributionSkill: "superpowers:brainstorming" })]), false);
});

test("isDevcycleSession: a Skill tool call naming a devcycle skill includes the session", () => {
  const rec = turn({ message: { model: "claude-opus-5", usage: usage(1, 1, 1, 1),
    content: [{ type: "tool_use", name: "Skill", input: { skill: "devcycle:fast-path" } }] } });
  assert.equal(isDevcycleSession([rec]), true);
});

test("contextDepth: sums the three input-side counters and ignores output", () => {
  assert.equal(contextDepth(usage(10, 100, 1000, 999)), 1110);
});

test("costUnits: applies the benchmark weighting", () => {
  // 10 + 1.25*100 + 0.1*1000 + 5*20 = 10 + 125 + 100 + 100 = 335
  assert.equal(costUnits(usage(10, 100, 1000, 20), "claude-opus-5"), 335);
});

test("costUnits: a non-Opus turn is weighted x0.2", () => {
  assert.equal(costUnits(usage(10, 100, 1000, 20), "claude-sonnet-5"), 67);
});

test("median: odd and even lengths", () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), 0);
});

test("summarizeSession: splits main thread from subagents and counts the tool mix", () => {
  const recs = [
    turn({ attributionSkill: "devcycle:executing-waves" }),
    turn({ isSidechain: true }),
    turn({ isSidechain: true }),
    turn({ message: { model: "claude-opus-5", usage: usage(0, 0, 0, 0),
      content: [{ type: "tool_use", name: "Bash", input: {} }, { type: "tool_use", name: "Read", input: {} }] } }),
    turn({ message: { model: "claude-opus-5", usage: usage(0, 0, 0, 0),
      content: [{ type: "tool_use", name: "Bash", input: {} }] } }),
  ];
  const s = summarizeSession("sess-abcdef123456", recs);
  assert.equal(s.turns, 5);
  assert.equal(s.mainTurns, 3);
  assert.equal(s.subagentTurns, 2);
  assert.equal(s.tools.Bash, 2);
  assert.equal(s.tools.Read, 1);
  assert.equal(s.maxDepth, 1110);
});

test("summarizeSession: identifies the session by id prefix only", () => {
  const s = summarizeSession("sess-abcdef123456", [turn({ attributionSkill: "devcycle:cycle" })]);
  assert.equal(s.id.length <= 8, true);
  assert.equal("sess-abcdef123456".startsWith(s.id), true);
});

test("formatReport: discloses the sticky-attribution limitation", () => {
  const out = formatReport([summarizeSession("sess-abcdef123456", [turn({ attributionSkill: "devcycle:cycle" })])]);
  assert.match(out, /sticky/i);
});

// --- end to end over a synthetic transcript directory ---

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), "session-metrics-"));
  const proj = join(dir, "-some-project");
  mkdirSync(proj, { recursive: true });
  const lines = [
    turn({ attributionSkill: "devcycle:executing-waves",
      message: { model: "claude-opus-5", usage: usage(10, 100, 1000, 20),
        content: [{ type: "text", text: "SECRETMESSAGEBODY" }] } }),
    turn({ isSidechain: true, timestamp: "2026-07-20T11:00:00.000Z" }),
  ];
  writeFileSync(join(proj, "sess-abcdef123456.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  // A session with no devcycle marker at all — must be filtered out.
  writeFileSync(join(proj, "sess-999999999999.jsonl"),
    JSON.stringify(turn({ sessionId: "sess-999999999999", attributionSkill: "graphify" })) + "\n");
  return dir;
}

const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

test("cli: reports the devcycle session and filters out the non-devcycle one", () => {
  const res = run(["--dir", fixtureDir()]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /sess-abc/);
  assert.doesNotMatch(res.stdout, /999999999999/);
});

test("cli: output leaks no message text, no project path, and no branch name", () => {
  const res = run(["--dir", fixtureDir()]);
  assert.doesNotMatch(res.stdout, /SECRETMESSAGEBODY/);
  assert.doesNotMatch(res.stdout, /secret-branch/);
  assert.doesNotMatch(res.stdout, /\/secret\/project/);
  assert.doesNotMatch(res.stdout, /\/Users\//);
});

test("cli: --json emits parseable JSON carrying the same totals", () => {
  const dir = fixtureDir();
  const res = run(["--dir", dir, "--json"]);
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.sessions.length, 1);
  assert.equal(parsed.sessions[0].turns, 2);
});

test("cli: --since excludes records before the window", () => {
  const res = run(["--dir", fixtureDir(), "--since", "2026-08-01"]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /no sessions/i);
});

// Session membership is a property of the whole transcript, so the marker sits on a
// record that a mid-session --since excludes.
function markerBeforeWindowDir() {
  const dir = mkdtempSync(join(tmpdir(), "session-metrics-window-"));
  const proj = join(dir, "-some-project");
  mkdirSync(proj, { recursive: true });
  const lines = [
    turn({ timestamp: "2026-07-01T09:00:00.000Z", attributionSkill: "devcycle:executing-waves" }),
    turn({ timestamp: "2026-07-20T10:00:00.000Z" }),
    turn({ timestamp: "2026-07-31T10:00:00.000Z" }),
  ];
  writeFileSync(join(proj, "sess-abcdef123456.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return dir;
}

test("cli: a devcycle marker before the window still keeps the session, measuring only in-window records", () => {
  const res = run(["--dir", markerBeforeWindowDir(), "--since", "2026-07-15", "--json"]);
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.sessions.length, 1);
  assert.equal(parsed.sessions[0].turns, 2);
  assert.equal(parsed.totals.turns, 2);
});

test("cli: a devcycle session with no in-window records drops out entirely", () => {
  const res = run(["--dir", markerBeforeWindowDir(), "--since", "2026-08-01"]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /no sessions/i);
});

test("cli: an unreadable --dir fails loudly rather than reporting zero", () => {
  const res = run(["--dir", join(tmpdir(), "does-not-exist-9d1f")]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /SESSION METRICS FAILED/);
});
