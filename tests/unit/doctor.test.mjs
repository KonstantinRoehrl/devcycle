// Metric computation and safety rules in scripts/doctor.mjs, exercised
// against synthetic transcripts. No real session transcript is ever read.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, chmodSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  parseArgs, isDevcycleSession, contextDepth, costUSD, depthBand, median,
  summarizeSession, formatReport, budgetBand, resolveDepth,
  extractPluginVersion, emitCandidates, configDrift, findTranscriptFiles,
  compareVersions, versionCohorts, isInFlight, IN_FLIGHT_MS, formatCandidate,
  cohortTable, readRunRecords, attributeFromRecord, costBand, buildJsonReport,
  emitComplianceCandidates, qualitySignals,
} from "../../scripts/doctor.mjs";
import { PRICING } from "../../scripts/pricing.mjs";

const SCRIPT = new URL("../../scripts/doctor.mjs", import.meta.url).pathname;

const usage = (i, cw, cr, o) => ({
  input_tokens: i, cache_creation_input_tokens: cw,
  cache_read_input_tokens: cr, output_tokens: o,
});

// costBand fixtures. Both default to claude-opus-5 ($5/M input, matching turn()'s default
// below), overridable via `model` so the per-model price cancels out of every ratio the
// costBand tests compare, while still being a known, fixed value for the one test that pins
// a dollar amount directly.
const usageWithSplit = ({ h1, m5, model = "claude-opus-5" } = {}) => ({
  message: {
    model,
    usage: {
      input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0,
      cache_creation: { ephemeral_1h_input_tokens: h1, ephemeral_5m_input_tokens: m5 },
    },
  },
});
const usageFlatOnly = ({ cacheCreation, model = "claude-opus-5" } = {}) => ({
  message: {
    model,
    usage: {
      input_tokens: 0, cache_creation_input_tokens: cacheCreation,
      cache_read_input_tokens: 0, output_tokens: 0,
    },
  },
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
  assert.deepEqual(a, { dir: "/tmp/x", since: "2026-07-01", until: "2026-07-31", json: true, all: false, depth: false, drift: null });
});

test("isDevcycleSession: a devcycle attributionSkill includes the session", () => {
  assert.equal(isDevcycleSession([turn({ attributionSkill: "devcycle:cycle" })]), true);
});

test("isDevcycleSession: another plugin's bare skill name does not include it", () => {
  assert.equal(isDevcycleSession([turn({ attributionSkill: "graphify" })]), false);
  assert.equal(isDevcycleSession([turn({ attributionSkill: "superpowers:brainstorming" })]), false);
});

test("isDevcycleSession: a Skill tool call naming a devcycle skill includes the session", () => {
  const rec = turn({ message: { model: "claude-opus-5", usage: usage(1, 1, 1, 1),
    content: [{ type: "tool_use", name: "Skill", input: { skill: "devcycle:cycle" } }] } });
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
    turn({ attributionSkill: "devcycle:cycle" }),
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

test("summarizeSession: forward-fills attribution onto trailing untagged turns in the same transcript", () => {
  const recs = [
    turn({ attributionSkill: "devcycle:cycle" }),
    turn({}),
    turn({}),
  ];
  const s = summarizeSession("sess-abcdef123456", recs);
  assert.equal(s.costByStage.unattributed, undefined);
  assert.equal(s.costByStage["devcycle:cycle"] > 0, true);
});

test("summarizeSession: forward-fill does not cross transcripts", () => {
  const recs = [
    turn({ attributionSkill: "devcycle:cycle" }),
    turn({}),
    turn({ isSidechain: true, agentId: "agent-1" }),
  ];
  const s = summarizeSession("sess-abcdef123456", recs);
  assert.equal(s.costByStage.unattributed > 0, true);
  assert.equal(s.costByStage["devcycle:cycle"] > s.costByStage.unattributed, true);
});

test("summarizeSession: no explicit attribution anywhere in the transcript stays unattributed", () => {
  const s = summarizeSession("sess-abcdef123456", [turn({}), turn({})]);
  assert.equal(Object.keys(s.costByStage).length, 1);
  assert.equal(s.costByStage.unattributed > 0, true);
});

test("formatReport: discloses the forward-fill attribution caveat", () => {
  const out = formatReport([summarizeSession("sess-abcdef123456", [turn({ attributionSkill: "devcycle:cycle" })])]);
  assert.match(out, /forward-filled/i);
});

// --- readRunRecords / attributeFromRecord: the preferred read-path over the run-record log ---

test("readRunRecords returns an empty map when the runs directory does not exist", () => {
  assert.strictEqual(readRunRecords(join(tmpdir(), "definitely-absent-runs")).size, 0);
});

test("readRunRecords indexes a record by its hashed session id", () => {
  const dir = mkdtempSync(join(tmpdir(), "runs-read-"));
  const slug = mkdtempSync(join(dir, "repo-"));
  const hash = createHash("sha256").update("sess-1").digest("hex");
  writeFileSync(join(slug, "abc.jsonl"),
    [
      { kind: "run", runId: "abc", schemaVersion: 1, pluginVersion: "0.13.0" },
      { kind: "session", runId: "abc", sessionHash: hash,
        firstSeen: "2026-08-07T10:00:00Z", lastSeen: "2026-08-07T11:00:00Z" },
      { kind: "stage", runId: "abc", stage: "planning", startedAt: "2026-08-07T10:00:00Z",
        endedAt: "2026-08-07T10:30:00Z", outcome: "complete" },
    ].map((o) => JSON.stringify(o)).join("\n") + "\n");
  const records = readRunRecords(dir);
  assert.ok(records.has(hash));
  assert.strictEqual(records.get(hash).pluginVersion, "0.13.0");
  assert.strictEqual(records.get(hash).stages.length, 1);
});

test("a turn inside a stage window is attributed to that stage, not to the last skill tag", () => {
  const record = {
    runId: "abc",
    stages: [
      { stage: "planning", startedAt: "2026-08-07T10:00:00Z", endedAt: "2026-08-07T10:30:00Z" },
      { stage: "execution", startedAt: "2026-08-07T10:30:00Z", endedAt: "2026-08-07T11:00:00Z" },
    ],
    dispatches: [],
  };
  const turns = [
    { timestamp: "2026-08-07T10:10:00Z", attributionSkill: "devcycle:cycle" },
    { timestamp: "2026-08-07T10:45:00Z", attributionSkill: undefined },
  ];
  const attributed = attributeFromRecord(turns, record);
  assert.strictEqual(attributed[0].stage, "planning");
  assert.strictEqual(attributed[1].stage, "execution");
  assert.strictEqual(attributed[1].attributionSource, "record");
});

test("stage windows leave nothing unattributed for a recorded session", () => {
  const record = {
    runId: "abc",
    stages: [{ stage: "planning", startedAt: "2026-08-07T10:00:00Z", endedAt: "2026-08-07T11:00:00Z" }],
    dispatches: [],
  };
  const turns = [{ timestamp: "2026-08-07T10:30:00Z", attributionSkill: undefined }];
  const attributed = attributeFromRecord(turns, record);
  assert.notStrictEqual(attributed[0].stage, "unattributed");
});

test("a session with no run record still attributes, labelled forward-filled", () => {
  const turns = [{ timestamp: "2026-08-07T10:30:00Z", attributionSkill: "devcycle:cycle" }];
  assert.strictEqual(attributeFromRecord(turns, null), null);
});

test("a dispatch window attributes a sidechain to its task by agentId", () => {
  const record = {
    runId: "abc",
    stages: [{ stage: "execution", startedAt: "2026-08-07T10:00:00Z", endedAt: "2026-08-07T11:00:00Z" }],
    dispatches: [
      { taskId: "3", agentId: "a7291986a2b97fcd8",
        startedAt: "2026-08-07T10:10:00Z", endedAt: "2026-08-07T10:20:00Z" },
      { taskId: "4", agentId: "a6d5650949c386201",
        startedAt: "2026-08-07T10:12:00Z", endedAt: "2026-08-07T10:25:00Z" },
    ],
  };
  // The two dispatches overlap in time; agentId is what separates them, not the timestamps.
  const turns = [
    { timestamp: "2026-08-07T10:15:00Z", agentId: "a7291986a2b97fcd8" },
    { timestamp: "2026-08-07T10:15:00Z", agentId: "a6d5650949c386201" },
  ];
  const attributed = attributeFromRecord(turns, record);
  assert.strictEqual(attributed[0].taskId, "3");
  assert.strictEqual(attributed[1].taskId, "4");
});

// --- end to end over a synthetic transcript directory ---

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), "doctor-"));
  const proj = join(dir, "-some-project");
  mkdirSync(proj, { recursive: true });
  const lines = [
    turn({ attributionSkill: "devcycle:cycle",
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

// A devcycle session's whole attribution can now be its slash command — nothing else marks it,
// since a playbook is not addressable and fires no Skill tool call. The no-arg corpus is built
// on this filter, so a filter that stopped keeping command-only sessions would report zero
// turns while still exiting 0.
test("cli: a session attributed only to a devcycle command is kept in the corpus", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-command-"));
  const proj = join(dir, "-some-project");
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, "sess-eeeeeeeeeeee.jsonl"),
    JSON.stringify(turn({ sessionId: "sess-eeeeeeeeeeee", attributionSkill: "devcycle:learn" })) + "\n",
  );
  writeFileSync(
    join(proj, "sess-999999999999.jsonl"),
    JSON.stringify(turn({ sessionId: "sess-999999999999", attributionSkill: "graphify" })) + "\n",
  );
  const res = run(["--dir", dir]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /sess-eee/);
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
    turn({ timestamp: "2026-07-01T09:00:00.000Z", attributionSkill: "devcycle:cycle" }),
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

// --- costBand: the error-bar cost band over cache-write TTL-split coverage ---

test("costBand collapses to zero over 3500 split-priced cache-write tokens, not over 2 records", () => {
  const band = costBand([
    usageWithSplit({ h1: 1000, m5: 500 }),
    usageWithSplit({ h1: 2000, m5: 0 }),
  ]);
  // 3000 tokens at 1h (2.00x) + 500 at 5m (1.25x) = 6625 price-weighted tokens — the same figure
  // as 5300 tokens priced entirely at 5m. Equality pins both multipliers without pinning a price.
  const equivalent = costBand([usageWithSplit({ h1: 0, m5: 5300 })]);
  assert.ok(Math.abs(band.point - equivalent.point) < 1e-9,
    "1h at 2.00x and 5m at 1.25x: 1000/500 + 2000 must price identically to 5300 at 5m");
  // Same 6625 price-weighted tokens against opus-5's $5/M input price is 33125, $0.033125 once
  // divided by 1e6 like costUSD (:98-103). A missing divide renders $33,125 — six orders of
  // magnitude too large but still a plausible-looking figure, the exact defect this pins.
  assert.ok(Math.abs(band.point - 0.033125) < 1e-9,
    "costBand must divide by 1e6 like costUSD, not report price-weighted token units as dollars");
  // 0 unsplit tokens out of 3500 cache-write tokens. The denominator must be the token total;
  // a record-count denominator (0 / 2) is also 0 here, so `low === high` and the equality above
  // are what keep this case honest.
  assert.equal(band.fallbackShare, 0);
  assert.equal(band.collapsed, true);
  assert.equal(band.low, band.high);
});

test("an unpriced-model record is excluded from the band and its denominator, not thrown on or zero-priced", () => {
  const priced = usageWithSplit({ h1: 1000, m5: 500 });
  const unpriced = usageWithSplit({ h1: 2000, m5: 0, model: "claude-opus-9" }); // not in PRICING
  const band = costBand([priced, unpriced]);
  const pricedOnly = costBand([priced]);
  // The unpriced record's 2000 tokens must not reach totalTokens either — if they did, fallbackShare
  // and the band would both be wrong even though nothing threw. Exact equality with the priced-only
  // band is the only assertion that can't be satisfied by a record that silently prices at zero.
  assert.deepStrictEqual(band, pricedOnly,
    "an unpriced record must match the priced-only band exactly, not merely avoid throwing");
});

test("costBand reports 3000 of 4000 cache-write tokens unsplit, not 3000 of 2 records", () => {
  const band = costBand([
    usageWithSplit({ h1: 0, m5: 1000 }),
    usageFlatOnly({ cacheCreation: 3000 }),
  ]);
  // 3000 unsplit of 4000 total cache-write tokens = 0.75 exactly. A record-count denominator
  // yields 3000 / 3002 = 0.9993 — which a bare `> 0` assertion would happily accept.
  assert.ok(Math.abs(band.fallbackShare - 0.75) < 1e-9,
    "fallbackShare is unsplit cache-write tokens over all cache-write tokens");
  assert.equal(band.collapsed, false);
  // low prices the 3000 fallback tokens at 5m, high at 1h: (1250 + 3750) against (1250 + 6000)
  // price-weighted tokens — a 1.45x spread, again independent of the model's price.
  assert.ok(Math.abs(band.high / band.low - 1.45) < 1e-9,
    "an unpriced-TTL write must widen the band by exactly the 2.00x/1.25x ratio");
  assert.ok(band.point >= band.low && band.point <= band.high);
});

test("the report says the band collapsed rather than printing a meaningless zero", () => {
  const text = formatReport([
    { pluginVersion: "0.10.1", costByStage: { a: 1.0 }, medianDepth: 10,
      cacheBand: { point: 1.0, low: 1.0, high: 1.0, fallbackShare: 0, collapsed: true } },
  ]);
  assert.match(text, /every cache write carries its TTL|band collapses|exact/i);
  assert.doesNotMatch(text, /±\$0\.00/);
});

// The test above feeds formatReport a hand-built cacheBand literal, so it stays green even if
// summarizeSession never produces one — it pins the render, not the wiring. This one goes through
// summarizeSession on real turns instead, so it fails if the producer is orphaned.
test("summarizeSession: cacheBand covers only the priced turns, and an unpriced model still lands in the unpriced tally", () => {
  const splitUsage = {
    input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0,
    cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 500 },
  };
  const recs = [
    turn({ message: { model: "claude-opus-5", usage: splitUsage } }),
    turn({ message: { model: "claude-opus-9", usage: splitUsage } }), // not in PRICING
  ];
  const s = summarizeSession("sess-abcdef123456", recs);
  // costBand computed directly over the one priced turn is the only value the wiring may produce;
  // a summary that fed both turns in, or none, would diverge from this exactly.
  assert.deepStrictEqual(s.cacheBand, costBand([recs[0]]));
  assert.equal(s.unpriced["claude-opus-9"], 1);
});

test("a forward-filled session is labelled inferred in text AND in --json", () => {
  const summaries = [
    { pluginVersion: "0.10.1", costByStage: { a: 1.0 }, medianDepth: 10,
      attributionSource: "forward-filled" },
  ];
  assert.match(formatReport(summaries), /inferred/i);
  const json = buildJsonReport(summaries);
  assert.strictEqual(json.sessions[0].inferred, "forward-filled");
});

// The test above hand-builds its summary literal, so it stays green even if summarizeSession
// never rolls attributionSource up to the session level and even if the render line names a
// field that does not exist — it pins the render, not the wiring or the field name. This one
// runs a real record-less session through summarizeSession and both render sites, so it fails
// on either bug: an unset s.attributionSource (json.inferred stays null, the text line never
// fires) or a render line naming a nonexistent field (the text line prints "undefined" instead
// of the session's real id).
test("a record-less session's forward-filled attribution reaches the real rendered text and --json output, not a hand-built literal", () => {
  const s = summarizeSession("sess-abcdef123456", [turn({ attributionSkill: "devcycle:cycle" })]);
  assert.strictEqual(s.attributionSource, "forward-filled");
  const text = formatReport([s]);
  assert.match(text, new RegExp(`${s.id}: stage costs are inferred \\(forward-filled`));
  assert.doesNotMatch(text, /undefined: stage costs are inferred/);
  const json = buildJsonReport([s]);
  assert.strictEqual(json.sessions[0].inferred, "forward-filled");
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
    JSON.stringify(turn({ attributionSkill: "devcycle:cycle" })) + "\n",
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
    JSON.stringify(turn({ attributionSkill: "devcycle:cycle" })) +
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
    JSON.stringify(turn({ attributionSkill: "devcycle:cycle" })) +
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

// emitCandidates() is computed but must actually reach the documented CLI surface — the
// playbook layer (playbooks/profiling-sessions.md) has nothing to rank/report on otherwise.
test("cli: --json emits a candidates array carrying emitCandidates' signals", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-candidates-"));
  const slug = join(dir, "-Users-x-proj");
  mkdirSync(slug, { recursive: true });
  writeFileSync(
    join(slug, "sess-ffff.jsonl"),
    JSON.stringify(turn({ attributionSkill: "devcycle:cycle" })) +
      "\n" +
      JSON.stringify({
        type: "assistant",
        message: { model: "claude-opus-9", usage: usage(1_000_000, 0, 0, 0), content: [] },
      }) +
      "\n",
  );
  const out = run(["--dir", dir, "--json"]);
  assert.equal(out.status, 0, out.stderr);
  const parsed = JSON.parse(out.stdout);
  assert.ok(Array.isArray(parsed.candidates), "expected a candidates array in --json output");
  const unpriced = parsed.candidates.find((c) => c.type === "unpriced-model");
  assert.ok(unpriced, "expected the unpriced-model signal to reach the CLI's json output");
});

test("cli: the plain-text report surfaces candidate signals, not just the raw aggregate", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-candidates-text-"));
  const slug = join(dir, "-Users-x-proj");
  mkdirSync(slug, { recursive: true });
  writeFileSync(
    join(slug, "sess-gggg.jsonl"),
    JSON.stringify(turn({ attributionSkill: "devcycle:cycle" })) +
      "\n" +
      JSON.stringify({
        type: "assistant",
        message: { model: "claude-opus-9", usage: usage(1_000_000, 0, 0, 0), content: [] },
      }) +
      "\n",
  );
  const out = run(["--dir", dir]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /unpriced-model/);
});

test("cli: a malformed trailing line is skipped rather than fatal", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-partial-"));
  const slug = join(dir, "-Users-x-proj");
  mkdirSync(slug, { recursive: true });
  writeFileSync(
    join(slug, "sess-eeee.jsonl"),
    JSON.stringify(turn({ attributionSkill: "devcycle:cycle" })) +
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

test("extractPluginVersion finds a devcycle plugin path version in tool_use content", () => {
  const record = {
    message: {
      content: [
        {
          type: "tool_use",
          input: {
            command:
              'node "~/.claude/plugins/cache/devcycle/devcycle/0.9.2/scripts/doctor.mjs" --depth',
          },
        },
      ],
    },
  };
  assert.strictEqual(extractPluginVersion(record), "0.9.2");
});

test("extractPluginVersion returns null with no plugin path present", () => {
  assert.strictEqual(extractPluginVersion({ message: { content: [] } }), null);
});

test("emitCandidates flags a version-over-version cost regression for the same skill", () => {
  const summaries = [
    {
      id: "s1",
      costByStage: { "devcycle:planning-waves": 0.4 },
      pluginVersion: "0.9.1",
      medianDepth: 40000,
      unpriced: {},
    },
    {
      id: "s2",
      costByStage: { "devcycle:planning-waves": 0.9 },
      pluginVersion: "0.9.2",
      medianDepth: 40000,
      unpriced: {},
    },
  ];
  const candidates = emitCandidates(summaries);
  const regression = candidates.find(
    (c) => c.type === "version-regression" && c.skill === "devcycle:planning-waves"
  );
  assert.ok(regression, "expected a version-regression candidate");
  assert.strictEqual(regression.version_from, "0.9.1");
  assert.strictEqual(regression.version_to, "0.9.2");
  assert.ok(regression.delta_pct > 100);
  assert.strictEqual(regression.dollars, 0.9);
});

test("emitCandidates flags unpriced-model usage as a candidate", () => {
  const summaries = [
    { id: "s1", costByStage: {}, pluginVersion: "0.9.2", medianDepth: 10000, unpriced: { "claude-haiku-4-1": 3 } },
  ];
  const candidates = emitCandidates(summaries);
  const unpriced = candidates.find((c) => c.type === "unpriced-model");
  assert.ok(unpriced, "expected an unpriced-model candidate");
  assert.strictEqual(unpriced.sessions_sampled, 1);
});

// startupFloor is agent-type-keyed ({main: [...], subagent: [...]}), not a scalar — the
// comparison must reduce it to a scalar (the median across every agent type's samples)
// before comparing against medianDepth, or it silently NaNs and never fires.
test("emitCandidates flags a depth-vs-startup-floor outlier when medianDepth exceeds 3x the reduced startup floor", () => {
  const summaries = [
    {
      id: "s1",
      costByStage: {},
      pluginVersion: "0.9.2",
      medianDepth: 40000,
      startupFloor: { main: [1000, 2000], subagent: [1500] },
      unpriced: {},
    },
  ];
  const candidates = emitCandidates(summaries);
  const outlier = candidates.find((c) => c.type === "depth-outlier");
  assert.ok(outlier, "expected a depth-outlier candidate");
});

test("emitCandidates does not flag a depth-outlier when medianDepth is within 3x the startup floor", () => {
  const summaries = [
    {
      id: "s1",
      costByStage: {},
      pluginVersion: "0.9.2",
      medianDepth: 3000,
      startupFloor: { main: [1000, 2000], subagent: [1500] },
      unpriced: {},
    },
  ];
  const candidates = emitCandidates(summaries);
  const outlier = candidates.find((c) => c.type === "depth-outlier");
  assert.equal(outlier, undefined);
});

// Standalone cost-outlier: must fire on an anomalously expensive run relative to its peers
// even when there is only one version cohort — unlike version-regression, which requires
// two adjacent cohorts to compare.
test("emitCandidates flags a cost-outlier for a skill whose cost is far above its peers, with a single version cohort", () => {
  const summaries = [
    { id: "s1", costByStage: { "devcycle:cycle": 0.1 }, pluginVersion: "0.9.2", medianDepth: 10000, unpriced: {} },
    { id: "s2", costByStage: { "devcycle:cycle": 0.11 }, pluginVersion: "0.9.2", medianDepth: 10000, unpriced: {} },
    { id: "s3", costByStage: { "devcycle:cycle": 0.09 }, pluginVersion: "0.9.2", medianDepth: 10000, unpriced: {} },
    { id: "s4", costByStage: { "devcycle:cycle": 5.0 }, pluginVersion: "0.9.2", medianDepth: 10000, unpriced: {} },
  ];
  const candidates = emitCandidates(summaries);
  const outlier = candidates.find(
    (c) => c.type === "cost-outlier" && c.skill === "devcycle:cycle"
  );
  assert.ok(outlier, "expected a cost-outlier candidate");
  assert.strictEqual(outlier.dollars, 5.0);
});

test("emitCandidates does not flag a cost-outlier when costs are uniform across runs", () => {
  const summaries = [
    { id: "s1", costByStage: { "devcycle:cycle": 0.1 }, pluginVersion: "0.9.2", medianDepth: 10000, unpriced: {} },
    { id: "s2", costByStage: { "devcycle:cycle": 0.11 }, pluginVersion: "0.9.2", medianDepth: 10000, unpriced: {} },
    { id: "s3", costByStage: { "devcycle:cycle": 0.09 }, pluginVersion: "0.9.2", medianDepth: 10000, unpriced: {} },
    { id: "s4", costByStage: { "devcycle:cycle": 0.1 }, pluginVersion: "0.9.2", medianDepth: 10000, unpriced: {} },
  ];
  const candidates = emitCandidates(summaries);
  const outlier = candidates.find((c) => c.type === "cost-outlier");
  assert.equal(outlier, undefined);
});

test("a main-thread browser call is flagged unconditionally", () => {
  const c = emitComplianceCandidates([
    { isSidechain: false, toolName: "computer" },
    { isSidechain: false, toolName: "javascript_tool" },
    { isSidechain: true, toolName: "computer" },
  ], { stages: [], dispatches: [] });
  const flag = c.find((x) => x.type === "main-thread-browser");
  assert.ok(flag, "no main-thread browser candidate produced");
  assert.strictEqual(flag.calls, 2, "sidechain browser calls must not be counted");
});

test("no main-thread browser calls produces no candidate", () => {
  const c = emitComplianceCandidates([{ isSidechain: true, toolName: "computer" }],
    { stages: [], dispatches: [] });
  assert.strictEqual(c.find((x) => x.type === "main-thread-browser"), undefined);
});

test("dispatches that inherited their model are counted and reported", () => {
  const c = emitComplianceCandidates([], {
    stages: [],
    dispatches: [
      { taskId: "1", modelSource: "inherited", agentType: "devcycle:implementer" },
      { taskId: "2", modelSource: "explicit", agentType: "devcycle:implementer" },
      { taskId: "3", modelSource: "inherited", agentType: "devcycle:implementer" },
    ],
  });
  const flag = c.find((x) => x.type === "inherited-model");
  assert.strictEqual(flag.inherited, 2);
  assert.strictEqual(flag.total, 3);
});

test("read-only search routed to general-purpose is flagged", () => {
  const c = emitComplianceCandidates([], {
    stages: [],
    dispatches: [
      { taskId: "1", agentType: "general-purpose", modelSource: "explicit" },
      { taskId: "2", agentType: "Explore", modelSource: "explicit" },
    ],
  });
  const flag = c.find((x) => x.type === "general-purpose-search");
  assert.strictEqual(flag.count, 1);
});

test("compliance candidates are absent, not zero, for a record-less session", () => {
  assert.deepStrictEqual(emitComplianceCandidates([], null), []);
});

test("configDrift flags a stale superseded key with its exact line and replacement", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-drift-"));
  const changelogPath = join(dir, "config-changelog.md");
  const targetPath = join(dir, "CLAUDE.md");
  writeFileSync(
    changelogPath,
    [
      "# Config changelog",
      "",
      "```yaml",
      '- version: "0.7.0"',
      "  change: deprecated",
      "  key: legacyReviewMode",
      '  note: "superseded by reviewDepth"',
      "```",
    ].join("\n"),
    "utf8"
  );
  writeFileSync(
    targetPath,
    ["# CLAUDE.md", "", "Set legacyReviewMode to strict for this repo."].join("\n"),
    "utf8"
  );
  try {
    const { findings } = configDrift(targetPath, changelogPath);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].line, 3);
    assert.strictEqual(findings[0].key, "legacyReviewMode");
    assert.match(findings[0].supersededBy, /reviewDepth/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("configDrift returns no findings for a target file with no stale references", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-drift-clean-"));
  const changelogPath = join(dir, "config-changelog.md");
  const targetPath = join(dir, "CLAUDE.md");
  writeFileSync(
    changelogPath,
    ["# Config changelog", "", "```yaml", '- version: "0.7.0"', "  change: deprecated", "  key: legacyReviewMode", '  note: "superseded by reviewDepth"', "```"].join("\n"),
    "utf8"
  );
  writeFileSync(targetPath, ["# CLAUDE.md", "", "This repo uses reviewDepth: panel."].join("\n"), "utf8");
  try {
    assert.deepStrictEqual(configDrift(targetPath, changelogPath).findings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor.mjs exports its transcript-walk helpers", async () => {
  const m = await import("../../scripts/doctor.mjs");
  for (const name of ["findTranscriptFiles", "owningSession", "readRecords", "inWindow"])
    assert.equal(typeof m[name], "function", `${name} must be exported`);
});

// Installs a runnable copy of doctor.mjs at <dir>/scripts/, so the copy's own location —
// not the working directory — is what its changelog resolution has to work from. `changelog`
// null means the tree ships no references/config-changelog.md at all.
function installDoctor(changelog) {
  // realpath: on macOS the temp dir is a symlink, and Node resolves an ESM entry point to its
  // real path — so an unresolved path would make the script's own `is this the entry point`
  // check fail and main() would never run.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "doctor-install-")));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  for (const name of ["doctor.mjs", "pricing.mjs"])
    copyFileSync(new URL(`../../scripts/${name}`, import.meta.url).pathname, join(dir, "scripts", name));
  if (changelog !== null) {
    mkdirSync(join(dir, "references"), { recursive: true });
    writeFileSync(join(dir, "references", "config-changelog.md"), changelog, "utf8");
  }
  return dir;
}

const yamlChangelog = (...records) => ["# Config changelog", "", "```yaml", ...records, "```", ""].join("\n");

const ADDED_ONLY = yamlChangelog('- version: "0.8.0"', "  change: added", "  key: profile", "  default: standard");
const ONE_STALE = yamlChangelog(
  '- version: "0.7.0"',
  "  change: deprecated",
  "  key: legacyReviewMode",
  '  note: "superseded by reviewDepth"'
);

test("--drift resolves its changelog from the script's own location, not the working directory", () => {
  // The documented invocation runs doctor from the target repo, where ./references does not
  // exist; CLAUDE_PLUGIN_ROOT is not in a script's environment (docs/platform-notes.md (c)).
  const cwd = mkdtempSync(join(tmpdir(), "doctor-drift-foreign-cwd-"));
  writeFileSync(join(cwd, "CLAUDE.md"), "profile: standard\n", "utf8");
  try {
    const res = run(["--drift", join(cwd, "CLAUDE.md")], { CLAUDE_PLUGIN_ROOT: "" }, cwd);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /^config-drift:/m);
    assert.doesNotMatch(res.stderr, /ENOENT/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("--drift reports an unreadable changelog as a doctor: diagnostic, not a stack trace", () => {
  const dir = installDoctor(null);
  writeFileSync(join(dir, "CLAUDE.md"), "profile: standard\n", "utf8");
  try {
    const res = spawnSync(process.execPath, [join(dir, "scripts", "doctor.mjs"), "--drift", join(dir, "CLAUDE.md")], {
      encoding: "utf8",
      cwd: dir,
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /^doctor: /m);
    assert.doesNotMatch(res.stderr, /at configDrift|node:internal/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--drift says so when the changelog records no stale keys, instead of reporting clean", () => {
  const dir = installDoctor(ADDED_ONLY);
  writeFileSync(join(dir, "CLAUDE.md"), "profile: standard\n", "utf8");
  try {
    const res = spawnSync(process.execPath, [join(dir, "scripts", "doctor.mjs"), "--drift", join(dir, "CLAUDE.md")], {
      encoding: "utf8",
      cwd: dir,
    });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /no deprecated\/renamed\/removed keys/);
    assert.match(res.stdout, /1 record/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--drift reports a clean target against a changelog that does carry stale keys, with what it checked", () => {
  const dir = installDoctor(ONE_STALE);
  writeFileSync(join(dir, "CLAUDE.md"), "reviewDepth: panel\n", "utf8");
  try {
    const res = spawnSync(process.execPath, [join(dir, "scripts", "doctor.mjs"), "--drift", join(dir, "CLAUDE.md")], {
      encoding: "utf8",
      cwd: dir,
    });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /config-drift: ok/);
    assert.match(res.stdout, /1 stale key/);
    assert.doesNotMatch(res.stdout, /no deprecated\/renamed\/removed keys/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("configDrift reports what it parsed, so a changelog with no stale keys is not a clean bill of health", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-drift-counts-"));
  const changelogPath = join(dir, "config-changelog.md");
  const targetPath = join(dir, "CLAUDE.md");
  writeFileSync(changelogPath, ADDED_ONLY, "utf8");
  writeFileSync(targetPath, "profile: standard\n", "utf8");
  try {
    const result = configDrift(targetPath, changelogPath);
    assert.deepStrictEqual(result.findings, []);
    assert.strictEqual(result.recordsParsed, 1);
    assert.strictEqual(result.staleKeys, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("configDrift refuses a changelog it parsed nothing from instead of returning no findings", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-drift-unparsable-"));
  const changelogPath = join(dir, "config-changelog.md");
  const targetPath = join(dir, "CLAUDE.md");
  writeFileSync(changelogPath, "# Config changelog\n\nProse only — no yaml block at all.\n", "utf8");
  writeFileSync(targetPath, "legacyReviewMode: strict\n", "utf8");
  try {
    assert.throws(() => configDrift(targetPath, changelogPath), /no records/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findTranscriptFiles raises an unreadable directory instead of reporting it as no transcripts", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-unreadable-"));
  const locked = join(dir, "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o000);
  try {
    assert.throws(() => findTranscriptFiles(dir), (err) => err.code === "EACCES");
    // A path that simply is not there stays a null (no transcripts), not a throw.
    assert.strictEqual(findTranscriptFiles(join(dir, "absent")), null);
  } finally {
    chmodSync(locked, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor.mjs is importable when process.argv[1] is undefined", () => {
  const r = spawnSync(process.execPath, [
    "-e",
    'import("./scripts/doctor.mjs").then(() => process.exit(0), () => process.exit(1))',
  ], { cwd: new URL("../../", import.meta.url).pathname, encoding: "utf8" });
  assert.equal(r.status, 0, "importing must not throw when argv[1] is undefined");
});

test("compareVersions orders numerically, not lexicographically", () => {
  assert.ok(compareVersions("0.9.2", "0.10.1") < 0);
  assert.ok(compareVersions("0.10.1", "0.4.0") > 0);
  assert.strictEqual(compareVersions("1.2.3", "1.2.3"), 0);
  assert.deepStrictEqual(
    ["0.10.1", "0.4.0", "0.9.2", "0.11.1"].sort(compareVersions),
    ["0.4.0", "0.9.2", "0.10.1", "0.11.1"]
  );
});

test("emitCandidates compares the adjacent pair lexicographic sort skipped", () => {
  // 0.9.2 -> 0.10.1 is precisely the comparison the real corpus lost: lexicographically
  // "0.10.1" < "0.9.2", so this pair was never adjacent and four real regressions vanished.
  const summaries = [
    { pluginVersion: "0.9.2", costByStage: { "devcycle:cycle": 1.0 }, medianDepth: 10 },
    { pluginVersion: "0.9.2", costByStage: { "devcycle:cycle": 1.0 }, medianDepth: 10 },
    { pluginVersion: "0.10.1", costByStage: { "devcycle:cycle": 4.0 }, medianDepth: 10 },
    { pluginVersion: "0.10.1", costByStage: { "devcycle:cycle": 4.0 }, medianDepth: 10 },
  ];
  const c = emitCandidates(summaries).find(
    (x) => x.type === "version-regression" && x.version_from === "0.9.2"
  );
  assert.ok(c, "no regression candidate produced for 0.9.2 -> 0.10.1");
  assert.strictEqual(c.version_to, "0.10.1");
});

test("emitCandidates reports improvements, not only regressions", () => {
  const summaries = [
    { pluginVersion: "0.9.2", costByStage: { "devcycle:cycle": 4.0 }, medianDepth: 10 },
    { pluginVersion: "0.9.2", costByStage: { "devcycle:cycle": 4.0 }, medianDepth: 10 },
    { pluginVersion: "0.10.1", costByStage: { "devcycle:cycle": 1.0 }, medianDepth: 10 },
    { pluginVersion: "0.10.1", costByStage: { "devcycle:cycle": 1.0 }, medianDepth: 10 },
  ];
  const c = emitCandidates(summaries).find((x) => x.type === "version-improvement");
  assert.ok(c, "no version-improvement candidate exists");
  assert.strictEqual(c.version_from, "0.9.2");
  assert.strictEqual(c.version_to, "0.10.1");
  assert.ok(c.delta_dollars < 0, "an improvement must carry a negative dollar delta");
});

test("a candidate carries the absolute dollar move, not only the percentage", () => {
  const summaries = [
    { pluginVersion: "0.9.2", costByStage: { "devcycle:cycle": 0.18 }, medianDepth: 10 },
    { pluginVersion: "0.9.2", costByStage: { "devcycle:cycle": 0.18 }, medianDepth: 10 },
    { pluginVersion: "0.10.1", costByStage: { "devcycle:cycle": 33.2 }, medianDepth: 10 },
    { pluginVersion: "0.10.1", costByStage: { "devcycle:cycle": 33.2 }, medianDepth: 10 },
  ];
  const c = emitCandidates(summaries).find((x) => x.type === "version-regression");
  assert.strictEqual(c.from_dollars, 0.18);
  assert.ok(Math.abs(c.delta_dollars - 33.02) < 0.001);
});

test("version candidates rank by absolute dollar impact, not by percentage", () => {
  // A +18013% move off a $0.18 median is a $33 move. A +50% move off a $200 median is $100.
  // Percentage ranking puts the $33 move first; dollar ranking must not.
  const summaries = [
    { pluginVersion: "0.9.2", costByStage: { tiny: 0.18, big: 200 }, medianDepth: 10 },
    { pluginVersion: "0.9.2", costByStage: { tiny: 0.18, big: 200 }, medianDepth: 10 },
    { pluginVersion: "0.10.1", costByStage: { tiny: 33.2, big: 300 }, medianDepth: 10 },
    { pluginVersion: "0.10.1", costByStage: { tiny: 33.2, big: 300 }, medianDepth: 10 },
  ];
  const versionCandidates = emitCandidates(summaries).filter((c) =>
    c.type === "version-regression" || c.type === "version-improvement"
  );
  assert.strictEqual(versionCandidates[0].skill, "big");
  assert.ok(
    Math.abs(versionCandidates[0].delta_dollars) >= Math.abs(versionCandidates[1].delta_dollars)
  );
});

test("a session with no detectable plugin version is bucketed as unknown, never dropped", () => {
  const summaries = [
    { pluginVersion: null, costByStage: { "devcycle:cycle": 5.0 }, medianDepth: 10 },
    { pluginVersion: "0.10.1", costByStage: { "devcycle:cycle": 1.0 }, medianDepth: 10 },
  ];
  const cohorts = versionCohorts(summaries);
  assert.ok(cohorts.has("unknown"), "a null-version session was silently dropped");
  assert.strictEqual(cohorts.get("unknown").sessions, 1);
});

// --- in-flight sessions ---

test("a session whose newest record is recent is marked in-flight", () => {
  const now = Date.parse("2026-08-07T12:00:00Z");
  assert.strictEqual(isInFlight(Date.parse("2026-08-07T11:50:00Z"), now), true);
  assert.strictEqual(isInFlight(Date.parse("2026-08-07T11:00:00Z"), now), false);
  // The boundary itself, from both sides.
  assert.strictEqual(isInFlight(now - IN_FLIGHT_MS, now), false);
  assert.strictEqual(isInFlight(now - IN_FLIGHT_MS + 1, now), true);
});

test("summarizeSession marks a session by the age of its newest record", () => {
  const stale = summarizeSession("sess-abcdef123456", [turn({})]);
  assert.strictEqual(stale.inFlight, false);
  const live = summarizeSession("sess-abcdef123456", [
    turn({ timestamp: new Date(Date.now() - 60_000).toISOString() }),
  ]);
  assert.strictEqual(live.inFlight, true);
});

test("a session with no readable timestamp is not called in-flight and is still summarised", () => {
  const s = summarizeSession("sess-abcdef123456", [turn({ timestamp: undefined })]);
  assert.strictEqual(s.inFlight, false);
  assert.strictEqual(s.turns, 1);
});

test("in-flight sessions are excluded from cohort medians", () => {
  const summaries = [
    { pluginVersion: "0.9.2", costByStage: { s: 1.0 }, medianDepth: 10, inFlight: false },
    { pluginVersion: "0.10.1", costByStage: { s: 1.0 }, medianDepth: 10, inFlight: false },
    { pluginVersion: "0.10.1", costByStage: { s: 999.0 }, medianDepth: 10, inFlight: true },
  ];
  const cohorts = versionCohorts(summaries.filter((s) => !s.inFlight));
  assert.strictEqual(cohorts.get("0.10.1").sessions, 1);
  assert.ok(!cohorts.get("0.10.1").dollars.includes(999.0));
  // The exclusion has to be doctor's, not the caller's: the half-written 999.0 must not
  // reach the version-over-version median comparison.
  const c = emitCandidates(summaries).find((x) => x.type === "version-regression");
  assert.strictEqual(c, undefined, "an in-flight session's partial cost moved a cohort median");
});

test("the report states how many sessions were excluded as in-flight", () => {
  const rendered = { costUSD: 1.0, models: {}, tools: {} };
  const text = formatReport([
    { ...rendered, pluginVersion: "0.10.1", costByStage: { s: 1.0 }, medianDepth: 10, inFlight: false },
    { ...rendered, pluginVersion: "0.10.1", costByStage: { s: 999.0 }, medianDepth: 10, inFlight: true },
  ]);
  assert.match(text, /in-flight/i);
  assert.match(text, /1 session\(s\) still in flight/);
  // Excluded from the medians, still counted in the corpus.
  assert.match(text, /over 2 session\(s\)/);
});

test("a single-session cohort is marked low confidence", () => {
  const c = { type: "version-regression", skill: "s", delta_pct: 50, delta_dollars: 1,
              from_dollars: 2, dollars: 3, sessions_sampled: 1 };
  assert.match(formatCandidate(c), /low confidence/i);
  const many = { ...c, sessions_sampled: 8 };
  assert.doesNotMatch(formatCandidate(many), /low confidence/i);
});

test("the low-confidence marker reaches the machine shape, not the text report alone", () => {
  const lone = emitCandidates([
    { pluginVersion: "0.10.1", costByStage: {}, medianDepth: 900, startupFloor: { main: [100] } },
  ]).find((x) => x.type === "depth-outlier");
  assert.strictEqual(lone.sessions_sampled, 1);
  assert.strictEqual(lone.low_confidence, true);
  const sampled = emitCandidates([
    { costByStage: { s: 1 } }, { costByStage: { s: 1 } }, { costByStage: { s: 100 } },
  ]).find((x) => x.type === "cost-outlier");
  assert.strictEqual(sampled.sessions_sampled, 3);
  assert.strictEqual(sampled.low_confidence, false);
});

test("cli: --json labels the in-flight exclusion too, not the text report alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-inflight-"));
  const proj = join(dir, "-some-project");
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, "sess-aaaaaaaaaaaa.jsonl"),
    JSON.stringify(turn({
      sessionId: "sess-aaaaaaaaaaaa", attributionSkill: "devcycle:cycle",
      timestamp: new Date(Date.now() - 60_000).toISOString(),
    })) + "\n",
  );
  const res = run(["--dir", dir, "--json"]);
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.strictEqual(parsed.sessions.length, 1, "an in-flight session was dropped from the corpus");
  assert.strictEqual(parsed.sessions[0].inFlight, true);
  assert.strictEqual(parsed.inFlight.excluded, 1);
  assert.match(parsed.inFlight.note, /approximation/i);
});

test("cohortTable carries n, total, median $/session and median depth per version", () => {
  const rows = cohortTable([
    { pluginVersion: "0.9.2", costByStage: { a: 1.0, b: 1.0 }, medianDepth: 10 },
    { pluginVersion: "0.9.2", costByStage: { a: 3.0, b: 1.0 }, medianDepth: 20 },
    { pluginVersion: "0.10.1", costByStage: { a: 5.0 }, medianDepth: 30 },
  ]);
  const v092 = rows.find((r) => r.version === "0.9.2");
  assert.strictEqual(v092.sessions, 2);
  assert.strictEqual(v092.total, 6.0);
  assert.strictEqual(v092.medianPerSession, 3.0);
  assert.strictEqual(v092.medianDepth, 15);
});

test("cohortTable aggregates quality per cohort, absent when no session carries one", () => {
  const rows = cohortTable([
    { pluginVersion: "0.9.2", costByStage: { a: 1.0 }, medianDepth: 10,
      quality: { tasks: 2, reviewRounds: 3, retries: 1, blockingFindings: 1,
                 conformanceFailures: 0, roundsPerTask: 1.5 } },
    { pluginVersion: "0.9.2", costByStage: { a: 1.0 }, medianDepth: 10,
      quality: { tasks: 1, reviewRounds: 1, retries: 0, blockingFindings: 0,
                 conformanceFailures: 1, roundsPerTask: 1 } },
    { pluginVersion: "0.10.1", costByStage: { a: 1.0 }, medianDepth: 10, quality: null },
  ]);
  const v092 = rows.find((r) => r.version === "0.9.2");
  // Summed across every session in the cohort that carries a quality record, not overwritten
  // or averaged away by the session that doesn't.
  assert.strictEqual(v092.quality.tasks, 3);
  assert.strictEqual(v092.quality.reviewRounds, 4);
  assert.strictEqual(v092.quality.retries, 1);
  assert.strictEqual(v092.quality.blockingFindings, 1);
  assert.strictEqual(v092.quality.conformanceFailures, 1);
  // A cohort with no quality-bearing session at all reports absent, never a zeroed-out object
  // that would read as flawless work.
  const v0101 = rows.find((r) => r.version === "0.10.1");
  assert.strictEqual(v0101.quality, null);
});

test("cohortTable orders versions numerically with unknown last", () => {
  const rows = cohortTable([
    { pluginVersion: "0.10.1", costByStage: { a: 1 }, medianDepth: 1 },
    { pluginVersion: null, costByStage: { a: 1 }, medianDepth: 1 },
    { pluginVersion: "0.4.0", costByStage: { a: 1 }, medianDepth: 1 },
    { pluginVersion: "0.9.2", costByStage: { a: 1 }, medianDepth: 1 },
  ]);
  assert.deepStrictEqual(rows.map((r) => r.version), ["0.4.0", "0.9.2", "0.10.1", "unknown"]);
});

test("the default text report renders the cohort table", () => {
  const rendered = { costUSD: 1.0, models: {}, tools: {} };
  const text = formatReport([
    { ...rendered, pluginVersion: "0.9.2", costByStage: { a: 1.0 }, medianDepth: 10 },
    { ...rendered, pluginVersion: "0.10.1", costByStage: { a: 2.0 }, medianDepth: 20 },
  ]);
  assert.match(text, /0\.9\.2/);
  assert.match(text, /0\.10\.1/);
  // The version strings alone are already printed by the version-regression candidate line, so
  // pin the table itself: a row per cohort carrying its n.
  assert.match(text, /Per-version cohorts:/);
  assert.match(text, /0\.9\.2\s+n=\s*1/);
  assert.match(text, /0\.10\.1\s+n=\s*1/);
});

test("the text report's cohort table pairs each cohort's cost with its quality", () => {
  const text = formatReport([
    { pluginVersion: "0.9.2", costByStage: { a: 1.0 }, medianDepth: 10,
      quality: { tasks: 2, reviewRounds: 3, retries: 1, blockingFindings: 1,
                 conformanceFailures: 0, roundsPerTask: 1.5 } },
    { pluginVersion: "0.10.1", costByStage: { a: 2.0 }, medianDepth: 20, quality: null },
  ]);
  const cohortLines = text.split("\n").filter((l) => /^\s*0\.\d/.test(l));
  const v092Line = cohortLines.find((l) => l.includes("0.9.2"));
  const v0101Line = cohortLines.find((l) => l.includes("0.10.1"));
  assert.match(v092Line, /quality: 1\.5 rounds\/task/);
  // Absent quality on a cohort row must render its own label, not read as zero rounds.
  assert.match(v0101Line, /quality: (unavailable|no run record)/i);
  assert.doesNotMatch(v0101Line, /0 review rounds/);
});

test("the report prints the depth-band fraction-of-window caveat", () => {
  const rendered = { costUSD: 1.0, models: {}, tools: {} };
  const text = formatReport([
    { ...rendered, pluginVersion: "0.10.1", costByStage: { a: 1.0 }, medianDepth: 10 },
  ]);
  assert.match(text, /fraction of the .*window/i);
});

// --- qualitySignals: every cost figure is paired with a quality signal (A6) ---

test("qualitySignals aggregates rounds, retries and blocking findings per run", () => {
  const q = qualitySignals({
    dispatches: [
      { taskId: "1", reviewRound: 0, retryIndex: 0 },
      { taskId: "1", reviewRound: 1, retryIndex: 1 },
      { taskId: "2", reviewRound: 0, retryIndex: 0 },
    ],
    verdicts: [
      { taskId: "1", round: 1, blockingCount: 2, conformance: "fail" },
      { taskId: "1", round: 2, blockingCount: 0, conformance: "pass" },
      { taskId: "2", round: 1, blockingCount: 0, conformance: "pass" },
    ],
  });
  assert.strictEqual(q.tasks, 2);
  assert.strictEqual(q.reviewRounds, 3);
  assert.strictEqual(q.retries, 1);
  assert.strictEqual(q.blockingFindings, 2);
  assert.strictEqual(q.conformanceFailures, 1);
  assert.strictEqual(q.roundsPerTask, 1.5);
});

test("a record-less run reports quality as absent, never as zero", () => {
  assert.strictEqual(qualitySignals(null), null);
  const text = formatReport([
    { pluginVersion: "0.10.1", costByStage: { a: 1.0 }, medianDepth: 10,
      attributionSource: "forward-filled", quality: null },
  ]);
  // "0 review rounds" would read as flawless work rather than as no data.
  assert.doesNotMatch(text, /0 review rounds/);
  assert.match(text, /quality: (unavailable|no run record)/i);
});

test("the report pairs cost with rounds per task so a cheaper-but-worse run is visible", () => {
  const text = formatReport([
    { pluginVersion: "0.13.0", costByStage: { a: 5.0 }, medianDepth: 10,
      quality: { tasks: 4, reviewRounds: 12, retries: 5, blockingFindings: 9,
                 conformanceFailures: 2, roundsPerTask: 3 } },
  ]);
  assert.match(text, /rounds\/task/i);
  assert.match(text, /3/);
});

test("--json carries the quality signals beside the cost", () => {
  const json = buildJsonReport([
    { pluginVersion: "0.13.0", costByStage: { a: 5.0 }, medianDepth: 10,
      quality: { tasks: 4, reviewRounds: 12, retries: 5, blockingFindings: 9,
                 conformanceFailures: 2, roundsPerTask: 3 } },
  ]);
  assert.strictEqual(json.sessions[0].quality.roundsPerTask, 3);
  const bare = buildJsonReport([
    { pluginVersion: "0.13.0", costByStage: { a: 5.0 }, medianDepth: 10, quality: null },
  ]);
  assert.strictEqual(bare.sessions[0].quality, null);
});

test("--json's version_cohorts carry each cohort's quality beside its cost", () => {
  const json = buildJsonReport([
    { pluginVersion: "0.13.0", costByStage: { a: 5.0 }, medianDepth: 10,
      quality: { tasks: 4, reviewRounds: 12, retries: 5, blockingFindings: 9,
                 conformanceFailures: 2, roundsPerTask: 3 } },
    { pluginVersion: "0.14.0", costByStage: { a: 1.0 }, medianDepth: 10, quality: null },
  ]);
  const withQuality = json.version_cohorts.find((r) => r.version === "0.13.0");
  const withoutQuality = json.version_cohorts.find((r) => r.version === "0.14.0");
  assert.strictEqual(withQuality.quality.roundsPerTask, 3);
  assert.strictEqual(withQuality.quality.blockingFindings, 9);
  // No quality-bearing session in the cohort means absent, never a zeroed-out object.
  assert.strictEqual(withoutQuality.quality, null);
});
