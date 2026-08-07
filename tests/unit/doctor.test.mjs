// Metric computation and safety rules in scripts/doctor.mjs, exercised
// against synthetic transcripts. No real session transcript is ever read.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, chmodSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  parseArgs, isDevcycleSession, contextDepth, costUSD, depthBand, median,
  summarizeSession, formatReport, budgetBand, resolveDepth,
  extractPluginVersion, emitCandidates, configDrift, findTranscriptFiles,
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
  assert.deepEqual(a, { dir: "/tmp/x", since: "2026-07-01", until: "2026-07-31", json: true, all: false, depth: false, drift: null });
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

test("summarizeSession: forward-fills attribution onto trailing untagged turns in the same transcript", () => {
  const recs = [
    turn({ attributionSkill: "devcycle:executing-waves" }),
    turn({}),
    turn({}),
  ];
  const s = summarizeSession("sess-abcdef123456", recs);
  assert.equal(s.costByStage.unattributed, undefined);
  assert.equal(s.costByStage["devcycle:executing-waves"] > 0, true);
});

test("summarizeSession: forward-fill does not cross transcripts", () => {
  const recs = [
    turn({ attributionSkill: "devcycle:executing-waves" }),
    turn({}),
    turn({ isSidechain: true, agentId: "agent-1" }),
  ];
  const s = summarizeSession("sess-abcdef123456", recs);
  assert.equal(s.costByStage.unattributed > 0, true);
  assert.equal(s.costByStage["devcycle:executing-waves"] > s.costByStage.unattributed, true);
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

// emitCandidates() is computed but must actually reach the documented CLI surface — the
// playbook layer (playbooks/profiling-sessions.md) has nothing to rank/report on otherwise.
test("cli: --json emits a candidates array carrying emitCandidates' signals", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-candidates-"));
  const slug = join(dir, "-Users-x-proj");
  mkdirSync(slug, { recursive: true });
  writeFileSync(
    join(slug, "sess-ffff.jsonl"),
    JSON.stringify(turn({ attributionSkill: "devcycle:executing-waves" })) +
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
  assert.match(out.stdout, /unpriced-model/);
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
    { id: "s1", costByStage: { "devcycle:executing-waves": 0.1 }, pluginVersion: "0.9.2", medianDepth: 10000, unpriced: {} },
    { id: "s2", costByStage: { "devcycle:executing-waves": 0.11 }, pluginVersion: "0.9.2", medianDepth: 10000, unpriced: {} },
    { id: "s3", costByStage: { "devcycle:executing-waves": 0.09 }, pluginVersion: "0.9.2", medianDepth: 10000, unpriced: {} },
    { id: "s4", costByStage: { "devcycle:executing-waves": 5.0 }, pluginVersion: "0.9.2", medianDepth: 10000, unpriced: {} },
  ];
  const candidates = emitCandidates(summaries);
  const outlier = candidates.find(
    (c) => c.type === "cost-outlier" && c.skill === "devcycle:executing-waves"
  );
  assert.ok(outlier, "expected a cost-outlier candidate");
  assert.strictEqual(outlier.dollars, 5.0);
});

test("emitCandidates does not flag a cost-outlier when costs are uniform across runs", () => {
  const summaries = [
    { id: "s1", costByStage: { "devcycle:executing-waves": 0.1 }, pluginVersion: "0.9.2", medianDepth: 10000, unpriced: {} },
    { id: "s2", costByStage: { "devcycle:executing-waves": 0.11 }, pluginVersion: "0.9.2", medianDepth: 10000, unpriced: {} },
    { id: "s3", costByStage: { "devcycle:executing-waves": 0.09 }, pluginVersion: "0.9.2", medianDepth: 10000, unpriced: {} },
    { id: "s4", costByStage: { "devcycle:executing-waves": 0.1 }, pluginVersion: "0.9.2", medianDepth: 10000, unpriced: {} },
  ];
  const candidates = emitCandidates(summaries);
  const outlier = candidates.find((c) => c.type === "cost-outlier");
  assert.equal(outlier, undefined);
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
