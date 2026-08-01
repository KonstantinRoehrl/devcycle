// Metric computation and safety rules in scripts/doctor.mjs, exercised
// against synthetic transcripts. No real session transcript is ever read.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  parseArgs, isDevcycleSession, contextDepth, costUSD, depthBand, median,
  summarizeSession, formatReport, budgetBand, resolveDepth,
} from "../../scripts/doctor.mjs";
import { PRICING } from "../../scripts/pricing.mjs";

const SCRIPT = new URL("../../scripts/doctor.mjs", import.meta.url).pathname;

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
  assert.deepEqual(a, { dir: "/tmp/x", since: "2026-07-01", until: "2026-07-31", json: true, all: false, depth: false });
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
  const dir = mkdtempSync(join(tmpdir(), "doctor-"));
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

const run = (args, env = {}, cwd = process.cwd()) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: "", ...env },
  });

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
  const dir = mkdtempSync(join(tmpdir(), "doctor-window-"));
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

// --- the corrected cost model, the depth bands, and the recursive walk ---

test("costUSD: the TTL split is billed at 2.00x (1h) and 1.25x (5m)", () => {
  // opus-5: $5/M in, $25/M out.
  // 1000*5 + 2000*5*2.00 + 4000*5*1.25 + 100000*5*0.10 + 500*25 = 112500 -> $0.1125
  const u = {
    input_tokens: 1000,
    cache_read_input_tokens: 100_000,
    output_tokens: 500,
    cache_creation_input_tokens: 6000,
    cache_creation: { ephemeral_1h_input_tokens: 2000, ephemeral_5m_input_tokens: 4000 },
  };
  assert.equal(costUSD(u, "claude-opus-5"), 0.1125);
});

test("costUSD: a flat cache_creation with no TTL breakdown bills at the 5m rate", () => {
  // sonnet-5: $2/M in, $10/M out. 10000*2*1.25 + 100*10 = 26000 -> $0.026
  const u = { input_tokens: 0, cache_creation_input_tokens: 10_000, output_tokens: 100 };
  assert.equal(costUSD(u, "claude-sonnet-5"), 0.026);
});

test("costUSD: fable costs double opus for identical usage, not a fifth", () => {
  const u = { input_tokens: 1_000_000 };
  assert.equal(costUSD(u, "claude-opus-5"), 5);
  assert.equal(costUSD(u, "claude-fable-5"), 10);
});

test("costUSD: an unpriced model returns null rather than a defaulted price", () => {
  assert.equal(costUSD({ input_tokens: 1_000_000 }, "claude-opus-9"), null);
});

test("depthBand: the six measured bands, at their boundaries", () => {
  assert.equal(depthBand(0), "0-50k");
  assert.equal(depthBand(49_999), "0-50k");
  assert.equal(depthBand(50_000), "50-100k");
  assert.equal(depthBand(100_000), "100-150k");
  assert.equal(depthBand(150_000), "150-200k");
  assert.equal(depthBand(200_000), "200-300k");
  assert.equal(depthBand(300_000), "300k+");
});

test("cli: a transcript under subagents/ is walked and attributed to its owning session", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-subagents-"));
  const slug = join(dir, "-Users-x-proj");
  mkdirSync(join(slug, "sess-aaaa", "subagents"), { recursive: true });
  writeFileSync(
    join(slug, "sess-aaaa.jsonl"),
    JSON.stringify(turn({ attributionSkill: "devcycle:executing-waves" })) + "\n",
  );
  writeFileSync(
    join(slug, "sess-aaaa", "subagents", "agent-bbbb.jsonl"),
    JSON.stringify(turn({ isSidechain: true })) + "\n",
  );
  const out = run(["--dir", dir]);
  assert.equal(out.status, 0, out.stderr);
  // A flat projects/*/*.jsonl glob sees one turn; the recursive walk must see two.
  assert.match(out.stdout, /turns 2/);
  assert.match(out.stdout, /subagent 1/);
});

test("cli: a <synthetic> record is skipped, not reported as an unpriced model", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-synthetic-"));
  const slug = join(dir, "-Users-x-proj");
  mkdirSync(slug, { recursive: true });
  writeFileSync(
    join(slug, "sess-cccc.jsonl"),
    JSON.stringify(turn({ attributionSkill: "devcycle:executing-waves" })) +
      "\n" +
      JSON.stringify({
        type: "assistant",
        message: {
          model: "<synthetic>",
          usage: usage(0, 0, 0, 0),
          content: [{ type: "text", text: "You've hit your session limit" }],
        },
      }) +
      "\n",
  );
  const out = run(["--dir", dir]);
  assert.equal(out.status, 0, out.stderr);
  assert.doesNotMatch(out.stdout, /UNPRICED/);
});

test("cli: an unpriced model gets its own line and is excluded from the dollar total", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-unpriced-"));
  const slug = join(dir, "-Users-x-proj");
  mkdirSync(slug, { recursive: true });
  writeFileSync(
    join(slug, "sess-dddd.jsonl"),
    JSON.stringify(turn({ attributionSkill: "devcycle:executing-waves" })) +
      "\n" +
      JSON.stringify({
        type: "assistant",
        message: { model: "claude-opus-9", usage: usage(1_000_000, 0, 0, 0), content: [] },
      }) +
      "\n",
  );
  const out = run(["--dir", dir]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /UNPRICED MODEL: claude-opus-9 \(1 requests?\)/);
});

test("formatReport: discloses the price vintage", () => {
  const text = formatReport([]);
  assert.match(text, new RegExp(`prices as of ${PRICING.asOf}`));
});

test("cli: a malformed trailing line is skipped rather than fatal", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-partial-"));
  const slug = join(dir, "-Users-x-proj");
  mkdirSync(slug, { recursive: true });
  writeFileSync(
    join(slug, "sess-eeee.jsonl"),
    JSON.stringify(turn({ attributionSkill: "devcycle:executing-waves" })) +
      "\n" +
      '{"type":"assistant","message":{"mod',
  );
  const out = run(["--dir", dir]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /turns 1/);
});

test("parseArgs: --all and --depth are read", () => {
  assert.equal(parseArgs(["--all"]).all, true);
  assert.equal(parseArgs(["--depth"]).depth, true);
  assert.equal(parseArgs([]).all, false);
  assert.equal(parseArgs([]).depth, false);
});

// --- the depth probe: budgetBand and resolveDepth ---

function turnWithUsage(model, u) {
  return { type: "assistant", message: { model, usage: u, content: [] } };
}

// Builds <root>/<slug-of-cwd>/<sessionId>.jsonl and returns both paths. cwd is a real
// directory (not a literal placeholder) so the CLI tests can spawnSync with it: the
// child process's working directory must actually exist on disk.
function depthFixture(sessionId, records) {
  const root = mkdtempSync(join(tmpdir(), "doctor-depth-"));
  const cwd = mkdtempSync(join(tmpdir(), "doctor-cwd-"));
  const slug = join(root, cwd.replaceAll("/", "-"));
  mkdirSync(slug, { recursive: true });
  writeFileSync(join(slug, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { root, cwd, slug };
}

test("budgetBand: 15% is over budget, 20% is a hard stop", () => {
  assert.equal(budgetBand(100_000, 1_000_000), "ok");
  assert.equal(budgetBand(149_999, 1_000_000), "ok");
  assert.equal(budgetBand(150_000, 1_000_000), "over-budget");
  assert.equal(budgetBand(199_999, 1_000_000), "over-budget");
  assert.equal(budgetBand(200_000, 1_000_000), "hard-stop");
});

test("budgetBand: the fractions adapt to a smaller context window", () => {
  // haiku's 200k window: 15% is 30k, not 150k.
  assert.equal(budgetBand(29_999, 200_000), "ok");
  assert.equal(budgetBand(30_000, 200_000), "over-budget");
  assert.equal(budgetBand(40_000, 200_000), "hard-stop");
});

test("resolveDepth: reads the last usage record of the session named by the env var", () => {
  const { root, cwd } = depthFixture("sess-1111", [
    turnWithUsage("claude-opus-5", usage(10, 20, 30, 5)),
    turnWithUsage("claude-opus-5", usage(100, 200, 300, 5)),
  ]);
  const r = resolveDepth(
    { CLAUDE_CODE_SESSION_ID: "sess-1111", CLAUDE_DOCTOR_PROJECTS: root },
    cwd,
  );
  assert.equal(r.depth, 600); // the LAST record: 100 + 200 + 300
  assert.equal(r.model, "claude-opus-5");
  assert.equal(r.window, 1_000_000);
  assert.equal(r.band, "ok");
});

test("resolveDepth: falls back to a filename search when the cwd slug does not match", () => {
  const { root } = depthFixture("sess-2222", [turnWithUsage("claude-sonnet-5", usage(0, 0, 160_000, 1))]);
  const r = resolveDepth(
    { CLAUDE_CODE_SESSION_ID: "sess-2222", CLAUDE_DOCTOR_PROJECTS: root },
    "/somewhere/else/entirely",
  );
  assert.equal(r.depth, 160_000);
  assert.equal(r.band, "over-budget");
});

test("resolveDepth: no session id is an explicit failure, not an unknown pass", () => {
  assert.throws(() => resolveDepth({}, "/tmp"), /CLAUDE_CODE_SESSION_ID/);
});

test("resolveDepth: no matching transcript is an explicit failure", () => {
  const { root, cwd } = depthFixture("sess-3333", [turnWithUsage("claude-opus-5", usage(1, 1, 1, 1))]);
  assert.throws(
    () => resolveDepth({ CLAUDE_CODE_SESSION_ID: "sess-none", CLAUDE_DOCTOR_PROJECTS: root }, cwd),
    /no transcript/i,
  );
});

test("resolveDepth: a transcript with no usage record is an explicit failure", () => {
  const { root, cwd } = depthFixture("sess-4444", [{ type: "user", message: { content: "hi" } }]);
  assert.throws(
    () => resolveDepth({ CLAUDE_CODE_SESSION_ID: "sess-4444", CLAUDE_DOCTOR_PROJECTS: root }, cwd),
    /no usage record/i,
  );
});

test("cli: --depth prints one line and exits 0", () => {
  const { root, cwd } = depthFixture("sess-5555", [
    turnWithUsage("claude-opus-5", usage(0, 0, 152_340, 10)),
  ]);
  const out = run(["--depth"], { CLAUDE_CODE_SESSION_ID: "sess-5555", CLAUDE_DOCTOR_PROJECTS: root }, cwd);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(
    out.stdout.trim(),
    "depth: 152340 tokens (15.2% of 1000000, model claude-opus-5) — band: over-budget",
  );
});

test("cli: --depth --json emits the machine shape", () => {
  const { root, cwd } = depthFixture("sess-6666", [
    turnWithUsage("claude-opus-5", usage(0, 0, 152_340, 10)),
  ]);
  const out = run(["--depth", "--json"], { CLAUDE_CODE_SESSION_ID: "sess-6666", CLAUDE_DOCTOR_PROJECTS: root }, cwd);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), {
    depth: 152340,
    model: "claude-opus-5",
    window: 1000000,
    fraction: 0.15234,
    band: "over-budget",
  });
});

test("cli: --depth failure exits non-zero with a one-line reason on stderr", () => {
  const out = run(["--depth"], { CLAUDE_DOCTOR_PROJECTS: "/nonexistent" }, "/tmp");
  assert.notEqual(out.status, 0);
  assert.equal(out.stderr.trim().split("\n").length, 1);
  assert.match(out.stderr, /CLAUDE_CODE_SESSION_ID/);
});
