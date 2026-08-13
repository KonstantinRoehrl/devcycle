#!/usr/bin/env node
// Re-measures devcycle's token cost from session transcripts: turn counts, main-thread
// vs subagent split, context depth, tool mix, and dollar cost by model, stage, and agent.
// Read-only. Emits counts, dollars, model ids, tool names, and skill names only.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PRICING, priceFor } from "./pricing.mjs";

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

export function parseArgs(argv) {
  const args = {
    dir: join(homedir(), ".claude", "projects"),
    since: null,
    until: null,
    json: false,
    all: false,
    depth: false,
    drift: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") args.dir = argv[++i];
    else if (a === "--since") args.since = argv[++i];
    else if (a === "--until") args.until = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "--all") args.all = true;
    else if (a === "--depth") args.depth = true;
    else if (a === "--drift") args.drift = argv[++i];
  }
  return args;
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

// One aggregate statement of where the corpus is headed, oldest known version to newest,
// reusing versionCohorts' own grouping and compareVersions' own sort rather than
// re-implementing either (per-version/per-skill deltas already exist in emitCandidates below;
// this is the roll-up neither of those provides).
export function corpusDirectionOfTravel(settled) {
  const cohorts = versionCohorts(settled);
  const known = [...cohorts.keys()].filter((v) => v !== "unknown").sort(compareVersions);
  if (known.length < 2) return { direction: "insufficient-data", deltaPct: null };
  const first = median(cohorts.get(known[0]).dollars);
  const last = median(cohorts.get(known[known.length - 1]).dollars);
  if (first === 0) return { direction: "insufficient-data", deltaPct: null };
  const deltaPct = ((last - first) / first) * 100;
  return { direction: deltaPct > 1 ? "up" : deltaPct < -1 ? "down" : "flat", deltaPct };
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
        delta_pct: null,
        dollars: s.costUSD ?? null,
        sessions_sampled: 1,
      });
    }
  }

  // Cost outliers — a run costing far more than its peers for the same skill, independent
  // of any version-cohort comparison (fires even with a single version observed, unlike
  // version-regression above, which needs two adjacent cohorts to compare).
  const costsBySkill = new Map(); // skill -> [dollars]
  for (const s of settled) {
    for (const [skill, dollars] of Object.entries(s.costByStage ?? {})) {
      if (!costsBySkill.has(skill)) costsBySkill.set(skill, []);
      costsBySkill.get(skill).push(dollars);
    }
  }
  for (const [skill, dollars] of costsBySkill) {
    if (dollars.length < 3) continue; // too few runs to call anything a peer outlier
    const skillMedian = median(dollars);
    if (skillMedian <= 0) continue;
    for (const d of dollars) {
      if (d > skillMedian * 3) {
        candidates.push({
          type: "cost-outlier",
          skill,
          version_from: null,
          version_to: null,
          delta_pct: ((d - skillMedian) / skillMedian) * 100,
          dollars: d,
          sessions_sampled: dollars.length,
        });
      }
    }
  }

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
    });

  // C2: the rule exists at references/delegation.md:59; this makes the gap measurable.
  const dispatches = record.dispatches ?? [];
  const inherited = dispatches.filter((d) => d.modelSource === "inherited").length;
  if (inherited > 0)
    out.push({ type: "inherited-model", inherited, total: dispatches.length });

  // C3: Explore's startup floor is 13955 against a 32711 median, ~2.3x per dispatch.
  const gp = dispatches.filter((d) => d.agentType === "general-purpose").length;
  if (gp > 0) out.push({ type: "general-purpose-search", count: gp, total: dispatches.length });

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
      let runId = null, pluginVersion = null, profile = null, knobs = null, schemaMismatch;
      let current = null;
      const windows = new Map(); // sessionHash -> { stages, dispatches, verdicts, events }, file order
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
            windows.set(current, { stages: [], dispatches: [], verdicts: [], events: [] });
        } else if (o.kind === "stage") { if (current) windows.get(current).stages.push(o); }
        else if (o.kind === "dispatch") { if (current) windows.get(current).dispatches.push(o); }
        else if (o.kind === "verdict") { if (current) windows.get(current).verdicts.push(o); }
        else if (o.kind === "event") { if (current) windows.get(current).events.push(o); }
      }
      for (const [h, w] of windows) {
        const rec = { runId, pluginVersion, profile, knobs, schemaMismatch, ...w };
        const prior = bySession.get(h);
        bySession.set(h, prior
          ? { ...rec,
              stages: [...prior.stages, ...rec.stages],
              dispatches: [...prior.dispatches, ...rec.dispatches],
              verdicts: [...prior.verdicts, ...rec.verdicts],
              events: [...prior.events, ...rec.events] }
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
  if (isLowConfidence(c)) parts.push("low confidence: n=1");
  return `CANDIDATE: ${parts.join(" ")}`;
}

// Every session's own emitComplianceCandidates() output, gathered corpus-wide — same one-entry-
// per-source-session convention emitCandidates already uses for unpriced-model, above. QC5: a
// null onDevicePath (always null until Task 11 lands in cycle 3) is labelled "unrecorded" here
// so both render sites below show a labelled value, never a bare null.
function complianceCandidatesOf(summaries) {
  return summaries.flatMap((s) => s.complianceCandidates ?? []).map((c) =>
    c.type === "main-thread-browser" ? { ...c, onDevicePath: c.onDevicePath ?? "unrecorded" } : c
  );
}

// Distinct from formatCandidate: these three carry their own fields (calls/inherited/count,
// no sessions_sampled or dollars), so reusing formatCandidate's field set would print a
// meaningless "sessions=undefined" line rather than nothing.
function formatComplianceCandidate(c) {
  if (c.type === "main-thread-browser")
    return `CANDIDATE: main-thread-browser calls=${c.calls} onDevicePath=${c.onDevicePath} — ${c.note}`;
  if (c.type === "inherited-model")
    return `CANDIDATE: inherited-model inherited=${c.inherited}/${c.total}`;
  return `CANDIDATE: general-purpose-search count=${c.count}/${c.total}`;
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
    bandCounts: Object.fromEntries(BAND_LABELS.map((l) => [l, 0])),
    startupFloor: {},
    carryWeighted: {},
    dispatches: { total: 0, withoutModel: 0 },
    unpriced: {},
  };
  for (const s of summaries) {
    agg.costUSD += s.costUSD;
    for (const key of ["costByModel", "costByStage", "costByAgentType", "carryWeighted", "unpriced"])
      for (const [k, v] of Object.entries(s[key] ?? {})) bump(agg[key], k, v);
    for (const [k, v] of Object.entries(s.bandCounts ?? {})) bump(agg.bandCounts, k, v);
    for (const [k, v] of Object.entries(s.startupFloor ?? {})) (agg.startupFloor[k] ??= []).push(...v);
    agg.dispatches.total += s.dispatches?.total ?? 0;
    agg.dispatches.withoutModel += s.dispatches?.withoutModel ?? 0;
  }
  agg.cacheBand = aggregateCacheBand(summaries);
  return agg;
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
  const band = agg.cacheBand;
  if (band.collapsed)
    lines.push("Cost is exact: every cache write in this corpus carries its TTL split.");
  else
    lines.push(
      `Cost $${band.point.toFixed(2)} (inferred: cache-write TTL, range ` +
        `$${band.low.toFixed(2)}–$${band.high.toFixed(2)}; ` +
        `${(band.fallbackShare * 100).toFixed(1)}% of cache-write tokens lack a TTL split).`,
    );
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
  const direction = corpusDirectionOfTravel(summaries.filter((s) => !s.inFlight));
  lines.push(
    direction.direction === "insufficient-data"
      ? "direction of travel: insufficient data (need at least two known versions)"
      : `direction of travel: ${direction.direction} (${direction.deltaPct.toFixed(1)}% median cost, oldest to newest known version)`
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
export function buildJsonReport(summaries) {
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
    direction_of_travel: corpusDirectionOfTravel(summaries.filter((s) => !s.inFlight)),
    inFlight: {
      excluded: summaries.filter((s) => s.inFlight).length,
      thresholdMs: IN_FLIGHT_MS,
      note: IN_FLIGHT_NOTE,
    },
    cost_band: aggregateCacheBand(summaries),
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
  const args = parseArgs(process.argv.slice(2));
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
  if (args.json) {
    console.log(
      JSON.stringify(
        { window: result.window, totals: result.totals, ...buildJsonReport(result.sessions) },
        null,
        2,
      ),
    );
  } else {
    console.log(formatReport(result.sessions));
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
    return {
      version: g.version,
      profile: g.profile,
      sessions: g.members.length,
      cycles: cycles.length,
      medianCostPerCycle: median(cycles.map((c) => c.cost)),
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
function impactRows(summaries, vocab = []) {
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
        agg.cohorts.set(cohortKey, { version, profile, sessions: 0, total: 0, measurable: true });
      const cohort = agg.cohorts.get(cohortKey);
      cohort.sessions += 1;
      if (scored.impact === null) cohort.measurable = false;
      else cohort.total += scored.impact;
    }
  }
  return [...byKey.values()].map((agg) => {
    const slug = agreedSlug(agg.slugLists);
    const entry = slug ? vocab.find((v) => v.slug === slug) : null;
    const cohorts = orderVersionProfileRows([...agg.cohorts.values()].map((c) => ({
      version: c.version, profile: c.profile,
      impact: c.measurable ? c.total : null,
      lowConfidence: c.sessions < MIN_COHORT,
    })));
    const byVersion = new Map();
    for (const c of cohorts.filter((c) => c.version !== "unknown")) {
      const running = byVersion.get(c.version);
      byVersion.set(c.version, running === undefined ? c.impact
        : running === null || c.impact === null ? null : running + c.impact);
    }
    return {
      key: agg.key,
      name: slug ?? agg.key,
      // A key with no vocabulary entry is still reported, labelled as unclassified rather than
      // filed under a kind nobody assigned it.
      kind: entry?.kind ?? "unclassified",
      isWin: WIN_EVENTS.has(agg.event) || entry?.kind === "win",
      impact: agg.measurable ? agg.impact : null,
      occurrences: agg.occurrences,
      delta: cohorts.length
        ? deltaAgainstPrevious(cohorts, cohorts.length - 1, (r) => r.impact)
        : { state: "first-seen", pct: null },
      trend: trendAcross([...byVersion.keys()].sort(compareVersions).map((v) => byVersion.get(v))),
    };
  });
}

// The friction this corpus is paying for, priciest first: what it cost, how often it happened,
// and whether it is getting better.
export function culpritTable(summaries, vocab) {
  return impactRows(summaries, vocab)
    .filter((r) => !r.isWin)
    .map(({ name, kind, impact, occurrences, delta, trend }) =>
      ({ culprit: name, kind, impact, occurrences, delta, trend }))
    .sort(byImpactDesc);
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

// The marker playbooks/profiling-sessions.md writes when the Actionability step drafts an
// issue. That playbook is the contract's one written source; this parses what it states.
const DRAFTED_MARKER_RE = /^Drafted: \[culprit:([a-z0-9][a-z0-9-]*)\] (.+)$/gm;

export function parseDraftedMarkers(text) {
  const out = [];
  for (const m of String(text).matchAll(DRAFTED_MARKER_RE))
    out.push({ slug: m[1], title: m[2].trim() });
  return out;
}

// Release dates come from the plugin's own CHANGELOG.md headings, back-filled 2026-08-13. A
// heading with no date is omitted rather than defaulted: turnaround measured against a made-up
// release date is a number that reads as fact and is not one.
export function releaseDates(changelogText) {
  const dates = new Map();
  for (const m of String(changelogText).matchAll(/^## (\d+\.\d+\.\d+) — (\d{4}-\d{2}-\d{2})[ \t]*$/gm))
    dates.set(m[1], m[2]);
  return dates;
}

// gh's stdout, or a thrown error. Short timeout: a hanging gh must not hang a report, and the
// caller degrades to "unavailable" on any throw.
const defaultGhRunner = (args) =>
  execFileSync("gh", args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });

export function outerLoop(reportsDir, ghRunner = defaultGhRunner) {
  // Drafted is local: it comes from this repo's own persisted reports, so it renders even when
  // gh is unavailable. Reports written before this phase carry no markers, which is why the
  // renderer qualifies the count rather than presenting it as "none drafted".
  let drafted = 0;
  try {
    for (const f of readdirSync(reportsDir).filter((n) => n.endsWith(".md")))
      drafted += parseDraftedMarkers(readFileSync(join(reportsDir, f), "utf8")).length;
  } catch (err) {
    if (err.code !== "ENOENT" && err.code !== "ENOTDIR") throw err;
  }

  const unavailable = {
    drafted, draftedSince: DRAFTED_SINCE,
    filed: "unavailable", resolved: "unavailable", medianTurnaroundDays: "unavailable",
  };

  let issues;
  try {
    issues = JSON.parse(ghRunner([
      "issue", "list", "--repo", DEVCYCLE_UPSTREAM, "--author", "@me",
      "--label", "from-doctor", "--state", "all", "--limit", "200",
      "--json", "number,title,labels,createdAt,closedAt,state",
    ]));
    if (!Array.isArray(issues)) return unavailable;
  } catch {
    // Missing gh, an unauthenticated gh, a timeout, or output that is not JSON. All four mean
    // "not measured" — rendering 0 would read as "nothing has ever been filed".
    return unavailable;
  }

  let vocab = [];
  try {
    vocab = JSON.parse(readFileSync(join(PLUGIN_ROOT, "references", "culprits.json"), "utf8"));
  } catch { vocab = []; }
  const resolvedIn = new Map(
    vocab.filter((e) => e && e["resolved-in"]).map((e) => [e.slug, e["resolved-in"]]),
  );
  let dates = new Map();
  try { dates = releaseDates(readFileSync(RELEASE_CHANGELOG_PATH, "utf8")); } catch { dates = new Map(); }

  const slugOf = (issue) =>
    (issue.labels ?? []).map((l) => l.name ?? "").find((n) => n.startsWith("culprit:"))?.slice("culprit:".length) ?? null;

  const turnarounds = [];
  let resolved = 0;
  for (const issue of issues) {
    const version = resolvedIn.get(slugOf(issue));
    if (!version) continue; // no resolved-in: excluded, never counted as an infinite turnaround
    resolved += 1;
    const released = dates.get(version);
    if (!released) continue;
    const days = (Date.parse(`${released}T00:00:00Z`) - Date.parse(issue.createdAt)) / 86400000;
    if (Number.isFinite(days)) turnarounds.push(days);
  }

  return {
    drafted, draftedSince: DRAFTED_SINCE,
    filed: issues.length,
    resolved,
    medianTurnaroundDays: turnarounds.length ? Math.round(median(turnarounds)) : null,
  };
}

// Compiled knowledge needs a `rung:` field on promotion records, which Phase 3 adds — the only
// `rung` in this repo today is scripts/model-pool.mjs's unrelated model-pool rung. Rather than
// invent a mapping, the section renders its heading, its gloss, its column header and this
// line. The directory is still opened rather than skipped: a promotions directory that exists
// but cannot be read fails here instead of rendering the same no-data line as a repo that has
// simply never promoted anything (QC5 — absent degrades, a permissions fault throws). The
// records themselves are deliberately not read here: readPromotions (scripts/dream.mjs) is
// the one promotion parser, and Phase 3 reads `rung:` through it rather than beside it.
export function compiledKnowledge(promotionsDir) {
  try {
    readdirSync(promotionsDir);
  } catch (err) {
    if (err.code !== "ENOENT" && err.code !== "ENOTDIR") throw err;
  }
  return {
    rows: [],
    note: "No data yet — this table fills in from the release that records `rung:` on promotion records.",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
