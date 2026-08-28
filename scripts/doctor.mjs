#!/usr/bin/env node
// Re-measures devcycle's token cost from session transcripts: turn counts, main-thread
// vs subagent split, context depth, tool mix, and dollar cost by model, stage, and agent.
// Read-only by default — it emits counts, dollars, model ids, tool names, and skill names only,
// and runs no promotion `- verify:` check unless invoked with --run-checks.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// The one owner of CLI flag parsing across the scripts; an unrecognised flag is fatal here rather
// than a silent no-op that would profile the default corpus instead of the one asked for.
import { parseFlags, requireValue } from "./cli-flags.mjs";
import { PRICING, priceFor } from "./pricing.mjs";
// The one reader of this repo's promotion records; doctor's Cost-by-version "Shipped" column
// names what each version shipped rather than parsing those records a second time here.
import { readPromotions } from "./promotions.mjs";
import { atomicWrite } from "./atomic-write.mjs";
// The shared verification engine (Wave 2): the one source of the promotion scoreboard, the
// escalation/retirement candidates and the resolved-in lines, plus the installed plugin version.
// doctor renders these, never recomputes them — the configDrift engine/renderer precedent.
import { verify, installedVersion, releaseDates, defaultRunCheck } from "./verification.mjs";

// The plugin root, derived from this script's own location (scripts/ is a sibling of
// references/). `CLAUDE_PLUGIN_ROOT` is substituted into command and playbook *text* but is
// not in a script's own environment, and the documented `--drift` invocation runs from the
// target repo — so reading it from process.env resolved the changelog against the wrong
// tree. See docs/platform-notes.md section (c).
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHANGELOG_PATH = join(PLUGIN_ROOT, "references", "config-changelog.md");

// The plugin's own release changelog, under a name distinct from CHANGELOG_PATH above, which
// configDrift already holds for references/config-changelog.md. Resolved from PLUGIN_ROOT for
// the same reason that one is: --drift runs from the target repo, not from the plugin tree.
const RELEASE_CHANGELOG_PATH = join(PLUGIN_ROOT, "CHANGELOG.md");

// `from-doctor` issues are filed against devcycle itself, wherever doctor happens to run. A
// bare `gh issue list` resolves to the host repo, so the Outer loop section would render zeros
// in every repo except this one — the failure this constant exists to prevent.
export const DEVCYCLE_UPSTREAM = "KonstantinRoehrl/devcycle";

// Drafted markers began being recorded in this release; reports written before it carry none,
// so the count is qualified rather than mixing "none drafted" with "not recorded".
const DRAFTED_SINCE = "0.13.0";

// The bound `gh issue list --limit` is given below. Named once so the query and the truncation
// check it feeds can never drift apart.
const OUTER_LOOP_QUERY_LIMIT = 200;

const DEVCYCLE_PREFIX = /^devcycle:/;
const PLUGIN_VERSION_RE = /devcycle\/devcycle\/(\d+\.\d+\.\d+)\//;

// hashSession from scripts/run-record.mjs, reimplemented in one line rather than imported, so
// the reader keeps no dependency on the writer. The algorithm, encoding and digest form must
// stay byte-identical to the writer's or the join silently misses every session.
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

export function extractPluginVersion(record) {
  const text = JSON.stringify(record ?? {});
  const m = text.match(PLUGIN_VERSION_RE);
  return m ? m[1] : null;
}

// Records Claude Code writes for its own placeholders (session-limit notices and the like).
// Every counter on them is zero, so they are skipped outright rather than reported unpriced.
const SYNTHETIC_MODEL = "<synthetic>";

// Tool calls that dispatch a subagent; a call with no explicit model inherits the caller's.
const DISPATCH_TOOLS = new Set(["Task", "Agent"]);

// Each flag names its arity, so cli-flags.mjs knows which of them take the next token. The four
// valueless ones are why that matters here: while they were assumed value-taking, `--json
// /fixture` -- the natural slip for `--json --dir /fixture` -- ate the path and profiled the
// operator's real home corpus instead.
const KNOWN_FLAGS = {
  "--dir": "value", "--since": "value", "--until": "value",
  "--json": "none", "--all": "none", "--depth": "none", "--run-checks": "none",
  "--drift": "value", "--issue-body": "value",
};

// Throws rather than exiting on a usage error: doctor.mjs is imported by dream.mjs, so a
// process.exit inside the parser would take the importer down with it. main() catches and prints
// with doctor's own prefix.
//
// Only flags are read here, and cli-flags.mjs refuses a bare token by default, so `doctor.mjs
// /fixture` -- the natural slip for `--dir /fixture` -- is a usage error rather than a clean
// report about the operator's real home corpus.
export function parseArgs(argv) {
  const { flags } = parseFlags(argv, KNOWN_FLAGS);
  // Each flag says what it wants: --since/--until are dates and --issue-body is a culprit name,
  // so only --dir and --drift take the parser's default "a path argument" wording.
  const valued = (name, noun) => requireValue(flags, name, noun) ?? null;
  return {
    dir: requireValue(flags, "--dir") ?? join(homedir(), ".claude", "projects"),
    since: valued("--since", "a date"),
    until: valued("--until", "a date"),
    json: "--json" in flags,
    all: "--all" in flags,
    depth: "--depth" in flags,
    runChecks: "--run-checks" in flags,
    drift: valued("--drift"),
    issueBody: valued("--issue-body", "a culprit name"),
  };
}

export function isDevcycleSession(records) {
  for (const r of records) {
    if (DEVCYCLE_PREFIX.test(r.attributionSkill ?? "")) return true;
    const content = r.message?.content;
    if (!Array.isArray(content)) continue;
    // Nothing devcycle emits today reaches this arm — the plugin ships no skills, and
    // validate.mjs check 3 forbids naming a playbook by a `devcycle:` id. It stays for
    // pre-v0.12 transcripts, which are the corpus on any machine that ran an earlier release.
    for (const item of content) {
      if (
        item &&
        item.type === "tool_use" &&
        item.name === "Skill" &&
        typeof item.input?.skill === "string" &&
        DEVCYCLE_PREFIX.test(item.input.skill)
      )
        return true;
    }
  }
  return false;
}

export function contextDepth(usage) {
  return (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
}

// A 1h cache write costs 2.00x the input price, a 5m write 1.25x. Named once, beside the other
// module-level constants, because the same two numbers price the exact path and both band edges.
const CACHE_WRITE_1H_MULTIPLIER = 2.0;
const CACHE_WRITE_5M_MULTIPLIER = 1.25;

// Dollars for one request. Returns null when the model is not in the pricing table, so the
// caller can report it and exclude it instead of silently defaulting to a price.
export function costUSD(usage, model) {
  const p = priceFor(model);
  if (!p) return null;
  const cc = usage.cache_creation ?? {};
  const h1 = cc.ephemeral_1h_input_tokens ?? 0;
  const m5 = cc.ephemeral_5m_input_tokens ?? 0;
  // 39% of observed cache writes are 1h (2.00x). Only when no TTL breakdown is present does
  // the flat counter stand in, billed at the 5m rate.
  const write =
    h1 + m5 > 0
      ? h1 * p.in * CACHE_WRITE_1H_MULTIPLIER + m5 * p.in * CACHE_WRITE_5M_MULTIPLIER
      : (usage.cache_creation_input_tokens ?? 0) * p.in * CACHE_WRITE_5M_MULTIPLIER;
  const perMillion =
    (usage.input_tokens ?? 0) * p.in +
    write +
    (usage.cache_read_input_tokens ?? 0) * p.in * 0.1 +
    (usage.output_tokens ?? 0) * p.out;
  return perMillion / 1e6;
}

// Cache-write pricing is the one genuinely unrecoverable number. A record carrying the 1h/5m split
// is priced exactly; one carrying only the flat counter is priced at the 5m rate and is understated
// by up to 60%. The band is bounded below by pricing every fallback-priced write at 5m and above by
// pricing them all at 1h.
export function costBand(records) {
  let exact = 0, exactTokens = 0, fallbackTokens = 0, fallbackDollarsAt5m = 0, fallbackDollarsAt1h = 0;
  for (const r of records) {
    const u = r.message?.usage ?? r.usage ?? {};
    const model = r.message?.model ?? r.model;
    const p = priceFor(model);
    // An unpriced model must not throw on `p.in` (costUSD guards the same way with `if (!p)` at
    // :88, resolveDepth with `?.` at :166) and must not enter the band's numerator OR its
    // totalTokens denominator — leaving it in the denominator while it prices at nothing would
    // understate cost-per-token by exactly the unpriced share, the same plausible-and-wrong shape
    // the /1e6 fix above corrects. `costBand` has no reference to the per-session `unpriced` tally
    // (`:458`) to bump — the real partition happens one level up, in Step 5.
    if (!p) continue;
    const h1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const m5 = u.cache_creation?.ephemeral_5m_input_tokens ?? 0;
    if (h1 + m5 > 0) {
      exact += h1 * p.in * CACHE_WRITE_1H_MULTIPLIER + m5 * p.in * CACHE_WRITE_5M_MULTIPLIER;
      exactTokens += h1 + m5;
    } else {
      const flat = u.cache_creation_input_tokens ?? 0;
      fallbackTokens += flat;
      fallbackDollarsAt5m += flat * p.in * CACHE_WRITE_5M_MULTIPLIER;
      fallbackDollarsAt1h += flat * p.in * CACHE_WRITE_1H_MULTIPLIER;
    }
  }
  // Every cache-write token seen, split-priced or not — this is the denominator the report renders
  // as "% of cache-write tokens lack a TTL split", so it must be tokens, never a record count.
  const totalTokens = exactTokens + fallbackTokens;
  // p.in is dollars per MILLION tokens, same as costUSD (:98-103) — every dollar figure below must
  // divide by 1e6 or the report renders a figure six orders of magnitude too large.
  return {
    point: (exact + fallbackDollarsAt5m) / 1e6,
    low: (exact + fallbackDollarsAt5m) / 1e6,
    high: (exact + fallbackDollarsAt1h) / 1e6,
    fallbackShare: totalTokens === 0 ? 0 : fallbackTokens / totalTokens,
    collapsed: fallbackTokens === 0,
  };
}

const BANDS = [
  [50_000, "0-50k"],
  [100_000, "50-100k"],
  [150_000, "100-150k"],
  [200_000, "150-200k"],
  [300_000, "200-300k"],
];

export const BAND_LABELS = [...BANDS.map(([, label]) => label), "300k+"];

export function depthBand(depth) {
  for (const [ceiling, label] of BANDS) if (depth < ceiling) return label;
  return "300k+";
}

// Fractions of the running model's context window. The underlying measurement is absolute —
// cost per 1k output tokens bottoms at 15.1k in the 100-150k band and climbs to 40.7k past
// 300k — taken on 1M-window sessions, so these fractions are those absolutes divided by 1M.
// Expressing them as fractions is a deliberate approximation that lets them adapt to smaller
// windows; cache-read cost actually scales with absolute tokens, not with the fraction used.
// Doctor's own per-model band data is what should confirm or correct them once smaller-window
// sessions have been measured.
const OVER_BUDGET = 0.15;
const HARD_STOP = 0.2;

export function budgetBand(depth, window) {
  const f = depth / window;
  if (f >= HARD_STOP) return "hard-stop";
  if (f >= OVER_BUDGET) return "over-budget";
  return "ok";
}

// CLAUDE_DOCTOR_PROJECTS overrides the transcript root; it exists so the probe is testable
// without writing into the real ~/.claude. It defaults to ~/.claude/projects.
export function resolveDepth(env, cwd) {
  const id = env.CLAUDE_CODE_SESSION_ID;
  if (!id) throw new Error("CLAUDE_CODE_SESSION_ID is not set — cannot identify this session");
  const root = env.CLAUDE_DOCTOR_PROJECTS || join(homedir(), ".claude", "projects");

  // 1. cwd slug, 2. a filename search for a session whose cwd moved after it started.
  const direct = join(root, cwd.replaceAll("/", "-"), `${id}.jsonl`);
  const file = existsSync(direct)
    ? direct
    : (findTranscriptFiles(root) ?? []).find((f) => basename(f) === `${id}.jsonl`);
  if (!file) throw new Error(`no transcript found for session ${id} under ${root}`);

  let last = null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"usage"')) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue; // transcripts are appended live; a torn trailing line is normal
    }
    if (r.message?.usage && r.message.model && r.message.model !== SYNTHETIC_MODEL) last = r.message;
  }
  if (!last) throw new Error(`no usage record in ${basename(file)} — nothing to measure`);

  const depth = contextDepth(last.usage);
  const window = priceFor(last.model)?.window;
  if (!window) throw new Error(`model ${last.model} is not in the pricing table — no window to measure against`);
  return { depth, model: last.model, window, fraction: depth / window, band: budgetBand(depth, window) };
}

export function median(numbers) {
  if (!numbers.length) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Versions are compared numerically, never lexicographically. The default Array.sort() put
// "0.10.1" before "0.4.0", so the 0.9.2 -> 0.10.1 comparison was never made (four real
// regressions lost) and 0.11.1 -> 0.4.0 ran backwards in time.
export function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return String(a).localeCompare(String(b));
    if (x !== y) return x - y;
  }
  return 0;
}

// Buckets a run's changed-line count (insertions + deletions) into a size band by the published
// thresholds (GC6 — no invented weighted score). A null count is workload-unknown, never zero.
export function bandFor(changedLines) {
  if (changedLines == null) return null;
  if (changedLines < 20) return "XS";
  if (changedLines < 100) return "S";
  if (changedLines < 500) return "M";
  if (changedLines < 2000) return "L";
  return "XL";
}

// The installed version plus up to `span` semver-prior *released* versions, newest last — the
// recency window a like-for-like comparison ranges over. Sorts the released set with the shared
// compareVersions (QC2), then slices the window ending at the installed version. A dev checkout's
// version may not be in the released set, so it is appended rather than assumed present.
export function recencyBand(installed, releaseDatesMap, span = 2) {
  if (!installed) return [];
  const released = [...releaseDatesMap.keys()].sort(compareVersions);
  const idx = released.indexOf(installed);
  const end = idx === -1 ? released.length : idx + 1;   // installed may be unreleased (dev)
  const start = Math.max(0, end - (span + 1));
  const window = released.slice(start, end);
  return window.includes(installed) ? window : [...window, installed];
}

export const inBand = (version, band) => band.includes(version);

// A culprit's temporal standing against the recency band: where its occurrence versions sit
// relative to the window a like-for-like comparison ranges over (recencyBand). Any occurrence
// inside the band means the problem is still live ("active"). Entirely before the band, the split
// turns on the newest version it was seen at: the one release immediately below the band is
// "unresolved" (it was happening right up to the window and may simply not have recurred yet),
// anything older is "legacy" (a problem a newer release has very likely moved past).
//
// Only these three — active/legacy/unresolved — are emitted this cycle. "fixed" and "regressed"
// are deferred: distinguishing them needs shipped-fix data threaded in per culprit, and the
// promotion `culpritId` a "fixed" verdict would key off is not written to disk yet (see the
// versionProfileTable `shipped` note), so classifying them now would be inert. They stay members
// of the return type only because that later refinement — once promotion culpritId capture lands
// — will resolve them without changing this signature.
// @returns {"active"|"legacy"|"unresolved"} this cycle ("fixed"/"regressed" reserved, not emitted)
export function lifecycle(versionsSeen, band, releaseDatesMap) {
  const seen = (versionsSeen ?? []).filter((v) => v && v !== "unknown");
  if (!seen.length) return "legacy";
  if (seen.some((v) => inBand(v, band))) return "active";
  // Entirely pre-band: is the newest occurrence the single release immediately below the band?
  const released = [...(releaseDatesMap?.keys() ?? [])].sort(compareVersions);
  const preBand = band.length ? released[released.indexOf(band[0]) - 1] : undefined;
  const newestSeen = [...seen].sort(compareVersions).at(-1);
  return preBand && newestSeen === preBand ? "unresolved" : "legacy";
}

// One row per distinct run, joining the run's member sessions into a run-level record. Sessions
// with no runId stay observational and never enter a run (GC5). version/profile come from the
// first member that actually reported one (not "unknown"); the workload fields come from the
// joined workload record and are null when the run wrote none (GC3 — absent, not zero).
// The workload join is already resolved onto each summary by summarizeSession, so the run
// records themselves are never re-read here — this reads only from the summaries.
export function runAggregates(summaries) {
  const byRun = new Map();
  for (const s of summaries.filter((s) => s.runId)) {
    if (!byRun.has(s.runId)) byRun.set(s.runId, []);
    byRun.get(s.runId).push(s);
  }
  const firstKnown = (members, key) =>
    members.map((m) => m[key]).find((v) => v && v !== "unknown") ?? "unknown";
  const out = [];
  for (const [runId, members] of byRun) {
    const wl = members.map((m) => m.workload).find((w) => w) ?? null;
    const changedLines = wl ? wl.insertions + wl.deletions : null;
    const qualities = members.map((m) => m.quality).filter(Boolean);
    out.push({
      runId,
      version: firstKnown(members, "pluginVersion"),
      profile: firstKnown(members, "profile"),
      requestKind: wl?.requestKind ?? null,
      workloadBand: bandFor(changedLines),
      changedLines,
      // Raw observed workload counts, straight off the workload record; null (never 0) when the
      // run wrote none, so an absent record never reads as zero work (GC3).
      filesChanged: wl?.filesChanged ?? null,
      waveCount: wl?.waveCount ?? null,
      costUSD: members.reduce((n, m) => n + (m.costUSD ?? 0), 0),
      mainTurns: members.reduce((n, m) => n + (m.mainTurns ?? 0), 0),
      subagentTurns: members.reduce((n, m) => n + (m.subagentTurns ?? 0), 0),
      medianDepth: median(members.map((m) => m.medianDepth ?? 0)),
      tasks: wl?.plannedTaskCount ?? null,
      // No conformance-pass signal exists on a summary yet; derived from the quality signals when
      // any member carries one (pass = zero conformance failures), null when none do (QC1).
      conformancePass: qualities.length
        ? qualities.every((q) => (q.conformanceFailures ?? 0) === 0)
        : null,
      reviewRounds: qualities.reduce((n, q) => n + (q.reviewRounds ?? 0), 0),
      retries: qualities.reduce((n, q) => n + (q.retries ?? 0), 0),
      sessionIds: members.map((m) => m.id),
    });
  }
  return out;
}

// A session whose plugin version cannot be read is bucketed as "unknown" and reported, never
// dropped. extractPluginVersion regexes the version out of transcript JSON, so dev-checkout
// sessions — the ones that built devcycle — yielded null and were invisible to devcycle's own
// trend analysis.
export function versionCohorts(summaries) {
  const cohorts = new Map();
  for (const s of summaries) {
    const key = s.pluginVersion ?? "unknown";
    if (!cohorts.has(key))
      cohorts.set(key, { sessions: 0, dollars: [], depths: [], byStage: new Map(), qualities: [] });
    const c = cohorts.get(key);
    c.sessions++;
    let sessionTotal = 0;
    for (const [skill, d] of Object.entries(s.costByStage ?? {})) {
      if (!c.byStage.has(skill)) c.byStage.set(skill, []);
      c.byStage.get(skill).push(d);
      sessionTotal += d;
    }
    c.dollars.push(sessionTotal);
    if (typeof s.medianDepth === "number") c.depths.push(s.medianDepth);
    c.qualities.push(s.quality ?? null);
  }
  return cohorts;
}

// Rolls up several sessions' quality signals into one cohort-level figure — sums across every
// session that carries one, so a cohort with a mix of recorded and record-less sessions still
// reports on the recorded subset rather than going null on the first gap. Null only when the
// whole cohort has no run record, same "absent, not zero" rule as qualitySignals itself.
function aggregateQuality(qualities) {
  const present = qualities.filter(Boolean);
  if (!present.length) return null;
  const tasks = present.reduce((n, q) => n + q.tasks, 0);
  const reviewRounds = present.reduce((n, q) => n + q.reviewRounds, 0);
  const retries = present.reduce((n, q) => n + q.retries, 0);
  const blockingFindings = present.reduce((n, q) => n + q.blockingFindings, 0);
  const conformanceFailures = present.reduce((n, q) => n + q.conformanceFailures, 0);
  return {
    tasks,
    reviewRounds,
    retries,
    blockingFindings,
    conformanceFailures,
    roundsPerTask: tasks === 0 ? 0 : reviewRounds / tasks,
  };
}

// The per-version comparison table: one row per cohort, ordered oldest to newest with the
// undetectable-version bucket last so it never sits between two real versions.
export function cohortTable(summaries) {
  const settled = summaries.filter((s) => !s.inFlight);
  const cohorts = versionCohorts(settled);
  const known = [...cohorts.keys()].filter((v) => v !== "unknown").sort(compareVersions);
  const order = cohorts.has("unknown") ? [...known, "unknown"] : known;
  return order.map((version) => {
    const c = cohorts.get(version);
    return {
      version,
      sessions: c.sessions,
      total: c.dollars.reduce((a, b) => a + b, 0),
      medianPerSession: median(c.dollars),
      medianDepth: c.depths.length ? median(c.depths) : null,
      quality: aggregateQuality(c.qualities),
      inferred: version === "unknown" ? "no version detectable" : null,
    };
  });
}

// The reviewDepth-cohort counterpart to versionCohorts/cohortTable above: same shape, grouped
// by the resolved value of the `reviewDepth` knob (the knob most directly tied to review rigor,
// and the one already exercised by this cycle's single/panel distinction) instead of
// pluginVersion, so a knob's effect on review rounds/cost is visible the same way a version's
// is. Reuses aggregateQuality rather than re-deriving its arithmetic. A session with no knob
// data (pre branch-fix-2-3's --knob wiring, or a run that never resolved the knob) buckets
// under "unknown" — same convention cohortTable's own "unknown" version bucket already uses,
// never dropped silently.
export function reviewDepthCohortTable(summaries) {
  const settled = summaries.filter((s) => !s.inFlight);
  const cohorts = new Map();
  for (const s of settled) {
    const key = s.knobs?.reviewDepth ?? "unknown";
    if (!cohorts.has(key)) cohorts.set(key, { sessions: 0, dollars: [], depths: [], qualities: [] });
    const c = cohorts.get(key);
    c.sessions++;
    c.dollars.push(Object.values(s.costByStage ?? {}).reduce((a, b) => a + b, 0));
    if (typeof s.medianDepth === "number") c.depths.push(s.medianDepth);
    c.qualities.push(s.quality ?? null);
  }
  const known = [...cohorts.keys()].filter((v) => v !== "unknown").sort();
  const order = cohorts.has("unknown") ? [...known, "unknown"] : known;
  return order.map((reviewDepth) => {
    const c = cohorts.get(reviewDepth);
    return {
      reviewDepth,
      sessions: c.sessions,
      total: c.dollars.reduce((a, b) => a + b, 0),
      medianPerSession: median(c.dollars),
      medianDepth: c.depths.length ? median(c.depths) : null,
      quality: aggregateQuality(c.qualities),
      inferred: reviewDepth === "unknown" ? "no reviewDepth knob recorded" : null,
    };
  });
}

const DIRECTION_MIN_COHORT = 3; // below this the confidence column flags a version unreliable (#127)

// Normalized like every other cross-version figure (issue #127): hold profile|requestKind|
// workloadBand constant by scoring within one matched cohort, and never anchor an endpoint on a
// version the confidence column flags unreliable (n<3) — widen inward to the nearest reliable
// version, or report no reliable trend. Reuses matchKeyOf/median/pctDelta/compareVersions (QC2).
export function corpusDirectionOfTravel(runs) {
  const scored = (runs ?? []).filter((r) => r.requestKind != null && r.workloadBand != null);
  const byKey = new Map();
  for (const r of scored) {
    const perVersion = byKey.get(matchKeyOf(r)) ?? new Map();
    const arr = perVersion.get(r.version) ?? [];
    arr.push(r.costUSD);
    perVersion.set(r.version, arr);
    byKey.set(matchKeyOf(r), perVersion);
  }
  let best = null;
  for (const [key, perVersion] of byKey) {
    const reliable = [...perVersion.entries()]
      .filter(([v, arr]) => v !== "unknown" && arr.length >= DIRECTION_MIN_COHORT)
      .map(([v]) => v)
      .sort(compareVersions);
    if (reliable.length < 2) continue;
    if (!best || reliable.length > best.reliable.length) best = { key, perVersion, reliable };
  }
  if (!best)
    return { direction: "insufficient-data", deltaPct: null,
      reason: "no matched cohort spans two versions with n>=3" };
  const first = median(best.perVersion.get(best.reliable[0]));
  const last = median(best.perVersion.get(best.reliable[best.reliable.length - 1]));
  const deltaPct = pctDelta(first, last);
  if (deltaPct == null)
    return { direction: "insufficient-data", deltaPct: null,
      reason: "the oldest reliable cohort has a zero median" };
  return { direction: deltaPct > 1 ? "up" : deltaPct < -1 ? "down" : "flat", deltaPct,
    matchKey: best.key, from: best.reliable[0], to: best.reliable[best.reliable.length - 1] };
}

// A cohort of one is a sample, not a trend. Marked at every render site rather than left for
// the reader to infer from sessions_sampled.
const isLowConfidence = (c) => c.sessions_sampled === 1;

export function emitCandidates(summaries) {
  const candidates = [];

  // A session still being written has only part of its cost recorded, so it is excluded from
  // every median-based comparison below: the same live session measured 15 minutes apart moved
  // one cohort's regression from 6663.6% to 7317.9%. It stays in the corpus and is still counted
  // and reported per session — only the medians ignore it.
  const settled = summaries.filter((s) => !s.inFlight);

  // Unpriced-model usage — already computed per summary.
  for (const s of summaries) {
    for (const [model, count] of Object.entries(s.unpriced ?? {})) {
      candidates.push({
        type: "unpriced-model",
        skill: null,
        version_from: null,
        version_to: null,
        delta_pct: null,
        dollars: null,
        sessions_sampled: 1,
        model,
        count,
      });
    }
  }

  // Version-over-version regression/improvement — same skill, cost moved between two adjacent
  // version cohorts. "unknown" (no detectable plugin version) has no position in a version
  // ordering, so it is excluded here — but versionCohorts() above still buckets it, and the
  // cohort table (Task 16) still renders it, rather than dropping those sessions.
  const byVersion = new Map(); // version -> { skill -> [dollars] }
  for (const [version, c] of versionCohorts(settled)) byVersion.set(version, c.byStage);
  const versions = [...byVersion.keys()].filter((v) => v !== "unknown").sort(compareVersions);
  const versionCandidates = [];
  for (let i = 0; i + 1 < versions.length; i++) {
    const from = versions[i];
    const to = versions[i + 1];
    const fromSkills = byVersion.get(from);
    const toSkills = byVersion.get(to);
    for (const [skill, fromDollars] of fromSkills) {
      if (!toSkills.has(skill)) continue;
      const fromMedian = median(fromDollars);
      const toDollars = toSkills.get(skill);
      const toMedian = median(toDollars);
      if (fromMedian <= 0) continue;
      const delta_pct = ((toMedian - fromMedian) / fromMedian) * 100;
      const delta_dollars = toMedian - fromMedian;
      if (Math.abs(delta_pct) > 20) {
        versionCandidates.push({
          type: delta_pct > 0 ? "version-regression" : "version-improvement",
          skill,
          version_from: from,
          version_to: to,
          versions: [from, to],
          delta_pct,
          from_dollars: fromMedian,
          dollars: toMedian,
          delta_dollars,
          sessions_sampled: toDollars.length,
        });
      }
    }
  }
  // Ranked by absolute dollar impact, not percentage: a +18013.6% move off a $0.18 median is
  // a $33 move and must not outrank a larger absolute one.
  versionCandidates.sort((a, b) => Math.abs(b.delta_dollars) - Math.abs(a.delta_dollars));
  candidates.push(...versionCandidates);

  // Depth-vs-startup-floor outliers. startupFloor is agent-type-keyed ({main: [...],
  // subagent: [...]}), not a scalar, so it is reduced to the median across every agent
  // type's samples before the comparison.
  for (const s of summaries) {
    const floor = median(Object.values(s.startupFloor ?? {}).flat());
    if (floor > 0 && s.medianDepth && s.medianDepth > floor * 3) {
      candidates.push({
        type: "depth-outlier",
        skill: null,
        version_from: null,
        version_to: null,
        versions: [s.pluginVersion, s.pluginVersion],
        delta_pct: null,
        dollars: s.costUSD ?? null,
        sessions_sampled: 1,
      });
    }
  }

  // The global-median cost-outlier is retired (issue #114): a run dear against a skill's global
  // median conflated user-driven session size with per-unit cost. Its role is now the matched-cohort
  // residual, emitted by excessCost and rendered as the `EXCESS-COST:` lines in `## Cost anomalies`.
  // The depth-outlier above is a distinct per-session depth signal excessCost does not replace, and
  // stays.

  for (const c of candidates) c.low_confidence = isLowConfidence(c);
  return candidates;
}

// These three measure rules that already exist in references/delegation.md but had no enforcement.
// A record-less session yields nothing at all rather than a misleading zero — absence of evidence.
export function emitComplianceCandidates(turns, record) {
  if (!record) return [];
  const out = [];

  // C1: playbooks/verifying-on-device.md dispatches agents/on-device-driver.md; driving a browser
  // is never the coordinator's. The most expensive session in the corpus cost $271.24 with
  // 103 computer and 38 javascript_tool calls on the main thread.
  const BROWSER_TOOLS = new Set([
    "computer", "javascript_tool",
    "mcp__claude-in-chrome__computer", "mcp__claude-in-chrome__javascript_tool",
  ]);
  const browser = turns.filter((t) => !t.isSidechain && BROWSER_TOOLS.has(t.toolName)).length;
  if (browser > 0)
    out.push({
      type: "main-thread-browser",
      calls: browser,
      onDevicePath: record.stages?.find((s) => s.stage === "on-device")?.path ?? null,
      note: "no path permits the coordinator to drive a browser — dispatch on-device-driver",
      sessions_sampled: 1,
    });

  // C2: the rule exists at references/delegation.md:59; this makes the gap measurable.
  const dispatches = record.dispatches ?? [];
  const inherited = dispatches.filter((d) => d.modelSource === "inherited").length;
  if (inherited > 0)
    out.push({ type: "inherited-model", inherited, total: dispatches.length, sessions_sampled: 1 });

  // C3: Explore's startup floor is 13955 against a 32711 median, ~2.3x per dispatch.
  const gp = dispatches.filter((d) => d.agentType === "general-purpose").length;
  if (gp > 0) out.push({ type: "general-purpose-search", count: gp, total: dispatches.length, sessions_sampled: 1 });

  // C4 (issue #139): reached execution and committed but recorded no workload — the collection the
  // commit-sensor hook (and finish's final refresh) should have written. GC3-safe by construction:
  // no commits => silent; audit => silent (requestKind from the independent triage line, never the
  // absent workload — the non-circular signal); workload present => silent; and a run predating the
  // triage capture (no triage line) => silent, excluding every historical orphan by construction.
  const missingCommits = record.commits ?? [];
  if (missingCommits.length > 0 && !record.workload && record.triage && record.triage.requestKind !== "audit")
    out.push({ type: "missing-workload", commits: missingCommits.length,
      requestKind: record.triage.requestKind, sessions_sampled: 1 });

  return out;
}

// Returns what it checked, not just what it found: `findings` alone cannot tell a target
// with no stale references apart from a changelog that yielded no stale keys to look for.
// Every input failure throws — a changelog it could not read or parse is a broken run, and
// reporting that as an empty findings list is the same as reporting the target clean.
export function configDrift(targetPath, changelogPath = CHANGELOG_PATH) {
  const changelogText = read(changelogPath, "config changelog");
  const yamlMatch = changelogText.match(/```yaml\n([\s\S]*?)```/);
  const records = yamlMatch ? parseChangelogYaml(yamlMatch[1]) : [];
  if (records.length === 0)
    throw new Error(`no records parsed from the config changelog at ${changelogPath} — expected a yaml block of \`- version:\` records`);
  const stale = records.filter((r) => r.change === "deprecated" || r.change === "renamed" || r.change === "removed");

  const targetLines = read(targetPath, "drift target").split("\n");
  const findings = [];
  targetLines.forEach((line, i) => {
    for (const r of stale) {
      if (r.key && line.includes(r.key)) {
        findings.push({
          file: targetPath,
          line: i + 1,
          match: line.trim(),
          key: r.key,
          supersededBy: r.note ?? r.new ?? null,
          changelogVersion: r.version,
        });
      }
    }
  });
  return { findings, recordsParsed: records.length, staleKeys: stale.length };
}

// Reads a file the caller named, turning the raw errno into a message that says which input
// failed — the drift path reports these as `doctor: <message>`, never as a stack trace.
function read(path, label) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`cannot read the ${label} at ${path} (${err.code ?? err.message})`);
  }
}

// Minimal indented-list YAML parser for config-changelog.md's fixed record shape —
// `- key: value` list items with 2-space-indented continuation keys. Not a general
// YAML parser; this repo has no YAML dependency and the changelog's shape is fixed.
function parseChangelogYaml(text) {
  const records = [];
  let current = null;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    const itemMatch = raw.match(/^-\s+(\w+):\s*(.*)$/);
    const contMatch = raw.match(/^\s+(\w+):\s*(.*)$/);
    if (itemMatch) {
      if (current) records.push(current);
      current = {};
      current[itemMatch[1]] = stripQuotes(itemMatch[2]);
    } else if (contMatch && current) {
      current[contMatch[1]] = stripQuotes(contMatch[2]);
    }
  }
  if (current) records.push(current);
  return records;
}

function stripQuotes(s) {
  const t = s.trim();
  return t.replace(/^"(.*)"$/, "$1");
}

// Only assistant-side records carrying a message.usage count as turns. Synthetic placeholders
// carry an all-zero usage block and are not requests, so they never reach the counters.
function isTurn(r) {
  return r.type === "assistant" && r.message && r.message.usage && r.message.model !== SYNTHETIC_MODEL;
}

// Who made the request: the dispatched agent type when attributed, otherwise which side of
// the main/subagent split it came from.
function agentTypeOf(r) {
  return r.attributionAgent ?? (r.isSidechain ? "subagent" : "main");
}

// Which transcript a record was appended to. Subagent transcripts carry their own agentId;
// everything else belongs to the session's own transcript.
function transcriptOf(r) {
  return r.agentId ?? r.sessionId ?? "main";
}

// Forward-fills attributionSkill within each transcript (main thread and each subagent's
// own transcript, kept separate via transcriptOf) from the last explicit tag through to
// that transcript's end or the next tag — a turn with no tag anywhere earlier in its own
// transcript stays unattributed.
function attributeForwardFill(turns) {
  const byTranscript = new Map();
  turns.forEach((r, i) => {
    const key = transcriptOf(r);
    if (!byTranscript.has(key)) byTranscript.set(key, []);
    byTranscript.get(key).push(i);
  });
  const effective = new Array(turns.length).fill(undefined);
  for (const indices of byTranscript.values()) {
    let current;
    for (const i of indices) {
      if (turns[i].attributionSkill) current = turns[i].attributionSkill;
      effective[i] = current;
    }
  }
  return effective;
}

// Bumped only when a run-record writer changes the shape this reader depends on — kept in step
// with tests/fixtures/run-record.schema.json's own `schemaVersion` const.
const CURRENT_SCHEMA_VERSION = 1;

// The run record is the machine-readable telemetry log; the ledger is the human-readable progress
// log. Neither reads the other — see references/ledger.md § The run record.
export function readRunRecords(dir = process.env.DEVCYCLE_RUNS_DIR ??
  join(homedir(), ".claude", "devcycle", "runs")) {
  const bySession = new Map();
  let repos;
  try {
    repos = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // A missing runs directory is the normal case for every session predating this cycle.
    // Any other error is a real fault and must not read as "no records".
    if (err.code !== "ENOENT" && err.code !== "ENOTDIR") throw err;
    return bySession;
  }
  for (const repo of repos.filter((e) => e.isDirectory()))
    for (const f of readdirSync(join(dir, repo.name)).filter((n) => n.endsWith(".jsonl"))) {
      // Sequential per-file windowing: a run spanning several /devcycle:continue sessions
      // writes several `session` lines into one file, and each stage/dispatch/verdict line
      // belongs to whichever session line most recently preceded it — file order is the only
      // correlation the schema supports (session lines carry no timestamp; Task 37 dropped
      // firstSeen/lastSeen as dead fields). The run line's runId/pluginVersion/profile/knobs/
      // schemaMismatch are file-scoped, not window-scoped: they apply to every window in the
      // file and do not reset on a `session` line.
      let runId = null, pluginVersion = null, profile = null, knobs = null, schemaMismatch, triage = null;
      let current = null;
      const windows = new Map(); // sessionHash -> { stages, dispatches, verdicts, events, workloads }, file order
      for (const line of readFileSync(join(dir, repo.name, f), "utf8").split("\n").filter(Boolean)) {
        let o;
        try { o = JSON.parse(line); } catch { continue; } // a torn trailing line is normal
        if (o.kind === "run") {
          runId = o.runId; pluginVersion = o.pluginVersion; profile = o.profile; knobs = o.knobs;
          // Degrade, never error, never silently drop: a record from an unrecognized
          // schemaVersion is still read and returned, just flagged — summarizeSession decides
          // whether to trust it (falls back to forward-fill when schemaMismatch is set).
          if (o.schemaVersion !== CURRENT_SCHEMA_VERSION) schemaMismatch = true;
        } else if (o.kind === "session") {
          current = o.sessionHash;
          if (!windows.has(current))
            windows.set(current, { stages: [], dispatches: [], verdicts: [], events: [], workloads: [], lensCosts: [], commits: [] });
        } else if (o.kind === "stage") { if (current) windows.get(current).stages.push(o); }
        else if (o.kind === "dispatch") { if (current) windows.get(current).dispatches.push(o); }
        else if (o.kind === "verdict") { if (current) windows.get(current).verdicts.push(o); }
        else if (o.kind === "event") { if (current) windows.get(current).events.push(o); }
        else if (o.kind === "workload") { if (current) windows.get(current).workloads.push(o); }
        else if (o.kind === "lens-cost") { if (current) windows.get(current).lensCosts.push(o); }
        else if (o.kind === "commit") { if (current) windows.get(current).commits.push(o); }
        else if (o.kind === "triage") { triage = { requestKind: o.requestKind, entryStage: o.entryStage }; }
      }
      for (const [h, w] of windows) {
        // The run's workload is the last workload line written for the session (a rerun overwrites
        // an earlier estimate); null when the run wrote none (GC3 — workload-unknown, not zero).
        const rec = { runId, pluginVersion, profile, knobs, schemaMismatch, triage, ...w,
          workload: w.workloads.at(-1) ?? null };
        const prior = bySession.get(h);
        bySession.set(h, prior
          ? { ...rec,
              stages: [...prior.stages, ...rec.stages],
              dispatches: [...prior.dispatches, ...rec.dispatches],
              verdicts: [...prior.verdicts, ...rec.verdicts],
              events: [...prior.events, ...rec.events],
              workloads: [...prior.workloads, ...rec.workloads],
              lensCosts: [...prior.lensCosts, ...rec.lensCosts],
              commits: [...prior.commits, ...rec.commits],
              triage: rec.triage ?? prior.triage ?? null,
              workload: rec.workload ?? prior.workload ?? null }
          : rec);
      }
    }
  return bySession;
}

// Cost lands on a stage because the record says so, not because a skill tag earlier in the
// transcript happened to still be the most recent one. Returns null when no record covers this
// session, so the caller falls back to attributeForwardFill for the 77 historical sessions.
export function attributeFromRecord(turns, record) {
  if (!record || !record.stages?.length) return null;
  const within = (t, a, b) => t >= Date.parse(a) && t < Date.parse(b);
  return turns.map((turn) => {
    const t = Date.parse(turn.timestamp);
    const stage = record.stages.find((s) => within(t, s.startedAt, s.endedAt));
    // dispatch.agentId is never populated by any writer — a per-agentId turn can never resolve
    // here and always falls through to the inferred label below. Kept as a window-only match,
    // not removed, because a NON-agentId turn (the common case) still resolves exactly via
    // timestamp windowing.
    const dispatch = record.dispatches.find((d) => within(t, d.startedAt, d.endedAt) && !turn.agentId);
    return {
      ...turn,
      stage: stage ? stage.stage : "unattributed",
      taskId: dispatch ? dispatch.taskId : null,
      attributionSource: dispatch || !turn.agentId ? "record" : "inferred",
    };
  });
}

// Task 36 dropped the writer-side dispatch.toolCalls field (self-reported, never trustworthy);
// this derives the same figure from the transcript instead, reusing attributeFromRecord's own
// within() windowing pattern rather than a second implementation of it.
export function toolCallsForDispatch(turns, dispatch) {
  const within = (t, a, b) => t >= Date.parse(a) && t < Date.parse(b);
  const counts = {};
  for (const turn of turns) {
    const t = Date.parse(turn.timestamp);
    if (!within(t, dispatch.startedAt, dispatch.endedAt)) continue;
    const content = turn.message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content)
      if (item?.type === "tool_use" && typeof item.name === "string")
        counts[item.name] = (counts[item.name] ?? 0) + 1;
  }
  return counts;
}

// executing-waves.md step 6 legitimately appends a SECOND verdict line for the same
// taskId+round when the green gate rejects a round the reviewer already accepted — the
// run record stays append-only (both lines genuinely happened), so every read side collapses
// same-round verdicts to one outcome before counting anything. File order is chronological,
// so a later entry naturally overwrites an earlier one in the map, keeping the authoritative
// (latest) verdict for that round.
function collapseVerdicts(verdicts) {
  return [...new Map(
    (verdicts ?? []).map((v) => [`${v.taskId}:${v.round}`, v]),
  ).values()];
}

// Every token metric is paired with a quality signal, so a change that halves cost while doubling
// review rounds is visible as such. Absent for a record-less run — zero rounds would read as
// flawless work rather than as no data.
export function qualitySignals(record) {
  if (!record) return null;
  const dispatches = record.dispatches ?? [];
  const verdicts = collapseVerdicts(record.verdicts);
  const tasks = new Set([...dispatches, ...verdicts].map((d) => d.taskId)).size;
  const reviewRounds = verdicts.length;
  return {
    tasks,
    reviewRounds,
    retries: dispatches.filter((d) => (d.retryIndex ?? 0) > 0).length,
    blockingFindings: verdicts.reduce((n, v) => n + (v.blockingCount ?? 0), 0),
    conformanceFailures: verdicts.filter((v) => v.conformance === "fail").length,
    roundsPerTask: tasks === 0 ? 0 : reviewRounds / tasks,
  };
}

function bump(map, key, amount) {
  map[key] = (map[key] ?? 0) + amount;
}

// Context growth between two consecutive requests is caused by whatever the previous request
// pulled in, so it is charged to that request's tool calls (split evenly across them).
function contentClasses(r) {
  const content = r?.message?.content;
  const names = [];
  if (Array.isArray(content))
    for (const item of content)
      if (item && item.type === "tool_use" && typeof item.name === "string") names.push(item.name);
  return names.length ? names : ["prompt"];
}

// No transcript carries an explicit session-end marker — verified against the whole corpus, where
// a finished session's tail is structurally identical to a live one's. Recency is therefore the
// only available signal, and it is an approximation, disclosed as one in the output.
export const IN_FLIGHT_MS = 30 * 60 * 1000;

export function isInFlight(newestRecordMs, nowMs = Date.now()) {
  return nowMs - newestRecordMs < IN_FLIGHT_MS;
}

// The culprit slugs each impact key's events carried, so a table can name the vocabulary entry
// without impactScores having to key on it — the key stays (event, stage) until the release
// references/impact-scoring.md § The grouping key names. A key whose events carry no slug is
// absent, never present with an empty list: absent is not "attributed to nothing".
function culpritsByKey(record) {
  const out = {};
  for (const e of journalEvents(record)) {
    if (!e.culprit) continue;
    const key = `${e.event}:${e.stage}`;
    (out[key] ??= new Set()).add(e.culprit);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort()]));
}

export function summarizeSession(sessionId, records, runRecords = new Map()) {
  const turns = records.filter(isTurn);
  const depths = turns.map((r) => contextDepth(r.message.usage));
  const tools = {};
  const models = {};
  const costByModel = {};
  const costByStage = {};
  const costByAgentType = {};
  const costByLens = {};
  const unpriced = {};
  const priced = [];
  const bandCounts = Object.fromEntries(BAND_LABELS.map((l) => [l, 0]));
  const startupFloor = {};
  const carryWeighted = {};
  const dispatches = { total: 0, withoutModel: 0 };
  let totalCost = 0;

  // Measured over every record, not just turns: the newest thing written to the transcript is
  // what says whether the session is still going. A record with no readable timestamp simply
  // does not vote, and a session with none at all is treated as finished rather than dropped.
  let newestRecordMs = null;
  for (const r of records) {
    const t = Date.parse(r?.timestamp ?? "");
    if (Number.isFinite(t) && (newestRecordMs === null || t > newestRecordMs)) newestRecordMs = t;
  }

  // The run record is the preferred source: it joins cost to a stage window (and a dispatch's
  // taskId) directly, rather than inferring it from the last skill tag seen in the transcript.
  // Falls back to forward-fill for the 77 sessions written before this cycle had a record to join,
  // and for a record whose schemaVersion this reader does not recognize — treated the same as
  // "no record" rather than trusted or rejected outright (see readRunRecords' schemaMismatch tag).
  const record = runRecords.get(sha256(sessionId));
  const attributionRecord = record?.schemaMismatch ? null : record;
  let pluginVersion = record?.pluginVersion ?? null;
  // Already recorded per run (run-record.schema.json's `run` kind) and already parsed by
  // readRunRecords; this is the first consumer. No transcript-side fallback exists for
  // profile — a session with no record simply has none.
  const profile = record?.profile ?? null;
  // No transcript-side fallback for knobs (unlike pluginVersion, above) — a session with no
  // knob data (pre branch-fix-2-3's --knob wiring, or a run that never resolved the knob)
  // reads as absent, never an error.
  const knobs = record?.knobs ?? null;
  const attributed = attributeFromRecord(turns, attributionRecord) ??
    attributeForwardFill(turns).map((skill, i) => ({ ...turns[i], stage: skill, attributionSource: "forward-filled" }));
  // Session-level rollup of the same source attributeFromRecord already decided per turn: this
  // session's whole attribution came from the run record only when one was found and it actually
  // covered the session with stages — the exact condition attributeFromRecord itself guards on
  // (`if (!record || !record.stages?.length) return null;`) — otherwise every turn fell back to
  // attributeForwardFill uniformly, so "forward-filled" is never a per-turn mix at this level.
  const attributionSource = attributionRecord && attributionRecord.stages?.length ? "record" : "forward-filled";
  // Coordinator-reported per-lens cost, taken straight off the run record's lens-cost lines — not
  // joined to a transcript turn, so it does not depend on attribution trust (schemaMismatch et al.).
  for (const lc of record?.lensCosts ?? []) bump(costByLens, lc.lens, lc.cost ?? 0);
  // One entry per tool call (not per turn — a turn can carry several), the shape
  // emitComplianceCandidates' C1 check needs.
  const toolCallEvents = [];
  turns.forEach((r, i) => {
    const model = r.message.model;
    if (model) models[model] = (models[model] ?? 0) + 1;
    const dollars = costUSD(r.message.usage, model);
    if (dollars === null) {
      bump(unpriced, model ?? "(none)", 1);
    } else {
      totalCost += dollars;
      bump(costByModel, model, dollars);
      bump(costByStage, attributed[i].stage ?? "unattributed", dollars);
      bump(costByAgentType, agentTypeOf(r), dollars);
      priced.push(r);
    }
    bandCounts[depthBand(contextDepth(r.message.usage))] += 1;
    if (!pluginVersion) {
      const extracted = extractPluginVersion(r);
      if (extracted) pluginVersion = extracted;
    }
    const content = r.message.content;
    if (!Array.isArray(content)) return;
    for (const item of content) {
      if (!item || item.type !== "tool_use" || typeof item.name !== "string") continue;
      tools[item.name] = (tools[item.name] ?? 0) + 1;
      toolCallEvents.push({ isSidechain: r.isSidechain, toolName: item.name });
      if (DISPATCH_TOOLS.has(item.name)) {
        dispatches.total += 1;
        if (!item.input?.model) dispatches.withoutModel += 1;
      }
    }
  });

  // Per-transcript sequencing: a subagent's context is its own, so its startup floor and its
  // carry cost are measured against its own transcript rather than the session as a whole.
  const byTranscript = new Map();
  for (const r of turns) {
    const key = transcriptOf(r);
    if (!byTranscript.has(key)) byTranscript.set(key, []);
    byTranscript.get(key).push(r);
  }
  for (const seq of byTranscript.values()) {
    (startupFloor[agentTypeOf(seq[0])] ??= []).push(contextDepth(seq[0].message.usage));
    for (let i = 0; i < seq.length; i++) {
      const added = Math.max(
        0,
        contextDepth(seq[i].message.usage) - (i === 0 ? 0 : contextDepth(seq[i - 1].message.usage)),
      );
      const later = seq.length - 1 - i;
      if (!added || !later) continue;
      const classes = i === 0 ? ["startup"] : contentClasses(seq[i - 1]);
      for (const c of classes) bump(carryWeighted, c, (added * later) / classes.length);
    }
  }

  return {
    id: sessionId.slice(0, 8),
    turns: turns.length,
    mainTurns: turns.filter((r) => !r.isSidechain).length,
    subagentTurns: turns.filter((r) => r.isSidechain).length,
    medianDepth: median(depths),
    maxDepth: depths.length ? Math.max(...depths) : 0,
    tools,
    costUSD: totalCost,
    costByModel,
    costByStage,
    costByAgentType,
    costByLens,
    bandCounts,
    startupFloor,
    carryWeighted,
    dispatches,
    unpriced,
    cacheBand: costBand(priced),
    models,
    profile: profile ?? "unknown",
    pluginVersion: pluginVersion ?? "unknown",
    knobs,
    // The full session id is still in hand here and the record is already resolved; a summary
    // carries only `id: sessionId.slice(0, 8)`, so nothing downstream could redo this join.
    runId: record?.runId ?? null,
    // Joined by readRunRecords from the run's workload line; null when the run wrote none (GC3).
    workload: record?.workload ?? null,
    // References/impact-scoring.md owns the formula; this is the only call site that scores a
    // session, and every table downstream reads the result rather than recomputing it.
    impact: record ? impactScores(record, costByStage) : null,
    culpritsByKey: culpritsByKey(record),
    attributionSource,
    complianceCandidates: emitComplianceCandidates(toolCallEvents, record),
    inFlight: newestRecordMs !== null && isInFlight(newestRecordMs),
    quality: qualitySignals(record),
  };
}

const DISCLOSURE =
  "note: skill attribution is forward-filled within each transcript from the last " +
  "explicit skill invocation through to that transcript's end (or the next invocation) — " +
  "genuinely unrelated work with no further skill call in the same transcript is still " +
  "counted under the earlier skill.";

const IN_FLIGHT_NOTE =
  "in-flight sessions have only part of their cost recorded, so they are excluded from the " +
  "medians and still counted in the corpus. In-flight detection is a recency approximation: " +
  "transcripts carry no end marker, so a finished session reads as live for 30 minutes.";

const DEPTH_DISCLOSURE =
  "Depth bands are a fraction of the model's context window, not an absolute token count: " +
  "the same depth reads as a different band on a different model.";

const usd = (n) => "$" + (n >= 1 ? n.toFixed(2) : n.toFixed(4));

// QC4/QC5: absent, not zero — a record-less run's "0 review rounds" would read as flawless work
// rather than as no data, so the missing case renders its own label instead of a zero figure.
function qualityText(q) {
  if (q === null || q === undefined) return "unavailable (no run record)";
  return (
    `${q.roundsPerTask.toFixed(1)} rounds/task (${q.tasks} tasks, ${q.retries} retries, ` +
    `${q.blockingFindings} blocking, ${q.conformanceFailures} conformance fail)`
  );
}

// Largest first, so each section leads with what actually costs money.
function ranked(map, render) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${render(v)}`)
    .join(", ");
}

// One raw signal line per emitCandidates() entry — no severity, no ranking; that judgment
// call stays at the playbook layer (playbooks/profiling-sessions.md), consistent with doctor's
// existing division of labor (this script computes, the playbook interprets).
export function formatCandidate(c) {
  const parts = [c.type];
  if (c.skill) parts.push(`skill=${c.skill}`);
  if (c.model) parts.push(`model=${c.model}`);
  if (c.version_from) parts.push(`${c.version_from}->${c.version_to}`);
  if (c.delta_dollars !== undefined)
    parts.push(`delta=${c.delta_dollars >= 0 ? "+" : "-"}$${Math.abs(c.delta_dollars).toFixed(2)} (${c.delta_pct.toFixed(1)}%)`);
  else if (c.delta_pct != null) parts.push(`delta=${c.delta_pct.toFixed(1)}%`);
  if (c.dollars != null) parts.push(`dollars=${usd(c.dollars)}`);
  if (c.count != null) parts.push(`count=${c.count}`);
  parts.push(`sessions=${c.sessions_sampled}`);
  // A candidate that already prints a `from->to` line (a version-regression/improvement) carries
  // the same span twice if versions=[..] is also emitted, so the canonical from->to line wins and
  // the redundant range is suppressed; types with no from->to line still render versions=[..].
  if (c.versions && !c.version_from) parts.push(`versions=[${c.versions[0]}..${c.versions[1]}]`);
  if (isLowConfidence(c)) parts.push("low confidence: n=1");
  return `CANDIDATE: ${parts.join(" ")}`;
}

// Every session's own emitComplianceCandidates() output, gathered corpus-wide — same one-entry-
// per-source-session convention emitCandidates already uses for unpriced-model, above. QC5: a
// null onDevicePath (always null until Task 11 lands in cycle 3) is labelled "unrecorded" here
// so both render sites below show a labelled value, never a bare null.
function complianceCandidatesOf(summaries) {
  return summaries.flatMap((s) => (s.complianceCandidates ?? []).map((c) => {
    const withPath =
      c.type === "main-thread-browser" ? { ...c, onDevicePath: c.onDevicePath ?? "unrecorded" } : c;
    // Version scope from the source session (spec C5): a single-session candidate spans [v, v].
    // A version-less session (unknown) carries no range rather than a fabricated "unknown..unknown".
    const v = s.pluginVersion;
    return v && v !== "unknown" ? { ...withPath, versions: [v, v] } : withPath;
  }));
}

// Distinct from formatCandidate: these three carry their own occurrence field
// (calls/inherited/count) and no dollars, so reusing formatCandidate's field set would print
// unrelated columns. Each carries a per-session sessions_sampled=1 like the unpriced-model
// convention (#128), rendered here as `sessions=N` so a reader can weigh how many sessions the
// flag rests on. The version range, when the source session carried one, renders as
// `versions=[min..max]` (spec C5).
function formatComplianceCandidate(c) {
  const span = c.versions ? ` versions=[${c.versions[0]}..${c.versions[1]}]` : "";
  if (c.type === "main-thread-browser")
    return `CANDIDATE: main-thread-browser calls=${c.calls} sessions=${c.sessions_sampled} onDevicePath=${c.onDevicePath}${span} — ${c.note}`;
  if (c.type === "inherited-model")
    return `CANDIDATE: inherited-model inherited=${c.inherited}/${c.total} sessions=${c.sessions_sampled}${span}`;
  if (c.type === "missing-workload")
    return `CANDIDATE: missing-workload commits=${c.commits} requestKind=${c.requestKind} sessions=${c.sessions_sampled}${span} — reached execution and committed but recorded no workload (collection gap — the commit-sensor hook should have written it)`;
  return `CANDIDATE: general-purpose-search count=${c.count}/${c.total} sessions=${c.sessions_sampled}${span}`;
}

// Combines every session's cacheBand into one corpus-wide figure. Dollar edges (point/low/high)
// are additive across sessions. "collapsed" is the logical AND of every session's own collapsed
// flag — exactly equivalent to "the corpus's total fallback-priced tokens are zero", since that
// total is a sum of non-negative per-session fallback-token counts and such a sum is zero only
// when every term is. fallbackShare has no exact aggregate (per-session token counts are not
// carried on the summary, only the ratio), so it is weighted by each band's own dollar spread —
// collapsed sessions (spread 0) drop out of the weighting entirely, matching a fully-collapsed
// corpus reporting share 0.
function aggregateCacheBand(summaries) {
  const bands = summaries.map((s) => s.cacheBand).filter(Boolean);
  if (!bands.length) return { point: 0, low: 0, high: 0, fallbackShare: 0, collapsed: true };
  const point = bands.reduce((sum, b) => sum + b.point, 0);
  const low = bands.reduce((sum, b) => sum + b.low, 0);
  const high = bands.reduce((sum, b) => sum + b.high, 0);
  const collapsed = bands.every((b) => b.collapsed);
  const spread = bands.reduce((sum, b) => sum + (b.high - b.low), 0);
  const fallbackShare =
    spread === 0 ? 0 : bands.reduce((sum, b) => sum + b.fallbackShare * (b.high - b.low), 0) / spread;
  return { point, low, high, fallbackShare, collapsed };
}

function aggregate(summaries) {
  const agg = {
    costUSD: 0,
    costByModel: {},
    costByStage: {},
    costByAgentType: {},
    costByLens: {},
    bandCounts: Object.fromEntries(BAND_LABELS.map((l) => [l, 0])),
    startupFloor: {},
    carryWeighted: {},
    dispatches: { total: 0, withoutModel: 0 },
    unpriced: {},
  };
  for (const s of summaries) {
    agg.costUSD += s.costUSD;
    for (const key of ["costByModel", "costByStage", "costByAgentType", "costByLens", "carryWeighted", "unpriced"])
      for (const [k, v] of Object.entries(s[key] ?? {})) bump(agg[key], k, v);
    for (const [k, v] of Object.entries(s.bandCounts ?? {})) bump(agg.bandCounts, k, v);
    for (const [k, v] of Object.entries(s.startupFloor ?? {})) (agg.startupFloor[k] ??= []).push(...v);
    agg.dispatches.total += s.dispatches?.total ?? 0;
    agg.dispatches.withoutModel += s.dispatches?.withoutModel ?? 0;
  }
  agg.cacheBand = aggregateCacheBand(summaries);
  return agg;
}

// The cache-TTL disclosure, in both its forms. Assembled once because formatReport and caveatLines
// rendered identical text differing only by a leading bullet, and a reader must be able to tell a
// band that was checked and found exact from one that was never checked.
function cacheBandLine(band) {
  return band.collapsed
    ? "Cost is exact: every cache write in this corpus carries its TTL split."
    : `Cost $${band.point.toFixed(2)} (inferred: cache-write TTL, range ` +
        `$${band.low.toFixed(2)}–$${band.high.toFixed(2)}; ` +
        `${(band.fallbackShare * 100).toFixed(1)}% of cache-write tokens lack a TTL split).`;
}

export function formatReport(summaries) {
  const vintage = `prices as of ${PRICING.asOf}`;
  if (!summaries.length) return `no sessions matched.\n\n${vintage}\n`;
  const agg = aggregate(summaries);
  const lines = [
    `total cost ${usd(agg.costUSD)} over ${summaries.length} session(s)`,
    `by model: ${ranked(agg.costByModel, usd) || "none"}`,
    `by stage: ${ranked(agg.costByStage, usd) || "none"}`,
    `by agent type: ${ranked(agg.costByAgentType, usd) || "none"}`,
    `context depth: ${BAND_LABELS.map((l) => `${l} ${agg.bandCounts[l]}`).join(", ")}`,
    `startup floor: ${
      Object.entries(agg.startupFloor)
        .sort((a, b) => median(b[1]) - median(a[1]))
        .map(([k, v]) => `${k} median ${median(v)} min ${Math.min(...v)} (n=${v.length})`)
        .join(", ") || "none"
    }`,
    `carry-weighted tokens by content class: ${ranked(agg.carryWeighted, (v) => Math.round(v)) || "none"}`,
    `dispatches: ${agg.dispatches.total}, without an explicit model ${agg.dispatches.withoutModel}`,
  ];
  for (const [model, count] of Object.entries(agg.unpriced).sort((a, b) => b[1] - a[1]))
    lines.push(`UNPRICED MODEL: ${model} (${count} requests)`);
  // QC5: any value that remains inferred is labelled inferred at every render site (text and
  // --json alike), never left to read as exact. Classes rendered here: cache-write TTL pricing
  // (costBand, above) and forward-filled stage attribution (no run record for the session). A
  // third exists at the per-turn level but is not surfaced in this session-level rollup: a
  // concurrent-wave turn whose agentId matches no dispatch renders `attributionSource: "inferred"`
  // in attributeFromRecord's own output — permanent, not conditional on any later dispatch
  // eventually being recorded.
  lines.push(cacheBandLine(agg.cacheBand));
  for (const s of summaries)
    if (s.attributionSource === "forward-filled")
      lines.push(`  ${s.id}: stage costs are inferred (forward-filled — no run record).`);
  const inFlightCount = summaries.filter((s) => s.inFlight).length;
  if (inFlightCount > 0)
    lines.push(
      `note: ${inFlightCount} session(s) still in flight (newest record < 30 min old) — ` +
        IN_FLIGHT_NOTE,
    );
  lines.push("", "Per-version cohorts:");
  const direction = corpusDirectionOfTravel(runAggregates(summaries.filter((s) => !s.inFlight)));
  lines.push(
    direction.direction === "insufficient-data"
      ? `direction of travel: insufficient data (${direction.reason})`
      : `direction of travel: ${direction.direction} (${direction.deltaPct.toFixed(1)}% median ` +
        `cost, ${direction.matchKey}, ${direction.from}→${direction.to})`
  );
  for (const r of cohortTable(summaries))
    lines.push(
      `  ${r.version.padEnd(10)} n=${String(r.sessions).padStart(3)}  ` +
      `total=$${r.total.toFixed(2).padStart(9)}  median/session=$${r.medianPerSession.toFixed(2).padStart(7)}  ` +
      `median depth=${r.medianDepth === null ? "n/a" : r.medianDepth}  ` +
      `quality: ${qualityText(r.quality)}` +
      (r.version === "unknown" ? "   (inferred: no version detectable)" : "")
    );
  lines.push("", "Per-reviewDepth cohorts:");
  for (const r of reviewDepthCohortTable(summaries))
    lines.push(
      `  ${r.reviewDepth.padEnd(10)} n=${String(r.sessions).padStart(3)}  ` +
      `total=$${r.total.toFixed(2).padStart(9)}  median/session=$${r.medianPerSession.toFixed(2).padStart(7)}  ` +
      `quality: ${qualityText(r.quality)}` +
      (r.reviewDepth === "unknown" ? "   (inferred: no reviewDepth knob recorded)" : "")
    );
  lines.push("");
  for (const c of emitCandidates(summaries)) lines.push(formatCandidate(c));
  for (const c of complianceCandidatesOf(summaries)) lines.push(formatComplianceCandidate(c));
  lines.push("", vintage, DISCLOSURE, DEPTH_DISCLOSURE, "");
  for (const s of summaries) {
    // `?? {}` / `?? 0`: a summary built for a report-level assertion (as in the cost-band and
    // forward-filled tests above) may carry only the fields its own test cares about — this loop
    // must render *something* for it rather than throwing on a session-detail field it omitted.
    const modelList = Object.keys(s.models ?? {}).join(", ") || "none";
    const toolList = Object.entries(s.tools ?? {}).map(([k, v]) => `${k}:${v}`).join(", ") || "none";
    lines.push(
      `session ${s.id} — turns ${s.turns} (main ${s.mainTurns}, subagent ${s.subagentTurns}), ` +
        `depth median ${s.medianDepth} max ${s.maxDepth}, cost ${usd(s.costUSD ?? 0)}, ` +
        `models [${modelList}], tools [${toolList}], quality: ${qualityText(s.quality)}` +
        (s.inFlight ? " [in flight — excluded from medians]" : ""),
    );
  }
  return lines.join("\n");
}

// Recursively collects .jsonl transcript files under dir. Returns null when dir is simply
// not there (missing, or a path that is not a directory).
export function findTranscriptFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // Same rule as readRecords below: an absent path is "nothing here", but a permissions
    // or I/O failure is a real fault and must not read as a directory holding no transcripts.
    if (err.code !== "ENOENT" && err.code !== "ENOTDIR") throw err;
    return null;
  }
  const files = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files.push(...(findTranscriptFiles(p) ?? []));
    else if (e.isFile() && e.name.endsWith(".jsonl")) files.push(p);
  }
  return files;
}

// <slug>/<session>/subagents/agent-<id>.jsonl -> <session>; <slug>/<session>.jsonl -> <session>.
export function owningSession(file) {
  const parts = file.split(sep);
  const i = parts.lastIndexOf("subagents");
  return i > 0 ? parts[i - 1] : basename(file, ".jsonl");
}

// Malformed JSON lines are skipped, not fatal — transcripts are appended live
// and the last line may be partial.
export function readRecords(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    // A transcript deleted between listing and reading is normal; anything else
    // (permissions, I/O) is a real fault and must not read as an empty session.
    if (err.code !== "ENOENT") throw err;
    return [];
  }
  const records = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // skip partial/malformed line
    }
  }
  return records;
}

export function inWindow(timestamp, since, until) {
  if (!since && !until) return true;
  if (!timestamp) return false;
  const t = new Date(timestamp).getTime();
  if (since && t < new Date(since).getTime()) return false;
  if (until && t > new Date(until).getTime()) return false;
  return true;
}

function mergeCounts(target, source) {
  for (const [k, v] of Object.entries(source)) target[k] = (target[k] ?? 0) + v;
}

// The --json counterpart of formatReport: same corpus, same QC5 labelling (every session
// carries `inferred`, the report carries `cost_band`) — never left implicit the way a
// human reader could infer from prose but a machine consumer of the JSON could not.
// `ctx` is reportContext's output, the same object renderReport is handed, so the two forms of
// the report cannot describe different corpora. It is optional and every key it feeds defaults
// to its own empty form: a caller with only summaries in hand still gets every table that is
// derivable from summaries alone.
export function buildJsonReport(summaries, ctx = {}) {
  return {
    pricesAsOf: PRICING.asOf,
    sessions: summaries.map((s) => ({
      ...s,
      inferred: s.attributionSource === "forward-filled" ? "forward-filled" : null,
      quality: s.quality ?? null,
    })),
    candidates: [...emitCandidates(summaries), ...complianceCandidatesOf(summaries)],
    version_cohorts: cohortTable(summaries),
    review_depth_cohorts: reviewDepthCohortTable(summaries),
    direction_of_travel: corpusDirectionOfTravel(runAggregates(summaries.filter((s) => !s.inFlight))),
    inFlight: {
      excluded: summaries.filter((s) => s.inFlight).length,
      thresholdMs: IN_FLIGHT_MS,
      note: IN_FLIGHT_NOTE,
    },
    cost_band: aggregateCacheBand(summaries),
    // Additive: every key above keeps its name and meaning. These eight are the markdown
    // report's own sections, so a machine consumer reads exactly the rows the report renders
    // rather than re-deriving them from `sessions`.
    version_profile_cohorts: versionProfileTable(summaries, ctx.promotions ?? []),
    stage_by_version: stageByVersionTable(summaries),
    stage_window: stageWindowTable(summaries, ctx.previousSummaries ?? null),
    culprits: culpritTable(summaries, ctx.vocab ?? []),
    wins: winTable(summaries, ctx.vocab ?? [], emitCandidates(summaries)),
    // Absent, not zero: a probe that did not run renders null here for the same reason the
    // markdown renders "unavailable" — a 0 would read as "nothing filed".
    outer_loop: ctx.outerLoop ?? null,
    compiled_knowledge: ctx.compiledKnowledge ?? null,
    cycles: cycleGroups(summaries),
  };
}

// One window's worth of summaries. The current window and the preceding one differ only in
// their bounds: same membership rule, same skip of a session with nothing inside the window,
// same session-id resolution. They share this helper because the report subtracts one window
// from the other and calls the difference a trend — two copies that drifted apart would be
// measuring two different corpora and reporting the gap between them as a change in cost.
function summarizeWindow(groups, since, until, args, runRecords) {
  const out = [];
  for (const [key, records] of groups) {
    // Membership is a session-level property, so it is decided over every record;
    // the window then narrows only what gets measured.
    if (!args.all && !isDevcycleSession(records)) continue;
    const windowed = records.filter((r) => inWindow(r.timestamp, since, until));
    if (windowed.length === 0) continue;
    const sessionId = records.find((r) => r.sessionId)?.sessionId ?? key;
    out.push(summarizeSession(sessionId, windowed, runRecords));
  }
  return out;
}

function run(args) {
  const files = findTranscriptFiles(args.dir);
  if (files === null) return { ok: false, reasons: [`directory not found: ${args.dir}`] };
  if (files.length === 0) return { ok: false, reasons: [`no readable session files under ${args.dir}`] };

  // A session's own transcript and its subagents' transcripts are one session's records.
  const groups = new Map();
  for (const file of files) {
    const key = owningSession(file);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(...readRecords(file));
  }

  const runRecords = readRunRecords();
  const sessions = summarizeWindow(groups, args.since, args.until, args, runRecords);

  // The preceding window has to be summarized separately: `inWindow` filters records before
  // summarizeSession ever sees them, so the preceding window's cost is not recoverable from
  // `sessions` at any granularity. Only built when a window was actually requested — `null`
  // rather than `[]`, because "no window to compare against" is not "the previous window was
  // empty", and the tables render those two differently.
  let previousSessions = null;
  if (args.since) {
    const untilMs = args.until ? new Date(args.until).getTime() : Date.now();
    const sinceMs = new Date(args.since).getTime();
    const span = untilMs - sinceMs;
    const prevSince = new Date(sinceMs - span).toISOString();
    previousSessions = summarizeWindow(groups, prevSince, args.since, args, runRecords);
  }

  const totals = { turns: 0, mainTurns: 0, subagentTurns: 0, costUSD: 0, tools: {}, models: {} };
  for (const s of sessions) {
    totals.turns += s.turns;
    totals.mainTurns += s.mainTurns;
    totals.subagentTurns += s.subagentTurns;
    totals.costUSD += s.costUSD;
    mergeCounts(totals.tools, s.tools);
    mergeCounts(totals.models, s.models);
  }
  totals.costUSD = Math.round(totals.costUSD * 1e4) / 1e4;

  return { ok: true, window: { since: args.since, until: args.until }, sessions, previousSessions, totals };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`doctor: ${err.message}`);
    process.exit(1);
  }
  if (args.drift) {
    let result;
    try {
      result = configDrift(args.drift, CHANGELOG_PATH);
    } catch (e) {
      console.error(`doctor: ${e.message}`);
      process.exit(1);
    }
    const { findings, recordsParsed, staleKeys } = result;
    if (args.json) {
      console.log(JSON.stringify({ findings, recordsParsed, staleKeys }, null, 2));
    } else if (staleKeys === 0) {
      // Not the same result as a clean target: there was nothing to match against.
      console.log(
        `config-drift: nothing to check — the changelog carries no deprecated/renamed/removed keys ` +
          `(${recordsParsed} record(s) parsed), so no reference in ${args.drift} can be flagged stale`
      );
    } else if (findings.length === 0) {
      console.log(
        `config-drift: ok — no stale references in ${args.drift} ` +
          `(${staleKeys} stale key(s) checked, from ${recordsParsed} changelog record(s))`
      );
    } else {
      console.log(
        findings
          .map((f) => `${f.file}:${f.line} — stale \`${f.key}\` (superseded in ${f.changelogVersion}: ${f.supersededBy ?? "see changelog"})`)
          .join("\n")
      );
    }
    process.exit(0);
  }
  if (args.depth) {
    let r;
    try {
      r = resolveDepth(process.env, process.cwd());
    } catch (e) {
      console.error(`doctor: ${e.message}`);
      process.exit(1);
    }
    if (args.json) {
      console.log(JSON.stringify(r));
    } else {
      const pct = (r.fraction * 100).toFixed(1);
      console.log(`depth: ${r.depth} tokens (${pct}% of ${r.window}, model ${r.model}) — band: ${r.band}`);
    }
    return;
  }
  let result;
  try {
    result = run(args);
  } catch (e) {
    // An unreadable transcript directory reaches here rather than being counted as empty.
    console.error(`doctor: ${e.message}`);
    process.exit(1);
  }
  if (!result.ok) {
    console.error("SESSION METRICS FAILED:\n" + result.reasons.map((r) => ` - ${r}`).join("\n"));
    process.exit(1);
  }
  // The draft path, before the report path: it prints one culprit's issue and returns. It never
  // posts, and it builds its own two tables rather than taking reportContext's, so drafting an
  // issue never runs the `gh` probe the report's Outer loop section needs.
  if (args.issueBody) {
    const tables = {
      versionProfile: versionProfileTable(result.sessions, safePromotions()),
      culprits: culpritTable(result.sessions, readVocab()),
    };
    if (!tables.culprits.some((r) => r.culprit === args.issueBody)) {
      console.error(`doctor: no culprit "${args.issueBody}" in this corpus`);
      process.exit(1);
    }
    let draft;
    try {
      draft = issueBody(args.issueBody, result.sessions, tables, repoShape(process.cwd()));
    } catch (e) {
      // A culprit last seen outside the recency band drafts stale noise; refuse it, print why,
      // and exit non-zero without emitting a body.
      if (e instanceof StaleCulpritError) {
        console.error(`doctor: ${e.message}`);
        process.exitCode = 1;
        return;
      }
      throw e;
    }
    for (const line of issueDraftLines(draft)) console.log(line);
    return;
  }
  const ctx = reportContext(args, result);
  // The cost-driven revert sidecar is a by-product of every report run, written for the playbook
  // to read; its own write is fail-safe, so it never blocks rendering.
  revertCandidates(result.sessions, ctx.promotions);
  if (args.json) {
    console.log(
      JSON.stringify(
        { window: result.window, totals: result.totals, ...buildJsonReport(result.sessions, ctx) },
        null,
        2,
      ),
    );
  } else {
    console.log(renderReport(result.sessions, ctx));
  }
}

// references/impact-scoring.md owns this formula; this is its only implementation. Four of the
// eight signals the design names are not written to the journal at all — they are already
// reconstructible from verdict and dispatch lines, so writing them too would be a second source
// of the same truth.
export function deriveEvents(record) {
  const out = [];
  const stageOf = (ts) =>
    (record.stages ?? []).find((s) => ts >= Date.parse(s.startedAt) && ts < Date.parse(s.endedAt))?.stage
    ?? "unattributed";
  for (const v of collapseVerdicts(record.verdicts)) {
    if (v.blockingCount > 0 || v.conformance === "fail")
      out.push({ event: "review-reject", stage: "execution", task: v.taskId, ts: null });
    else if (v.round === 1 && v.blockingCount === 0 && v.conformance === "pass")
      out.push({ event: "first-round-accept", stage: "execution", task: v.taskId, ts: null });
  }
  const byTask = new Map();
  for (const d of record.dispatches ?? []) {
    if (d.retryIndex > 0)
      out.push({ event: "re-dispatch", stage: stageOf(Date.parse(d.startedAt)), task: d.taskId, ts: d.startedAt });
    if (!byTask.has(d.taskId)) byTask.set(d.taskId, []);
    byTask.get(d.taskId).push(d);
  }
  for (const [taskId, ds] of byTask) {
    const models = new Set(ds.map((d) => d.model));
    if (ds.length > 1 && models.size > 1)
      out.push({ event: "escalation", stage: stageOf(Date.parse(ds[0].startedAt)), task: taskId, ts: ds[0].startedAt });
  }
  return out;
}

// Mean per-dispatch cost of the stage the event occurred in. Returns null — never 0 — when the
// stage has no dispatches in the window or no cost recorded: unmeasurable is not free.
export function attributedCost(stage, record, costByStage) {
  const occurrences = (record.stages ?? []).filter((s) => s.stage === stage);
  if (!occurrences.length) return null;
  const within = (t, a, b) => t >= Date.parse(a) && t < Date.parse(b);
  const n = (record.dispatches ?? []).filter((d) =>
    occurrences.some((s) => within(Date.parse(d.startedAt), s.startedAt, s.endedAt))
  ).length;
  const cost = costByStage?.[stage];
  if (n === 0 || cost === undefined) return null;
  return cost / n;
}

// Every event one run produced, journaled and derived alike, in one place. impactScores and
// summarizeSession both need this set, and two copies of the concatenation would be two places
// for the derived-signal list to drift out of step with references/impact-scoring.md.
export function journalEvents(record) {
  if (!record) return [];
  return [...(record.events ?? []), ...deriveEvents(record)];
}

export function impactScores(record, costByStage) {
  const all = journalEvents(record);
  const byKey = new Map();
  for (const e of all) {
    const key = `${e.event}:${e.stage}`;
    if (!byKey.has(key))
      byKey.set(key, { key, event: e.event, stage: e.stage, frequency: 0, impact: 0, measurable: true });
    const agg = byKey.get(key);
    agg.frequency += 1;
    const c = attributedCost(e.stage, record, costByStage);
    if (c === null) agg.measurable = false;
    else agg.impact += c;
  }
  return [...byKey.values()].map(({ measurable, ...rest }) => ({
    ...rest,
    impact: measurable ? rest.impact : null,
  }));
}

// Sessions are grouped into cycles by the run they belong to: one run record spans every
// session of one cycle, including sessions resumed after a /clear, so a per-session median
// would count one long cycle as several cheap ones. A session that joined no run record is its
// own cycle rather than being pooled with every other record-less session, which would fuse
// unrelated work into one giant cycle and understate the median.
export function cycleGroups(summaries) {
  const groups = new Map();
  for (const s of summaries) {
    const key = s.runId ?? `session:${s.id}`;
    if (!groups.has(key)) groups.set(key, { runId: s.runId ?? null, sessions: [], cost: 0 });
    const g = groups.get(key);
    g.sessions.push(s.id);
    g.cost += s.costUSD ?? 0;
  }
  return [...groups.values()];
}

// ─── The report's cost, culprit and win tables ───────────────────────────────────────────────
// Pure functions over summaries — no file read, no clock — so a table is testable from a
// hand-built summary and two callers (the markdown report and --json) render the same rows.

// Which impact keys are wins rather than culprits. An event carrying a `culprit` slug is
// classified by that vocabulary entry's `kind`; the derived signals and the gate events carry
// no slug, so the two that are wins are named here rather than re-decided at each render site.
export const WIN_EVENTS = new Set(["gate-pass-clean", "first-round-accept"]);

// A cohort of fewer than three sessions is a sample, not a measurement — spec §6 "Low
// confidence". Named once because it gates both the row's own flag and every comparison.
const MIN_COHORT = 3;

// Within ±5% is flat, not a movement — spec §6 "Trend (cost by stage, across versions)".
const FLAT_BAND_PCT = 5;

// How many versions the cost-by-stage table renders: enough to see a direction of travel,
// few enough that the row still fits on a screen.
const TREND_VERSIONS = 6;

const byName = (a, b) => String(a).localeCompare(String(b));

// cohortTable's ordering idiom, named once so every table below orders buckets identically:
// the known ones in order, the "unknown" bucket last so it never sits between two real ones.
function orderedBuckets(keys, compare = compareVersions) {
  const all = [...new Set(keys)];
  const known = all.filter((k) => k !== "unknown").sort(compare);
  return all.includes("unknown") ? [...known, "unknown"] : known;
}

// Version×profile rows in report order: the same idiom applied to both axes of the grid.
function orderVersionProfileRows(rows) {
  return orderedBuckets(rows.map((r) => r.version)).flatMap((version) => {
    const inVersion = rows.filter((r) => r.version === version);
    return orderedBuckets(inVersion.map((r) => r.profile), byName)
      .map((profile) => inVersion.find((r) => r.profile === profile));
  });
}

// One cost against an earlier one, in the ±5% band spec §6 pins. A zero baseline cannot be
// divided by, so it reports the direction it moved rather than an infinite percentage.
function costTrend(now, before) {
  if (before === 0) return now > 0 ? "up" : "flat";
  const pct = ((now - before) / before) * 100;
  return Math.abs(pct) <= FLAT_BAND_PCT ? "flat" : pct < 0 ? "down" : "up";
}

// The trend across a series, read off its oldest and newest *present* values: a version that
// carries no cost for a stage says nothing about that stage, and counting the gap as a zero
// would read as a stage that briefly became free.
function trendAcross(values) {
  const present = values.filter((v) => typeof v === "number");
  return present.length < 2 ? "insufficient data" : costTrend(present[present.length - 1], present[0]);
}

// Spec §6 "Δ vs. previous (same profile)" and "Low confidence", implemented once so the version
// table and the culprit table cannot drift into two different comparison rules. `rows` is in
// report order; the nearest older same-profile row is the one to compare against, and a cohort
// too small to measure is used on neither side.
function deltaAgainstPrevious(rows, index, valueOf) {
  const row = rows[index];
  // The "unknown" bucket has no place in version order, so it is neither older nor newer than
  // anything: not compared, rather than compared against whichever row happens to precede it.
  if (row.version === "unknown") return { state: "not-compared", pct: null };
  const previous = rows.slice(0, index).reverse()
    .find((r) => r.version !== "unknown" && r.profile === row.profile);
  if (!previous) return { state: "first-seen", pct: null };
  if (row.lowConfidence || previous.lowConfidence) return { state: "not-compared", pct: null };
  const before = valueOf(previous), now = valueOf(row);
  // A division that cannot be taken is not a 0% change, and an unmeasurable side is not a zero.
  if (before === 0 || before === null || now === null) return { state: "not-compared", pct: null };
  return { state: "compared", pct: ((now - before) / before) * 100 };
}

// Priciest first, with the rows nobody could price last: an unmeasurable impact is not a cheap
// one, so it never sorts among the small numbers as if it had been measured at zero.
const byImpactDesc = (a, b) =>
  a.impact === null ? (b.impact === null ? 0 : 1) : b.impact === null ? -1 : b.impact - a.impact;

// What a cycle cost under each version and profile, and whether that is better or worse than the
// last version run the same way.
// The benchmarking unit is the run, not the session (issue #114): a run's matchKey pins the three
// things that make two runs comparable — the profile it ran under, the kind of request, and the
// workload size band. Only runs carrying both a requestKind and a band are matchable (GC5/GC6): a
// run with no workload record is observational and never enters a cohort. Cohorts of one are kept
// (so excessCost can report them as "no expectation") rather than dropped.
const matchKeyOf = (r) => `${r.profile}|${r.requestKind}|${r.workloadBand}`;

export function matchedCohorts(runs) {
  const map = new Map();
  for (const r of runs ?? []) {
    if (r.requestKind == null || r.workloadBand == null) continue;
    const key = matchKeyOf(r);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return map;
}

// A run's cost measured against what its matched cohort actually cost, so a version is judged on
// its per-unit efficiency rather than on how long or how many its sessions happened to be. The
// expected figure is the cohort's median cost; the excess is the residual above it. A cohort of
// one has no peer to set an expectation, so it is reported as "no expectation" (expected/excess
// null, QC1) rather than as an outlier. Confidence rises with the cohort's size.
export function excessCost(runs) {
  const cohorts = matchedCohorts(runs);
  const out = [];
  for (const r of runs ?? []) {
    if (r.requestKind == null || r.workloadBand == null) continue; // observational only (GC5/GC6)
    const matchKey = matchKeyOf(r);
    const cohortN = cohorts.get(matchKey)?.length ?? 0;
    const expected = cohortN >= 2 ? median(cohorts.get(matchKey).map((c) => c.costUSD)) : null;
    const excess = expected == null ? null : r.costUSD - expected;
    out.push({
      runId: r.runId, version: r.version, profile: r.profile, matchKey,
      actual: r.costUSD, expected, excess, cohortN,
      confidence: cohortN >= 5 ? "high" : cohortN >= 2 ? "low" : "insufficient",
    });
  }
  return out;
}

// A percentage move that reports its direction instead of dividing by a zero or absent baseline.
const pctDelta = (from, to) =>
  from == null || to == null || from === 0 ? null : ((to - from) / from) * 100;

// Adjacent version steps inside the recency band, workload-adjusted: for each adjacent version
// pair in `band` and each matchKey both versions carry with >=2 runs, how the like-for-like cost
// (and its main/sub turn counts, depth, and conformance) moved. A delta is emitted only where both
// sides have >=2 runs — never fabricated across a single run (QC1). The turn and depth deltas are
// per-run medians (run-level cost is not split by agent type, so a $/turn split is not derivable
// here); the cost delta is the like-for-like median cost move.
export function workloadAdjustedSteps(runs, band) {
  const matchable = (runs ?? []).filter(
    (r) => inBand(r.version, band) && r.requestKind != null && r.workloadBand != null);
  const byVersionKey = (version) => {
    const m = new Map();
    for (const r of matchable.filter((r) => r.version === version)) {
      const k = matchKeyOf(r);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };
  const rows = [];
  for (let i = 0; i + 1 < band.length; i++) {
    const from = band[i], to = band[i + 1];
    const fromKeys = byVersionKey(from), toKeys = byVersionKey(to);
    for (const [matchKey, fRuns] of fromKeys) {
      const tRuns = toKeys.get(matchKey);
      if (!tRuns || fRuns.length < 2 || tRuns.length < 2) continue; // never fabricate a delta
      const medOf = (list, key) => median(list.map((r) => r[key] ?? 0));
      const conformanceRate = (list) => {
        const signalled = list.filter((r) => r.conformancePass != null);
        return signalled.length ? signalled.filter((r) => r.conformancePass).length / signalled.length : null;
      };
      const fromConf = conformanceRate(fRuns), toConf = conformanceRate(tRuns);
      const n = Math.min(fRuns.length, tRuns.length);
      rows.push({
        from, to, matchKey,
        costDeltaPct: pctDelta(medOf(fRuns, "costUSD"), medOf(tRuns, "costUSD")),
        mainTurnDeltaPct: pctDelta(medOf(fRuns, "mainTurns"), medOf(tRuns, "mainTurns")),
        subTurnDeltaPct: pctDelta(medOf(fRuns, "subagentTurns"), medOf(tRuns, "subagentTurns")),
        depthDeltaPct: pctDelta(medOf(fRuns, "medianDepth"), medOf(tRuns, "medianDepth")),
        conformanceDelta: fromConf == null || toConf == null ? null : toConf - fromConf,
        n,
        confidence: n >= 5 ? "high" : "low",
      });
    }
  }
  return rows;
}

export function versionProfileTable(summaries, promotions = []) {
  const groups = new Map();
  for (const s of summaries.filter((x) => !x.inFlight)) {
    const version = s.pluginVersion ?? "unknown";
    const profile = s.profile ?? "unknown";
    const key = `${version} ${profile}`;
    if (!groups.has(key)) groups.set(key, { version, profile, members: [] });
    groups.get(key).members.push(s);
  }
  const rows = orderVersionProfileRows([...groups.values()]).map((g) => {
    const cycles = cycleGroups(g.members);
    const stageTotals = new Map();
    for (const s of g.members)
      for (const [stage, dollars] of Object.entries(s.costByStage ?? {}))
        stageTotals.set(stage, (stageTotals.get(stage) ?? 0) + dollars);
    const priciest = [...stageTotals.entries()].sort((a, b) => b[1] - a[1] || byName(a[0], b[0]))[0];
    const depths = g.members.map((s) => s.medianDepth).filter((d) => typeof d === "number");
    // Decomposed $/turn (issue #114): a blended $/turn hides whether the money went to the main
    // thread or its subagents, and conflates the two turn populations. main dollars are the
    // agent-type-keyed "main" cost; everything else the session cost is sub-thread. Each rate is
    // null, never 0, when its denominator is 0 (QC1).
    const mainDollars = g.members.reduce((n, s) => n + (s.costByAgentType?.main ?? 0), 0);
    const totalDollars = g.members.reduce((n, s) => n + (s.costUSD ?? 0), 0);
    const subDollars = totalDollars - mainDollars;
    const mainTurns = g.members.reduce((n, s) => n + (s.mainTurns ?? 0), 0);
    const subagentTurns = g.members.reduce((n, s) => n + (s.subagentTurns ?? 0), 0);
    // Turns/task must draw numerator and denominator from the same population, or turns from
    // workload-less sessions inflate the rate (issue #114). Scope both the summed turns and the
    // planned-task count to sessions that carry a workload record — the runs where task data
    // exists — so the figure reflects only those. null (never 0) when no such session (QC1).
    const taskBearing = g.members.filter((s) => s.workload);
    const tasks = taskBearing.reduce((n, s) => n + (s.workload?.plannedTaskCount ?? 0), 0);
    const taskTurns = taskBearing.reduce((n, s) => n + (s.mainTurns ?? 0) + (s.subagentTurns ?? 0), 0);
    return {
      version: g.version,
      profile: g.profile,
      sessions: g.members.length,
      cycles: cycles.length,
      medianCostPerCycle: median(cycles.map((c) => c.cost)),
      dollarsPerMainTurn: mainTurns ? mainDollars / mainTurns : null,
      dollarsPerSubTurn: subagentTurns ? subDollars / subagentTurns : null,
      turnsPerTask: tasks ? taskTurns / tasks : null,
      delta: { state: "first-seen", pct: null },
      priciestStage: priciest ? priciest[0] : null,
      medianDepth: depths.length ? median(depths) : null,
      quality: aggregateQuality(g.members.map((s) => s.quality ?? null)),
      lowConfidence: g.members.length < MIN_COHORT,
      // A promotion that named no culprit contributes nothing rather than a blank entry — which
      // is every record on disk until Phase 3 teaches recordPromotion to write the field.
      shipped: [...new Set(promotions
        .filter((p) => p.pluginVersion === g.version && p.culpritId)
        .map((p) => p.culpritId))].sort(byName),
    };
  });
  // A second pass, because a row's delta is decided against another row of this same table.
  rows.forEach((row, i) => { row.delta = deltaAgainstPrevious(rows, i, (r) => r.medianCostPerCycle); });
  return rows;
}

// What each stage cost per session across the recent versions, so a stage that is getting more
// expensive shows up before the total does.
export function stageByVersionTable(summaries) {
  const cohorts = versionCohorts(summaries.filter((s) => !s.inFlight));
  const versions = [...cohorts.keys()].filter((v) => v !== "unknown")
    .sort(compareVersions).slice(-TREND_VERSIONS);
  const stages = new Set(versions.flatMap((v) => [...cohorts.get(v).byStage.keys()]));
  const rows = [...stages].map((stage) => {
    const byVersion = {};
    for (const version of versions) {
      const dollars = cohorts.get(version).byStage.get(stage);
      // Absent, not zero: this version simply recorded no cost for this stage.
      byVersion[version] = dollars ? median(dollars) : null;
    }
    return { stage, byVersion, trend: trendAcross(versions.map((v) => byVersion[v])) };
  });
  const rendered = (r) => Object.values(r.byVersion).reduce((n, d) => n + (d ?? 0), 0);
  rows.sort((a, b) => rendered(b) - rendered(a) || byName(a.stage, b.stage));
  return { versions, rows };
}

// Where this window's money went, stage by stage, and how each stage moved against the window
// immediately before it.
export function stageWindowTable(summaries, previousSummaries) {
  const noWindow = previousSummaries === null || previousSummaries === undefined;
  const stageTotal = (list, stage) => list.reduce((n, s) => n + (s.costByStage?.[stage] ?? 0), 0);
  const stages = new Set(summaries.flatMap((s) => Object.keys(s.costByStage ?? {})));
  const rows = [...stages].map((stage) => {
    const total = stageTotal(summaries, stage);
    const before = noWindow ? null : stageTotal(previousSummaries, stage);
    const depths = summaries
      .filter((s) => s.costByStage?.[stage] !== undefined && typeof s.medianDepth === "number")
      .map((s) => s.medianDepth);
    return {
      stage,
      total,
      pctOfWindow: 0,
      medianDepth: depths.length ? median(depths) : null,
      // No window to compare against is not a 0% move, and a stage the previous window never
      // paid for is new rather than up by everything it now costs.
      trend: noWindow ? "n/a (no window)" : before === 0 ? "first seen" : costTrend(total, before),
    };
  });
  const windowTotal = rows.reduce((n, r) => n + r.total, 0);
  for (const r of rows) r.pctOfWindow = windowTotal === 0 ? 0 : (r.total / windowTotal) * 100;
  rows.sort((a, b) => b.total - a.total || byName(a.stage, b.stage));
  return rows;
}

// Per-lens maintenance cost, summed across the corpus. Sourced from lens-cost run records (coordinator-
// reported), not from transcript turns — so it rides the workload-independent path, never the workload
// machinery. A maintain pass with no lens-cost records renders nothing.
export function lensCostTable(summaries) {
  const totals = new Map();
  for (const s of summaries)
    for (const [lens, dollars] of Object.entries(s.costByLens ?? {}))
      totals.set(lens, (totals.get(lens) ?? 0) + dollars);
  return [...totals.entries()]
    .map(([lens, total]) => ({ lens, total }))
    .sort((a, b) => b.total - a.total || byName(a.lens, b.lens));
}

// A key is named by its culprit slug only when every session that recorded the key named the
// same single slug. A key two sessions blamed differently is reported by key rather than by
// picking one of them and printing a name the corpus does not agree on.
function agreedSlug(slugLists) {
  const single = slugLists.filter((l) => l.length === 1).map((l) => l[0]);
  if (!slugLists.length || single.length !== slugLists.length) return null;
  return new Set(single).size === 1 ? single[0] : null;
}

// Every impact key the corpus scored, folded across sessions: one walk feeding both tables
// below, so the culprits and the wins can never disagree about what a key cost or how often it
// fired. The dollar figures are summarizeSession's own impactScores output — this adds them up
// and never recomputes them, per the one-formula constraint.
function impactRows(summaries, vocab = [], band = [], dates = new Map()) {
  const byKey = new Map();
  for (const s of summaries) {
    const version = s.pluginVersion ?? "unknown";
    const profile = s.profile ?? "unknown";
    for (const scored of s.impact ?? []) {
      if (!byKey.has(scored.key))
        byKey.set(scored.key, {
          key: scored.key, event: scored.event, occurrences: 0, impact: 0,
          measurable: true, slugLists: [], cohorts: new Map(),
        });
      const agg = byKey.get(scored.key);
      agg.occurrences += scored.frequency;
      // Unmeasurable propagates: one contribution nobody could price makes the whole row
      // unpriced, never a total that silently counts it as free.
      if (scored.impact === null) agg.measurable = false;
      else agg.impact += scored.impact;
      agg.slugLists.push(s.culpritsByKey?.[scored.key] ?? []);
      const cohortKey = `${version} ${profile}`;
      if (!agg.cohorts.has(cohortKey))
        agg.cohorts.set(cohortKey, { version, profile, sessions: 0, total: 0, values: [], measurable: true });
      const cohort = agg.cohorts.get(cohortKey);
      cohort.sessions += 1;
      if (scored.impact === null) cohort.measurable = false;
      // Keep both: the summed total ranks/displays this key (GC1), and the per-session values feed
      // the version-over-version comparison so a version is never flagged a regression for session
      // count alone (issue #114).
      else { cohort.total += scored.impact; cohort.values.push(scored.impact); }
    }
  }
  return [...byKey.values()].map((agg) => {
    const slug = agreedSlug(agg.slugLists);
    const entry = slug ? vocab.find((v) => v.slug === slug) : null;
    const cohorts = orderVersionProfileRows([...agg.cohorts.values()].map((c) => ({
      version: c.version, profile: c.profile,
      impact: c.measurable ? c.total : null,
      // Per-session median (derived): null, not 0, when the cohort priced nothing (QC1).
      impactPerSession: c.values.length ? median(c.values) : null,
      lowConfidence: c.sessions < MIN_COHORT,
    })));
    // The trend and delta run on the per-session median per version, not the summed total: every
    // session that priced this key on a version contributes one value, and the version's figure is
    // their median (QC2), so eight cheap sessions never read dearer than two of the same cost.
    const versionValues = new Map();
    for (const c of [...agg.cohorts.values()].filter((c) => c.version !== "unknown"))
      versionValues.set(c.version, [...(versionValues.get(c.version) ?? []), ...c.values]);
    const byVersion = new Map();
    for (const [v, vals] of versionValues) byVersion.set(v, vals.length ? median(vals) : null);
    // The version span this key was observed across, and its temporal standing against the band.
    const versionsSeen = [...byVersion.keys()].sort(compareVersions);
    return {
      key: agg.key,
      name: slug ?? agg.key,
      // A key with no vocabulary entry is still reported, labelled as unclassified rather than
      // filed under a kind nobody assigned it.
      kind: entry?.kind ?? "unclassified",
      isWin: WIN_EVENTS.has(agg.event) || entry?.kind === "win",
      impact: agg.measurable ? agg.impact : null,
      occurrences: agg.occurrences,
      // Absent, not zero (QC1): a key seen only under an undetectable version has no range.
      versions: versionsSeen.length ? [versionsSeen[0], versionsSeen.at(-1)] : null,
      lifecycle: versionsSeen.length ? lifecycle(versionsSeen, band, dates) : null,
      delta: cohorts.length
        ? deltaAgainstPrevious(cohorts, cohorts.length - 1, (r) => r.impactPerSession)
        : { state: "first-seen", pct: null },
      trend: trendAcross(versionsSeen.map((v) => byVersion.get(v))),
    };
  });
}

// The friction this corpus is paying for, priciest first: what it cost, how often it happened,
// and whether it is getting better.
export function culpritTable(summaries, vocab) {
  // The recency window every culprit's lifecycle is judged against, built once from the installed
  // version and the plugin's own changelog (reusing recencyBand/releaseDates — QC2).
  const dates = releaseDates(readFileSync(RELEASE_CHANGELOG_PATH, "utf8"));
  const band = recencyBand(installedVersion(), dates);
  return impactRows(summaries, vocab, band, dates)
    .filter((r) => !r.isWin)
    .map(({ name, kind, impact, occurrences, delta, trend, versions, lifecycle: life }) =>
      ({ culprit: name, kind, impact, occurrences, delta, trend, versions, lifecycle: life }))
    // Live problems first, then by money at stake: a culprit still occurring in the recency band
    // is what the reader can act on, ahead of one a newer release has likely moved past.
    .sort((a, b) => (b.lifecycle === "active") - (a.lifecycle === "active") || byImpactDesc(a, b));
}

// What is already working, biggest first: the win events the corpus recorded, plus the
// version-over-version cost improvements emitCandidates found.
export function winTable(summaries, vocab, candidates = []) {
  const rows = impactRows(summaries, vocab)
    .filter((r) => r.isWin)
    .map(({ name, impact, occurrences, trend }) => ({ win: name, impact, occurrences, trend }));
  for (const c of candidates.filter((c) => c.type === "version-improvement"))
    rows.push({
      win: `${c.skill} ${c.version_from}→${c.version_to}`,
      // A cost improvement is a downward cost move, reported as the money it saved.
      impact: Math.abs(c.delta_dollars),
      occurrences: c.sessions_sampled,
      trend: "down",
    });
  return rows.sort(byImpactDesc);
}

// The positive mirror of revertCandidates (issue D2): attach the promotion a version shipped to
// each version-improvement candidate, so a detected cost drop points at what likely caused it.
// Correlational — a matching promotion of any kind is a legitimate correlation, a win-kind one the
// richest; no match is left unattributed for manual investigation.
export function winCandidates(candidates, promotions) {
  return (candidates ?? [])
    .filter((c) => c.type === "version-improvement")
    .map((c) => {
      const shipped = (promotions ?? [])
        .filter((p) => p.pluginVersion === c.version_to && p.culpritId)
        .map((p) => p.culpritId);
      return { ...c, cause: shipped.length ? shipped : null };
    });
}

// The marker playbooks/profiling-sessions.md writes when the Actionability step drafts an
// issue. That playbook is the contract's one written source; this parses what it states, and a
// round-trip test (tests/unit/doctor-report.test.mjs) feeds this parser the literal extracted
// from that file so neither side can drift.
// The slug is colon-separated because the flow offers a draft for every culprit, not only
// vocabulary members: issueBody names an unclassified one by its bare `event:stage` key and a
// new one as `novel:<slug>`. Each segment is still a slug, so the group cannot reach the
// closing bracket or run into the title. Leading whitespace is tolerated because the playbook
// states the marker inside an indented block, and a marker copied from there carries its indent.
const DRAFTED_MARKER_RE =
  /^[ \t]*Drafted: \[culprit:([a-z0-9][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)*)\] (.+)$/gm;

export function parseDraftedMarkers(text) {
  const out = [];
  for (const m of String(text).matchAll(DRAFTED_MARKER_RE))
    out.push({ slug: m[1], title: m[2].trim() });
  return out;
}

// The slug out of a filed issue's title, read with the marker parser above rather than a second
// pattern: an issue title is exactly what follows `Drafted: ` in the marker the playbook writes,
// so the two forms cannot drift into disagreeing about which slug shapes are legal. null for a
// title the filer wrote themselves, which is not this report's work and is not counted.
const titleSlug = (title) =>
  parseDraftedMarkers(`Drafted: ${String(title ?? "").trim()}`)[0]?.slug ?? null;

// Release dates come from the plugin's own CHANGELOG.md headings, back-filled 2026-08-13. A
// heading with no date is omitted rather than defaulted: turnaround measured against a made-up
// release date is a number that reads as fact and is not one. The parser now lives in
// verification.mjs (the resolved-in verdict is its other consumer); imported above.

// gh's stdout, or a thrown error. Short timeout: a hanging gh must not hang a report, and the
// caller degrades to "unavailable" on any throw.
const defaultGhRunner = (args) =>
  execFileSync("gh", args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });

// `vocabOverride` is injected on the same principle as `ghRunner`: the resolved and turnaround
// arithmetic below keys off `resolved-in:`, which no shipped vocabulary entry carries yet, so
// without a substitutable vocabulary that arithmetic could only be exercised by editing
// references/culprits.json. null means "read the shipped one", which is what every caller does.
export function outerLoop(reportsDir, ghRunner = defaultGhRunner, vocabOverride = null) {
  // Drafted is local: it comes from this repo's own persisted reports, so it renders even when
  // gh is unavailable. Reports written before this phase carry no markers, which is why the
  // renderer qualifies the count rather than presenting it as "none drafted".
  // D-4: Drafted is an issue count, so the outer-loop line reads as one funnel with Filed and
  // Resolved rather than mixing units. The key stays deduped — one culprit drafted, declined at a
  // gate and drafted again is one draft — but it keys on the draft, not on the culprit, so two
  // genuinely different issues for one culprit are two drafts.
  const draftedIssues = new Set();
  try {
    for (const f of readdirSync(reportsDir).filter((n) => n.endsWith(".md")))
      for (const m of parseDraftedMarkers(readFileSync(join(reportsDir, f), "utf8")))
        draftedIssues.add(`${m.slug} ${m.title}`);
  } catch (err) {
    if (err.code !== "ENOENT" && err.code !== "ENOTDIR") throw err;
  }
  const drafted = draftedIssues.size;

  const unavailable = {
    drafted, draftedSince: DRAFTED_SINCE,
    filed: "unavailable", resolved: "unavailable", medianTurnaroundDays: "unavailable",
    truncated: false,
  };

  // No `--label` filter: applying a label to devcycle's upstream needs push access, and GitHub
  // drops the labels a user without it supplies when they open an issue — so a label-keyed query
  // returns nothing for every filer but the maintainer, and the section reads zero forever. The
  // title is the one part of the draft every filer can set, and issueBody fixes its form.
  let issues;
  try {
    issues = JSON.parse(ghRunner([
      "issue", "list", "--repo", DEVCYCLE_UPSTREAM, "--author", "@me",
      "--state", "all", "--limit", String(OUTER_LOOP_QUERY_LIMIT),
      "--json", "number,title,labels,createdAt,closedAt,state",
    ]));
    if (!Array.isArray(issues)) return unavailable;
  } catch {
    // Missing gh, an unauthenticated gh, a timeout, or output that is not JSON. All four mean
    // "not measured" — rendering 0 would read as "nothing has ever been filed".
    return unavailable;
  }

  // `gh issue list --limit N` truncates silently, so a prolific filer's funnel would render as a
  // confident under-count. A result exactly at the bound is indistinguishable from one that was
  // cut, so it is reported as a lower bound rather than as a number.
  const truncated = issues.length >= OUTER_LOOP_QUERY_LIMIT;

  let vocab = vocabOverride;
  if (vocab === null) {
    try {
      vocab = JSON.parse(readFileSync(join(PLUGIN_ROOT, "references", "culprits.json"), "utf8"));
    } catch { vocab = []; }
  }
  const resolvedIn = new Map(
    vocab.filter((e) => e && e["resolved-in"]).map((e) => [e.slug, e["resolved-in"]]),
  );
  let dates = new Map();
  try { dates = releaseDates(readFileSync(RELEASE_CHANGELOG_PATH, "utf8")); } catch { dates = new Map(); }

  // Every issue this author opened on the upstream comes back now that the query filters by no
  // label; the ones this report produced are the ones whose title carries the `[culprit:<slug>]`
  // prefix issueBody writes.
  const filed = issues.filter((i) => titleSlug(i.title) !== null);

  const turnarounds = [];
  let resolved = 0;
  for (const issue of filed) {
    const version = resolvedIn.get(titleSlug(issue.title));
    if (!version) continue; // no resolved-in: excluded, never counted as an infinite turnaround
    resolved += 1;
    const released = dates.get(version);
    if (!released) continue;
    const days = (Date.parse(`${released}T00:00:00Z`) - Date.parse(issue.createdAt)) / 86400000;
    if (Number.isFinite(days)) turnarounds.push(days);
  }

  return {
    drafted, draftedSince: DRAFTED_SINCE,
    filed: filed.length,
    resolved,
    medianTurnaroundDays: turnarounds.length ? Math.round(median(turnarounds)) : null,
    truncated,
  };
}

// The cumulative-by-version table: one row per (version, rung) over the standing lessons, each row
// counting how many lessons landed at that rung on that version. It consumes the records
// readPromotions already parsed rather than re-reading the directory here — that reader is the one
// promotion parser, and it owns the IO fail-safe (safePromotions wraps it), so a missing or
// unreadable promotions directory degrades to an empty list upstream and this function sees `[]`.
// A lifecycle record (a retirement or a revert) is counted as retired, never as a standing lesson,
// so a retired lesson does not inflate its rung's count. A record predating `rung:` (rung === null)
// contributes no row, and the note still names what fills the table in.
export function compiledKnowledge(promotions = []) {
  const groups = new Map();
  let retired = 0;
  for (const p of promotions) {
    if (p.lifecycle) { retired++; continue; }
    if (!p.rung) continue;
    const version = p.pluginVersion ?? "unknown";
    const key = `${version} ${p.rung}`;
    if (!groups.has(key)) groups.set(key, { version, rung: p.rung, lessons: 0, contextCost: null });
    groups.get(key).lessons += 1;
  }
  const rows = [...groups.values()].sort((a, b) =>
    a.version === b.version ? a.rung.localeCompare(b.rung) : compareVersions(a.version, b.version));
  return {
    rows,
    retired,
    note: "No data yet — this table fills in from the release that records `rung:` on promotion records.",
  };
}

// ─── The markdown report ─────────────────────────────────────────────────────────────────────

// The one-line plain-language gloss under each heading, written for a reader who has never read
// devcycle's internals. Shipped text from the design's §4 — kept in one table so a section and
// its gloss cannot drift apart, and so the renderer has no place to improvise one.
const GLOSSES = {
  "read-this-first": "Caveats that qualify every number below. Each one says what it excludes and why.",
  ataglance:
    "Workload-adjusted, matched-cohort cost movement across the recency band (derived) — like-for-" +
    "like runs only, so session length or count can't masquerade as a cost change.",
  highlights: "The three things worth knowing before reading any table.",
  "workload-observed":
    "The raw work each run did — files changed, changed lines, planned tasks, waves — straight " +
    "off the run's workload record (observed, never derived). A run with no workload record is " +
    "absent here, not zero.",
  "outcome-observed":
    "The raw result signals per run — conformance verdict, review rounds, retries — straight off " +
    "the run records (observed, not a computed rate).",
  "cost-by-version":
    "What a cycle costs on each plugin version, compared only against the same profile — so a " +
    "month where you happened to run `lean` more often cannot masquerade as an improvement.",
  "cost-by-stage": "Whether a stage is getting cheaper or dearer over releases — not just what it costs today.",
  "cost-by-stage-window": "Where this window's money actually went.",
  culprits:
    "Recurring problems, priced. The dollar figure is what each one actually cost you, summed " +
    "over every occurrence — not a severity guess. The Δ and Trend are per-session (derived), so " +
    "a version is never flagged a regression for running more sessions alone.",
  compliance: "Rules devcycle states but could not enforce, and how often they were broken.",
  wins:
    "What went right, priced the same way — a system that only counts failures cannot tell you " +
    "whether it is improving.",
  anomalies:
    "Individual cost defects: a model with no price, a run far dearer than its peers, a session " +
    "running far deeper than its own startup floor, a stage whose cost jumped between versions, and " +
    "each run's excess over its matched cohort (unmatched when the cohort has no peer).",
  promoted: "Whether lessons this repo already adopted actually stopped the problem recurring.",
  "outer-loop": "Whether filing issues from this report is actually producing fixes.",
  "compiled-knowledge":
    "Whether lessons are getting cheaper to carry — a check costs nothing to read, prose costs " +
    "context on every run.",
  findings: "What to do about all of it: the problems worth fixing, ranked, and the changes that stop a whole class of them.",
  appendix: "Supporting detail: the inputs behind the tables above.",
  // The Appendix's own `###` subsections. Drafted here rather than at the render site for the
  // same reason as every gloss above: shipped prose, reviewed once, in one table.
  "appendix-cost-by-model":
    "Which models the money actually went to — the cut to read when the question is routing " +
    "rather than process.",
  "appendix-cost-by-agent-type":
    "How the spend splits between the main thread and the subagents it dispatched — the first " +
    "check on whether delegation pays for itself.",
  "appendix-context-depth-bands":
    "How many turns ran at each depth band, as a fraction of the model's context window — the " +
    "distribution behind the median-depth columns above.",
  "appendix-startup-floor":
    "What an agent carries before it does any work: the context its very first turn already " +
    "holds, per agent type.",
  "appendix-carry-weighted-tokens":
    "Which content classes are dearest to keep, weighting every token added by the number of " +
    "later turns that had to carry it.",
  "appendix-dispatches":
    "How many subagents were dispatched, and how many inherited the caller's model instead of " +
    "naming one.",
  "appendix-cohorts-by-reviewdepth":
    "The same cohort cut keyed by the `reviewDepth` knob rather than the version, so the other " +
    "lever on review rigor is visible too.",
  "appendix-total-cost-by-version":
    "Total spend per version — the volume figure the per-cycle medians above deliberately leave out.",
  "appendix-per-session-detail":
    "One line per session, so any figure above can be traced back to the sessions that produced it.",
};

// Rendered in place of the two sections the playbook owns. playbooks/profiling-sessions.md
// replaces exactly these two lines when it persists the report and changes nothing else, so the
// template stays wholly script-owned and the playbook writes only prose.
const HIGHLIGHTS_ANCHOR = "<!-- devcycle:highlights -->";
const FINDINGS_ANCHOR = "<!-- devcycle:findings -->";

// An absent value renders as an em dash, never as a blank cell a reader would take for a zero.
const markdownCell = (v) => (v === null || v === undefined || v === "" ? "—" : String(v));

// Every table renders its header row and separator even with nothing in it, and says why it is
// empty — an empty table with no explanation reads as a clean bill of health (QC3).
function markdownTable(headers, rows, whyEmpty) {
  const out = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(markdownCell).join(" | ")} |`),
  ];
  if (!rows.length) out.push("", `_No rows: ${whyEmpty}._`);
  return out;
}

// deltaAgainstPrevious' three states, rendered. A comparison that could not be taken names its
// reason; it never falls back to 0%, which would read as a version that changed nothing.
const deltaText = (d) =>
  d.state === "compared"
    ? `${d.pct >= 0 ? "+" : ""}${d.pct.toFixed(1)}%`
    : d.state === "first-seen" ? "first seen" : "not compared";

// An impact nobody could price is labelled, never rendered as $0.00.
const impactText = (v) => (v === null || v === undefined ? "unmeasurable" : usd(v));

// The Sessions cell of a version×profile row. One owner for two render sites: the issue draft
// quotes the same row this table renders, and a cohort the report declines to stand behind must
// not be quoted as a bare number in an issue filed from it.
const cohortSessionsText = (r) =>
  r.lowConfidence ? `${r.sessions} (low confidence: n<${MIN_COHORT})` : String(r.sessions);

// null means gh answered but no resolved culprit had a dated release — not a zero-day
// turnaround; the string "unavailable" means gh itself could not be reached.
const turnaroundText = (v) =>
  v === null || v === undefined
    ? "unavailable (no resolved culprit has a dated release)"
    : v === "unavailable" ? "unavailable" : `${v} day(s)`;

// Cost anomalies are ranked by the money at stake. A candidate carrying no dollar figure ranks
// last rather than being sorted as if it had been measured at zero.
const anomalyWeight = (c) => Math.abs(c.delta_dollars ?? c.dollars ?? 0);

// What the corpus this report describes actually was, in the reader's terms rather than in flags.
function reportScope(args) {
  if (args.since || args.until)
    return `${args.since ?? "the earliest record"} to ${args.until ?? "now"}`;
  return args.all ? "every transcript, tagged or not" : "every devcycle-tagged session";
}

// The caveat block, in formatReport's own order: unpriced models, the cache-write TTL band,
// forward-filled stage attribution, and sessions still in flight. The band line always renders,
// in formatReport's two forms — the inferred range when the band is open, the "cost is exact"
// affirmation when it is collapsed — because a reader must be able to tell a band that was
// checked and found exact from one that was never checked. The no-caveat fallback stays
// reachable beside it: it is keyed off the caveat classes rather than off the emitted lines, so
// it fires exactly when none of the four qualifies anything (the affirmation is not a caveat).
function caveatLines(summaries, agg) {
  if (!summaries.length) return ["- no sessions matched."];
  const out = [];
  const unpriced = Object.entries(agg.unpriced).sort((a, b) => b[1] - a[1]);
  const filled = summaries.filter((s) => s.attributionSource === "forward-filled").length;
  const inFlight = summaries.filter((s) => s.inFlight).length;
  const band = agg.cacheBand;
  for (const [model, count] of unpriced)
    out.push(`- UNPRICED MODEL: ${model} (${count} requests)`);
  out.push(`- ${cacheBandLine(band)}`);
  if (filled > 0)
    out.push(
      `- ${filled} session(s) have inferred stage costs (forward-filled — no run record); the ` +
        "session ids are in the appendix's per-session detail.",
    );
  if (inFlight > 0)
    out.push(`- ${inFlight} session(s) still in flight (newest record < 30 min old) — ${IN_FLIGHT_NOTE}`);
  if (band.collapsed && !unpriced.length && filled === 0 && inFlight === 0)
    out.push("- No caveats apply to this corpus.");
  return out;
}

// One line per session, in the same shape formatReport's own detail loop emits. The two are
// deliberately separate copies while formatReport is retained: this task keeps that function
// byte-for-byte unchanged, so the shared line is folded into one owner when it is retired.
function sessionDetailLines(summaries) {
  if (!summaries.length) return ["_No rows: no sessions matched._"];
  return summaries.map((s) => {
    // `?? {}` / `?? 0`: a summary built for one table's assertion carries only that table's
    // fields, so this loop must render something rather than throw on an omitted detail field.
    const modelList = Object.keys(s.models ?? {}).join(", ") || "none";
    const toolList = Object.entries(s.tools ?? {}).map(([k, v]) => `${k}:${v}`).join(", ") || "none";
    return (
      `session ${s.id} — turns ${s.turns} (main ${s.mainTurns}, subagent ${s.subagentTurns}), ` +
      `depth median ${s.medianDepth} max ${s.maxDepth}, cost ${usd(s.costUSD ?? 0)}, ` +
      `models [${modelList}], tools [${toolList}], quality: ${qualityText(s.quality)}` +
      (s.attributionSource === "forward-filled"
        ? " [stage costs inferred — forward-filled, no run record]"
        : "") +
      (s.inFlight ? " [in flight — excluded from medians]" : "")
    );
  });
}

// The whole markdown report. Section order is fixed by the design and is the point of it: the
// reader meets the caveats, then the money, then the culprits, then what to do — never a table
// before the caveat that qualifies it. Pure over its arguments: every file read and every clock
// call happens in reportContext, so a test renders the whole document from fixtures.
export function renderReport(summaries, ctx) {
  const {
    repo, today, scope,
    previousSummaries = null, vocab = [], promotions = [],
    outerLoop: loop = null, compiledKnowledge: compiled = null, verification = null,
  } = ctx ?? {};
  const L = [];
  const section = (heading, glossKey) => { L.push("", heading, "", `*${GLOSSES[glossKey]}*`, ""); };
  const agg = aggregate(summaries);
  const candidates = emitCandidates(summaries);
  // The run-level, workload-adjusted view (issue #114): run aggregates over the settled corpus,
  // the recency band the comparison ranges over (reusing recencyBand/releaseDates — QC2), the
  // matched-cohort step deltas, and each run's excess over its cohort. Runs with no runId/workload
  // never reach these (GC5/GC6) — runAggregates already excludes run-less sessions.
  const settledRuns = runAggregates(summaries.filter((s) => !s.inFlight));
  const glanceBand = recencyBand(installedVersion(), releaseDates(readFileSync(RELEASE_CHANGELOG_PATH, "utf8")));
  const glanceSteps = workloadAdjustedSteps(settledRuns, glanceBand);
  const excess = excessCost(settledRuns);

  L.push(
    `# Doctor Report — ${repo} — ${today}`,
    "",
    `Scope: ${scope} · Sessions: ${summaries.length} · Cycles: ${cycleGroups(summaries).length} · ` +
      `Total cost: ${usd(agg.costUSD)} · Prices as of ${PRICING.asOf}`,
  );

  section("## Read this first", "read-this-first");
  L.push(...caveatLines(summaries, agg));

  section("## At a glance", "ataglance");
  const pctText = (v) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);
  L.push(...markdownTable(
    ["Step", "matchKey", "n", "conf", "workload-adj cost Δ% (derived)", "main-turn Δ",
      "sub-turn Δ", "depth Δ", "conformance Δ"],
    glanceSteps.map((r) => [
      `${r.from}→${r.to}`, r.matchKey, r.n, r.confidence, pctText(r.costDeltaPct),
      pctText(r.mainTurnDeltaPct), pctText(r.subTurnDeltaPct), pctText(r.depthDeltaPct),
      r.conformanceDelta == null ? null : `${r.conformanceDelta >= 0 ? "+" : ""}${(r.conformanceDelta * 100).toFixed(0)}pp`,
    ]),
    "no matched cohort spans two adjacent in-band versions yet",
  ));
  const priciestOverall = Object.entries(agg.costByStage).sort((a, b) => b[1] - a[1] || byName(a[0], b[0]))[0];
  L.push("", priciestOverall
    ? `Priciest stage overall (derived): ${priciestOverall[0]} (${usd(priciestOverall[1])}).`
    : "Priciest stage overall (derived): — (no stage cost recorded).");

  section("## Highlights", "highlights");
  L.push(HIGHLIGHTS_ANCHOR);

  // The raw observed workload family (spec C3): one row per run that wrote a workload record,
  // its raw counts straight off that record. Runs with no workload record have nothing to
  // observe and drop out (changedLines is null exactly when no record was joined — GC3).
  const compliance = complianceCandidatesOf(summaries);
  section("## Workload (observed)", "workload-observed");
  L.push(...markdownTable(
    ["Run", "Version", "Profile", "Request kind (observed)", "Band (derived)",
      "Files changed (observed)", "Changed lines (observed)", "Tasks (observed)", "Waves (observed)"],
    settledRuns
      .filter((r) => r.changedLines != null)
      .sort((a, b) => compareVersions(a.version, b.version) || byName(a.runId, b.runId))
      .map((r) => [
        r.runId.slice(0, 8), r.version, r.profile, r.requestKind, r.workloadBand,
        r.filesChanged, r.changedLines, r.tasks, r.waveCount,
      ]),
    "no run carries a workload record yet",
  ));
  const missingWorkload = compliance.filter((c) => c.type === "missing-workload");
  if (missingWorkload.length)
    L.push("", `> ${missingWorkload.length} cycle(s) committed work but recorded no workload — see ### Compliance (missing-workload). A thin or empty table above may reflect that collection gap, not absence of work.`);

  section("## Cost by version", "cost-by-version");
  L.push(...markdownTable(
    ["Version", "Profile", "Sessions (observed)", "Cycles (observed)", "Median $/cycle (derived)",
      "$/main-turn (derived)", "$/sub-turn (derived)", "Turns/task (derived)", "Δ vs previous (derived)",
      "Priciest stage (derived)", "Median depth (derived)", "Quality (derived)", "Shipped (observed)"],
    versionProfileTable(summaries, promotions).map((r) => [
      r.version,
      r.profile,
      cohortSessionsText(r),
      r.cycles,
      usd(r.medianCostPerCycle),
      r.dollarsPerMainTurn === null ? null : usd(r.dollarsPerMainTurn),
      r.dollarsPerSubTurn === null ? null : usd(r.dollarsPerSubTurn),
      r.turnsPerTask === null ? null : r.turnsPerTask.toFixed(1),
      deltaText(r.delta),
      r.priciestStage,
      r.medianDepth,
      qualityText(r.quality),
      r.shipped.join(", "),
    ]),
    "no sessions in this corpus",
  ));

  section("## Cost by stage", "cost-by-stage");
  const stageTrend = stageByVersionTable(summaries);
  L.push(...markdownTable(
    ["Stage", ...stageTrend.versions, "Trend (derived)"],
    stageTrend.rows.map((r) => [
      r.stage,
      ...stageTrend.versions.map((v) => (r.byVersion[v] === null ? null : usd(r.byVersion[v]))),
      r.trend,
    ]),
    "no version-tagged sessions to compare across releases",
  ));
  L.push("", "_Dollar cells are derived per-version medians; Trend is derived._");
  // stageByVersionTable drops the undetectable-version cohort from every column and every trend,
  // because "unknown" cannot sit on a version axis — right, but silent, and an omission nobody
  // names reads as a clean bill of health. cohortTable is the sibling that keeps that bucket,
  // computed over the same corpus by the same rules, so the two cannot disagree about what was
  // excluded. No unknown row means nothing was dropped: no line at all, rather than a zero.
  const droppedCohort = cohortTable(summaries).find((r) => r.version === "unknown");
  if (droppedCohort)
    L.push(
      "",
      `_Excluded from this table: ${droppedCohort.sessions} session(s), ${usd(droppedCohort.total)} ` +
        "(inferred: no version detectable). Their cost is in Total cost by version, in the appendix._",
    );

  section("### Cost by stage (this window)", "cost-by-stage-window");
  L.push(...markdownTable(
    ["Stage", "Cost (observed)", "% of window (derived)", "Median depth (derived)",
      "Trend vs previous window (derived)"],
    stageWindowTable(summaries, previousSummaries).map((r) => [
      r.stage, usd(r.total), `${r.pctOfWindow.toFixed(1)}%`, r.medianDepth, r.trend,
    ]),
    "no stage cost recorded in this window",
  ));

  section("### Cost by lens (maintain, observed)", "cost-by-lens");
  L.push(...markdownTable(
    ["Lens", "Cost (observed)"],
    lensCostTable(summaries).map((r) => [r.lens, usd(r.total)]),
    "no per-lens cost recorded (maintain passes emit lens-cost records)",
  ));
  L.push("", "_Sourced from lens-cost run records; workload-independent (maintenance emits no workload record)._");

  // The raw observed outcome family (spec C3): one row per run carrying a quality signal, its
  // raw verdicts/counts straight off the run records. conformancePass is null exactly when no
  // member reported a quality signal, so that null is the "no outcome to observe" filter (GC3).
  section("## Outcome (observed)", "outcome-observed");
  L.push(...markdownTable(
    ["Run", "Version", "Conformance pass (observed)", "Review rounds (observed)", "Retries (observed)"],
    settledRuns
      .filter((r) => r.conformancePass != null)
      .sort((a, b) => compareVersions(a.version, b.version) || byName(a.runId, b.runId))
      .map((r) => [
        r.runId.slice(0, 8), r.version,
        r.conformancePass ? "pass" : "fail", r.reviewRounds, r.retries,
      ]),
    "no run carries an outcome signal yet",
  ));

  section("## Your culprits", "culprits");
  L.push(...markdownTable(
    ["Culprit", "Kind", "Cost (observed)", "Occurrences (observed)", "Δ vs previous (derived)",
      "Trend (derived)", "Versions (observed)", "Lifecycle (derived)"],
    culpritTable(summaries, vocab).map((r) => [
      r.culprit, r.kind, impactText(r.impact), r.occurrences, deltaText(r.delta), r.trend,
      r.versions ? `${r.versions[0]}..${r.versions[1]}` : null, r.lifecycle,
    ]),
    "no scored culprit events in this corpus",
  ));

  section("### Compliance", "compliance");
  L.push(...(compliance.length
    ? compliance.map((c) => `- ${formatComplianceCandidate(c)}`)
    : ["_No rows: no compliance signals in this corpus._"]));

  section("## Your wins", "wins");
  L.push(...markdownTable(
    ["Win", "Value", "Occurrences", "Trend"],
    winTable(summaries, vocab, candidates).map((r) => [
      r.win, impactText(r.impact), r.occurrences, r.trend,
    ]),
    "no win events recorded in this corpus",
  ));
  // A detected win is no longer merely tabulated then dropped (issue D2): the positive mirror of the
  // escalation entry-point below. Each version-improvement gets a non-corrective Actionability line
  // pointing at `/devcycle:learn` to deliberately mine WHY it improved, naming the promotion that
  // shipped with the improved version as the correlational cause — visibly lower confidence than a
  // revertCandidates hit (QC4), unattributed when no promotion matches.
  for (const w of winCandidates(candidates, promotions))
    L.push(`- Actionability — \`/devcycle:learn\` investigate & generalize the ${w.skill} ` +
      `${w.version_from}→${w.version_to} improvement ` +
      (w.cause ? `(shipped: ${w.cause.join(", ")})` : "(unattributed — investigate manually)"));

  section("## Cost anomalies", "anomalies");
  // version-improvement belongs to Your wins above; everything else emitCandidates found is a
  // cost defect, priciest first.
  const anomalies = candidates
    .filter((c) => c.type !== "version-improvement")
    .sort((a, b) => anomalyWeight(b) - anomalyWeight(a));
  // The run-level residual (issue #114): a run dearer than its matched cohort, ranked by the excess.
  // A run in a cohort of one has no peer to set an expectation, so it is reported as unmatched
  // rather than as an outlier (QC1). Cheaper-than-cohort runs are not anomalies and drop out.
  const excessLines = excess
    .filter((r) => r.confidence === "insufficient" || (r.excess ?? 0) > 0)
    .sort((a, b) => (b.excess ?? -Infinity) - (a.excess ?? -Infinity))
    .map((r) => r.confidence === "insufficient"
      ? `- EXCESS-COST: ${r.matchKey} version=${r.version} unmatched — no expectation (cohort n=${r.cohortN})`
      : `- EXCESS-COST: ${r.matchKey} version=${r.version} actual=${usd(r.actual)} ` +
        `expected=${usd(r.expected)} excess=${usd(r.excess)} (${r.confidence}, n=${r.cohortN})`);
  // A version-regression no promotion explains gets a correlational citation of the version's own
  // changelog entry (issue D1) — visibly lower confidence than a revertCandidates hit (QC4). The
  // changelog is read once; an unreadable file degrades to no citation rather than aborting the
  // report (QC1).
  let anomalyChangelog = "";
  try { anomalyChangelog = readFileSync(RELEASE_CHANGELOG_PATH, "utf8"); } catch { anomalyChangelog = ""; }
  const anomalyCandidateLines = anomalies.flatMap((c) => {
    const line = `- ${formatCandidate(c)}`;
    if (c.type !== "version-regression") return [line];
    const attr = regressionAttribution(c, promotions, anomalyChangelog);
    if (!attr) return [line];
    return [line, `  ↳ correlated change (unverified): ${attr.entry ? attr.entry[0] : "no changelog entry for " + attr.version}`];
  });
  const anomalyLines = [...anomalyCandidateLines, ...excessLines];
  L.push(...(anomalyLines.length
    ? anomalyLines
    : ["_No rows: no cost anomalies in this corpus._"]));

  section("## Previously promoted — did it hold", "promoted");
  // The verification engine computes every verdict; this only renders it. One line per scoreboard
  // entry (held / recurred / unmeasurable / broken / errored), then the resolved-in lines, then the
  // Actionability menu — each recurred lesson the engine flagged for escalation becomes a
  // `/devcycle:cycle` entry point the reader can run (playbooks/profiling-sessions.md).
  const v = verification ?? { scoreboard: [], candidates: { escalation: [], retirement: [] }, resolvedIn: [] };
  const overRuns = (n) => (n ? ` over ${n} run${n === 1 ? "" : "s"}` : "");
  if (!v.scoreboard.length && !v.resolvedIn.length) {
    L.push("_No promoted lesson has been measured against a run yet._");
  } else {
    for (const s of v.scoreboard)
      // The engine's detail carries WHY, and a verdict without it reads as a measurement nobody
      // took: a skipped check (no --run-checks), an unrunnable path and an errored harness all
      // land on "unmeasurable"/"errored" and are only told apart by this suffix.
      L.push(`- ${s.culpritId} (${s.rung}): ${s.verdict}${overRuns(s.runsObserved)}${s.detail ? ` — ${s.detail}` : ""}`);
    for (const r of v.resolvedIn)
      L.push(`- ${r.culpritId}: resolved in ${r.resolvedIn} — ${r.verdict}${overRuns(r.runsObserved)}`);
    for (const e of v.candidates.escalation)
      L.push(`- Actionability — \`/devcycle:cycle\` re-address ${e.culpritId} (${e.reason}; escalate from ${e.rung})`);
  }

  section("## Outer loop", "outer-loop");
  // A probe that could not run renders "unavailable" for every field it feeds — never 0, which
  // would read as "nothing has ever been filed".
  const l = loop ?? {
    drafted: "unavailable", draftedSince: DRAFTED_SINCE,
    filed: "unavailable", resolved: "unavailable", medianTurnaroundDays: "unavailable",
    truncated: false,
  };
  L.push(
    `- Drafted: ${l.drafted} (issues; markers recorded since ${l.draftedSince})`,
    `- Filed: ${l.filed}`,
    `- Resolved: ${l.resolved}`,
    ...(l.truncated
      ? [`- Note: the issue query returned results at the ${OUTER_LOOP_QUERY_LIMIT}-issue query limit — the counts below are a lower bound`]
      : []),
    `- Median turnaround: ${turnaroundText(l.medianTurnaroundDays)}`,
  );

  section("## Compiled knowledge (cumulative, by version)", "compiled-knowledge");
  const ck = compiled ?? { rows: [], note: "Unavailable — the compiled-knowledge probe did not run." };
  L.push(...markdownTable(
    ["Version", "Rung", "Lessons", "Context cost"],
    ck.rows.map((r) => [r.version, r.rung, r.lessons, r.contextCost]),
    ck.note.replace(/\.$/, ""),
  ));

  section("## Findings", "findings");
  L.push(FINDINGS_ANCHOR);

  section("## Appendix", "appendix");

  section("### Cost by model", "appendix-cost-by-model");
  L.push(ranked(agg.costByModel, usd) || "_No rows: no priced turns in this corpus._");

  section("### Cost by agent type", "appendix-cost-by-agent-type");
  L.push(ranked(agg.costByAgentType, usd) || "_No rows: no priced turns in this corpus._");

  section("### Context depth bands", "appendix-context-depth-bands");
  L.push(BAND_LABELS.map((label) => `${label} ${agg.bandCounts[label]}`).join(", "));

  section("### Startup floor by agent type", "appendix-startup-floor");
  L.push(
    Object.entries(agg.startupFloor)
      .sort((a, b) => median(b[1]) - median(a[1]))
      .map(([k, v]) => `${k} median ${median(v)} min ${Math.min(...v)} (n=${v.length})`)
      .join(", ") || "_No rows: no session recorded a first turn._",
  );

  section("### Carry-weighted tokens by content class", "appendix-carry-weighted-tokens");
  L.push(ranked(agg.carryWeighted, (v) => Math.round(v)) || "_No rows: no content classes recorded._");

  section("### Dispatches", "appendix-dispatches");
  L.push(`${agg.dispatches.total} dispatched, ${agg.dispatches.withoutModel} without an explicit model`);

  section("### Cohorts by reviewDepth", "appendix-cohorts-by-reviewdepth");
  L.push(...markdownTable(
    ["reviewDepth", "Sessions", "Total", "Median/session", "Quality"],
    reviewDepthCohortTable(summaries).map((r) => [
      r.inferred ? `${r.reviewDepth} (inferred: ${r.inferred})` : r.reviewDepth,
      r.sessions, usd(r.total), usd(r.medianPerSession), qualityText(r.quality),
    ]),
    "no settled sessions in this corpus",
  ));

  section("### Total cost by version", "appendix-total-cost-by-version");
  L.push(...markdownTable(
    ["Version", "Sessions", "Total", "Median/session", "Median depth", "Quality"],
    cohortTable(summaries).map((r) => [
      r.inferred ? `${r.version} (inferred: ${r.inferred})` : r.version,
      r.sessions, usd(r.total), usd(r.medianPerSession), r.medianDepth, qualityText(r.quality),
    ]),
    "no settled sessions in this corpus",
  ));
  const direction = corpusDirectionOfTravel(runAggregates(summaries.filter((s) => !s.inFlight)));
  L.push(
    "",
    direction.direction === "insufficient-data"
      ? `Direction of travel: insufficient data (${direction.reason})`
      : `Direction of travel: ${direction.direction} (${direction.deltaPct.toFixed(1)}% median ` +
        `cost, ${direction.matchKey}, ${direction.from}→${direction.to})`,
  );

  section("### Per-session detail", "appendix-per-session-detail");
  L.push(...sessionDetailLines(summaries));

  L.push("", `prices as of ${PRICING.asOf}`, "", DISCLOSURE, "", DEPTH_DISCLOSURE, "");
  return L.join("\n");
}

// The culprit vocabulary and the promotion records, each with the one degrade path the report
// has always used. Named here because the issue draft names a culprit and quotes a cohort row
// from the same two artifacts: a second parse could disagree with the report it was filed from.
function readVocab() {
  try {
    const parsed = JSON.parse(readFileSync(join(PLUGIN_ROOT, "references", "culprits.json"), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function safePromotions() {
  try { return readPromotions(process.cwd()); } catch { return []; }
}

// Everything the report needs that the summaries cannot carry: the repo it ran in, today's date,
// and the three artifacts that live outside the transcripts. Built once and handed to both the
// markdown renderer and --json, so the two forms can never describe different corpora. Each
// artifact degrades to its own empty form rather than failing the whole report.
function reportContext(args, result) {
  const vocab = readVocab();
  const promotions = safePromotions();
  return {
    // The repo's name, never its path — QC8: no emitted artifact carries machine identity.
    repo: basename(process.cwd()),
    today: new Date().toISOString().slice(0, 10),
    scope: reportScope(args),
    previousSummaries: result.previousSessions,
    vocab,
    promotions,
    outerLoop: outerLoop(join(process.cwd(), ".devcycle", "doctor")),
    compiledKnowledge: compiledKnowledge(promotions),
    verification: promotionVerification(promotions, args.runChecks),
  };
}

// The engine renders, doctor never recomputes: flatten every run record's journal events (the same
// journalEvents set impactScores reads), tag each with its own record's runId so runsObserved can
// count distinct runs, and hand them to verify() with the installed plugin version. A missing runs
// directory or an unreadable plugin.json degrades to an empty verification rather than aborting the
// whole report (QC7 — the same fail-safe safePromotions gives the promotion records).
function promotionVerification(promotions, runChecks = false) {
  try {
    const events = [...readRunRecords().values()].flatMap((rec) =>
      journalEvents(rec).map((e) => ({ ...e, runId: e.runId ?? rec.runId })));
    // Opt-in only: without --run-checks the engine's non-executing default stands, so a report
    // over a freshly cloned repo cannot be made to run that repo's committed `- verify:` lines.
    return verify(promotions, events, installedVersion(), runChecks ? { runCheck: defaultRunCheck } : {});
  } catch {
    return { scoreboard: [], candidates: { escalation: [], retirement: [] }, resolvedIn: [] };
  }
}

// The prose body under a version's ## heading, for citing what a non-promotion regression
// coincided with (issue D1). Correlational only — labelled as such at the render site (QC4).
export function changelogEntry(changelogText, version) {
  const lines = String(changelogText).split("\n");
  const head = new RegExp(`^## ${version.replace(/\./g, "\\.")} — \\d{4}-\\d{2}-\\d{2}`);
  let i = lines.findIndex((l) => head.test(l));
  if (i < 0) return null;
  const body = [];
  for (i++; i < lines.length && !/^## /.test(lines[i]); i++)
    if (lines[i].trim()) body.push(lines[i].trim());
  return body.length ? body : null;
}

// D1: revertCandidates already explains a promotion-sourced regression; for every other
// version-regression, cite the version's own changelog entry as a *correlational* candidate cause,
// never with a revertCandidates hit's confidence.
export function regressionAttribution(candidate, promotions, changelogText) {
  const shipped = (promotions ?? []).some((p) => p.pluginVersion === candidate.version_to && p.culpritId);
  if (shipped) return null;
  return { correlational: true, version: candidate.version_to, entry: changelogEntry(changelogText, candidate.version_to) };
}

// Revert detection is cost-driven and lives here, not in the engine (QC1 / spec §5.3): the engine
// never sees cost cohorts. A landed lesson whose own (profile, stage) cost regressed after the
// version it landed on is a candidate to undo — same profile only, so a profile-mix shift can never
// masquerade as a regression, and stage-scoped, so one dear stage does not indict the rest. The undo
// is an edit, never `git revert`. Reuses versionCohorts on a profile-filtered slice rather than
// building a second (profile, stage) grouper (QC2). The sidecar write degrades, never aborts (QC7).
const REVERT_REGRESSION_PCT = 15;

export function revertCandidates(summaries, promotions, { root = process.cwd() } = {}) {
  const settled = (summaries ?? []).filter((s) => !s.inFlight);
  const profiles = [...new Set(settled.map((s) => s.profile ?? "unknown"))];
  const candidates = [];
  for (const p of promotions ?? []) {
    if (p.lifecycle || !p.culpritId || !p.pluginVersion) continue;
    for (const profile of profiles) {
      const cohorts = versionCohorts(settled.filter((s) => (s.profile ?? "unknown") === profile));
      const known = [...cohorts.keys()].filter((ver) => ver !== "unknown").sort(compareVersions);
      const idx = known.indexOf(p.pluginVersion);
      if (idx < 1) continue;                         // no same-profile predecessor to compare against
      const before = cohorts.get(known[idx - 1]);
      const after = cohorts.get(known[idx]);
      for (const stage of new Set([...before.byStage.keys(), ...after.byStage.keys()])) {
        const b = median(before.byStage.get(stage) ?? []);
        const a = median(after.byStage.get(stage) ?? []);
        if (!b) continue;                            // no baseline to measure a regression against
        const deltaPct = Math.round(((b - a) / b) * 1000) / 10;   // > 0 cheaper, < 0 dearer
        if (deltaPct < -REVERT_REGRESSION_PCT)
          candidates.push({
            culpritId: p.culpritId, rung: p.rung, landedCommit: p.commit ?? null,
            profile, stage, deltaPct,
            reason: `${stage} cost rose ${Math.abs(deltaPct).toFixed(1)}% from ${known[idx - 1]} to ` +
              `${p.pluginVersion} on the ${profile} profile`,
          });
      }
    }
  }
  const out = { generatedAt: new Date().toISOString(), installedVersion: installedVersion(), candidates };
  try {
    const dir = join(root, ".devcycle", "doctor");
    mkdirSync(dir, { recursive: true });
    atomicWrite(join(dir, "revert-candidates.json"), JSON.stringify(out, null, 2) + "\n");
  } catch { /* QC7: the sidecar write must never abort the report */ }
  return out;
}

// ─── The issue draft ─────────────────────────────────────────────────────────────────────────
// What `--issue-body` prints, and only prints: doctor never posts. The draft carries enums and
// counts only — no path, no machine name, no session id, no transcript excerpt (QC8) — because
// it is written to be pasted into a public issue tracker by a reader who has not audited it.

// The extensions worth naming a repo's language by, and the name each maps to. Every value is a
// bare lowercase word: a name carrying a version or a separator would be a fact about this
// machine's toolchain rather than about the repo's shape.
const LANGUAGE_BY_EXT = {
  mjs: "javascript", js: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript",
  py: "python", rs: "rust", go: "go", rb: "ruby",
  java: "java", kt: "kotlin", swift: "swift",
  cs: "csharp", c: "c", cpp: "cpp",
};

const TEST_RUNNER_PACKAGES = ["vitest", "jest", "mocha", "ava"];

// A bare command name. A `scripts.test` that starts with anything else — an inline env
// assignment, a relative script path — names something about this checkout rather than a
// runner, so it is not carried into the draft.
const BARE_COMMAND = /^[a-z][a-z0-9-]*$/;

const unknownShape = () => ({ monorepo: false, language: "unknown", testRunner: "unknown" });

// What kind of repo doctor is running in, as three enums and nothing else, so an issue draft
// carries enough shape to place the report without carrying anything about the machine. Only
// tracked files are read, so an untracked scratch manifest never decides the answer. QC5: a
// directory that is not a checkout, or a machine with no git, degrades to the all-unknown shape
// rather than throwing — an undetectable shape is labelled, never guessed.
export function repoShape(cwd) {
  let tracked;
  try {
    tracked = execFileSync("git", ["-C", cwd, "ls-files"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 32 * 1024 * 1024,
    }).split("\n").filter(Boolean);
  } catch {
    return unknownShape();
  }
  const readTracked = (path) => {
    try { return readFileSync(join(cwd, path), "utf8"); } catch { return null; }
  };
  const manifestPaths = tracked.filter((f) => basename(f) === "package.json");
  let manifest = null;
  if (manifestPaths.includes("package.json")) {
    try { manifest = JSON.parse(readTracked("package.json") ?? ""); } catch { manifest = null; }
  }

  const cargoWorkspace = tracked
    .filter((f) => basename(f) === "Cargo.toml")
    .some((f) => /^\s*\[workspace\]/m.test(readTracked(f) ?? ""));
  const monorepo =
    tracked.includes("pnpm-workspace.yaml") ||
    cargoWorkspace ||
    manifest?.workspaces !== undefined ||
    manifestPaths.length > 1;

  const counts = new Map();
  for (const f of tracked) {
    const ext = f.includes(".") ? f.slice(f.lastIndexOf(".") + 1) : "";
    if (LANGUAGE_BY_EXT[ext]) counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  // Ties break by extension name, so the same tree always reports the same language.
  const commonest = [...counts.entries()].sort((a, b) => b[1] - a[1] || byName(a[0], b[0]))[0];
  const language = commonest ? LANGUAGE_BY_EXT[commonest[0]] : "unknown";

  const scripted = String(manifest?.scripts?.test ?? "").trim().split(/\s+/)[0];
  const deps = { ...(manifest?.dependencies ?? {}), ...(manifest?.devDependencies ?? {}) };
  const testRunner =
    BARE_COMMAND.test(scripted) ? scripted
      : TEST_RUNNER_PACKAGES.find((p) => p in deps) ?? "unknown";

  return { monorepo, language, testRunner };
}

// The human half of the title. A vocabulary member is described by the vocabulary; a bare
// `event:stage` row is named by its own key, and a `novel:` slug by the label its author chose —
// none of the three is ever left blank, because every ranked culprit is offered a draft whether
// or not it has been promoted into the vocabulary.
function culpritTitle(slug, entry) {
  if (entry?.desc) return entry.desc;
  return slug.startsWith("novel:") ? slug.slice("novel:".length) : slug;
}

// The sessions that recorded this culprit — by the slug a session attributed to an impact key,
// or by the key itself for a row the corpus never named.
function sessionsNaming(slug, summaries) {
  return summaries.filter((s) =>
    Object.values(s.culpritsByKey ?? {}).some((l) => (l ?? []).includes(slug)) ||
    (s.impact ?? []).some((i) => i.key === slug));
}

// The version×profile row this culprit was mostly recorded under, taken from the table the
// report itself renders rather than recomputed — the issue and the report quote one row. Ties
// keep the table's own order, and a cohort with no settled row yields null rather than a
// fabricated one.
function cohortRowFor(sources, versionProfile) {
  const keyOf = (version, profile) => `${version} ${profile}`;
  const counts = new Map();
  for (const s of sources) {
    const k = keyOf(s.pluginVersion ?? "unknown", s.profile ?? "unknown");
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return (versionProfile ?? [])
    .filter((r) => counts.has(keyOf(r.version, r.profile)))
    .sort((a, b) => counts.get(keyOf(b.version, b.profile)) - counts.get(keyOf(a.version, a.profile)))[0]
    ?? null;
}

// This culprit's own events, folded by stage. Frequencies come from the summaries' already-scored
// impact rows, so the draft counts exactly what the report counted.
function eventCountsByStage(slug, sources) {
  const counts = new Map();
  for (const s of sources)
    for (const i of s.impact ?? []) {
      if (!(s.culpritsByKey?.[i.key] ?? []).includes(slug) && i.key !== slug) continue;
      const k = `${i.event} in ${i.stage}`;
      counts.set(k, (counts.get(k) ?? 0) + i.frequency);
    }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || byName(a[0], b[0]));
}

// Thrown by issueBody when a culprit was last observed entirely outside the recency band: a
// problem a newer release may already have addressed, so drafting an issue for it would file
// stale noise. main() prints the message and exits non-zero rather than emitting a body.
export class StaleCulpritError extends Error {}

// A ready-to-paste GitHub issue for one culprit: a title, two labels, and a body of enums and
// counts. Nothing here posts anything, and nothing here recomputes a figure — the cohort row and
// the culprit's cost are read from the tables the report rendered.
export function issueBody(slug, summaries, tables, shape) {
  const vocab = readVocab();
  const entry = vocab.find((v) => v.slug === slug) ?? null;
  const named = sessionsNaming(slug, summaries ?? []);
  const row = cohortRowFor(named, tables?.versionProfile);

  // Version-scope guard: judge the culprit's occurrence versions against the recency band, so a
  // draft is never filed for a problem a newer release has already moved past. Reuses recencyBand
  // and releaseDates (QC2). A culprit whose sessions carry no detectable version can't be judged
  // stale, so the guard only fires when there is at least one positioned occurrence.
  const installed = installedVersion();
  const band = recencyBand(installed, releaseDates(readFileSync(RELEASE_CHANGELOG_PATH, "utf8")));
  const occVersions = [...new Set(named.map((s) => s.pluginVersion).filter((v) => v && v !== "unknown"))]
    .sort(compareVersions);
  const minVersion = occVersions[0];
  const maxVersion = occVersions.at(-1);
  const anyInBand = occVersions.some((v) => inBand(v, band));
  if (occVersions.length && !anyInBand)
    throw new StaleCulpritError(
      `culprit '${slug}' not observed on installed ${installed} — last seen ${maxVersion}`);
  const partiallyStale = occVersions.length && !occVersions.every((v) => inBand(v, band));
  const scopeLines = [];
  if (occVersions.length) {
    scopeLines.push(`Version scope: versions=[${minVersion}..${maxVersion}]`);
    if (maxVersion !== installed)
      scopeLines.push(`- not observed on installed (${installed}) — last seen ${maxVersion}`);
  }
  const culprit = (tables?.culprits ?? []).find((r) => r.culprit === slug) ?? null;
  const events = eventCountsByStage(slug, named);
  const wins = winTable(summaries ?? [], vocab)
    .map((w) => `${w.win} ×${w.occurrences}`)
    .join(", ");

  const L = [
    // A partially-stale culprit — seen inside the band but also before it — leads with a banner so
    // the reader knows the newest release may have already changed the picture.
    ...(partiallyStale ? [`> ⚠ STALE — last seen ${maxVersion}, installed ${installed}`, ""] : []),
    `Culprit: ${slug} (${culprit?.kind ?? entry?.kind ?? "unclassified"})`,
    // Unknown, never dropped: a session whose version or profile could not be extracted renders
    // under the literal `unknown` the cohort table gives it.
    row
      ? `Plugin version: ${row.version} · Profile: ${row.profile}`
      : "Plugin version: unrecorded · Profile: unrecorded",
    ...scopeLines,
    `Repo shape: monorepo=${shape?.monorepo ?? "unknown"} · language=${shape?.language ?? "unknown"} ` +
      `· test-runner=${shape?.testRunner ?? "unknown"}`,
    "",
    "Events by stage:",
    ...(events.length
      ? events.map(([k, n]) => `- ${k} ×${n}`)
      : ["- none recorded for this culprit"]),
    "",
    // The cohort figures carry the same qualifier the report's Cost-by-version table carries for
    // this row, so a two-session cohort cannot be quoted bare in an issue filed from a report
    // that declines to stand behind it.
    row ? "Cohort, as the report renders it:" : "Cohort: unavailable (no settled cohort row for this culprit)",
    ...(row
      ? [
          `- Sessions: ${cohortSessionsText(row)}`,
          `- Cycles: ${row.cycles}`,
          `- Median $/cycle: ${usd(row.medianCostPerCycle)}`,
          `- Priciest stage: ${row.priciestStage ?? "unrecorded"}`,
          `- Δ vs previous: ${deltaText(row.delta)}`,
        ]
      : []),
    `- Cost attributed to this culprit: ${impactText(culprit?.impact)} over ` +
      `${culprit?.occurrences ?? 0} occurrence(s)`,
    "",
    `Wins recorded in the same corpus: ${wins || "none recorded"}`,
    "",
    "<!-- add anything you want to say here -->",
  ];

  return {
    repo: DEVCYCLE_UPSTREAM,
    title: `[culprit:${slug}] ${culpritTitle(slug, entry)}`,
    labels: [`culprit:${slug}`, "from-doctor"],
    body: L.join("\n"),
  };
}

// Exactly what `--issue-body` prints. The repo line leads because it is the one field the filing
// step must act on rather than paste: a bare `gh issue create` resolves to the repo the run
// happened in, so a draft filed without it lands in the user's own tracker while the Outer loop
// section queries DEVCYCLE_UPSTREAM and counts zero. Held here, not inlined in main(), so the
// printed form is pinned by a test rather than by nothing.
export function issueDraftLines(draft) {
  return [
    `repo: ${draft.repo}`,
    `title: ${draft.title}`,
    `labels: ${draft.labels.join(", ")} (suggested — the maintainer applies these at triage; an issue opened without push access cannot set them)`,
    "",
    draft.body,
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
