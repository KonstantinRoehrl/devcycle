#!/usr/bin/env node
// Re-measures devcycle's token cost from session transcripts: turn counts, main-thread
// vs subagent split, context depth, tool mix, and dollar cost by model, stage, and agent.
// Read-only. Emits counts, dollars, model ids, tool names, and skill names only.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { PRICING, priceFor } from "./pricing.mjs";

const DEVCYCLE_PREFIX = /^devcycle:/;

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
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") args.dir = argv[++i];
    else if (a === "--since") args.since = argv[++i];
    else if (a === "--until") args.until = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "--all") args.all = true;
    else if (a === "--depth") args.depth = true;
  }
  return args;
}

export function isDevcycleSession(records) {
  for (const r of records) {
    if (DEVCYCLE_PREFIX.test(r.attributionSkill ?? "")) return true;
    const content = r.message?.content;
    if (!Array.isArray(content)) continue;
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
      ? h1 * p.in * 2.0 + m5 * p.in * 1.25
      : (usage.cache_creation_input_tokens ?? 0) * p.in * 1.25;
  const perMillion =
    (usage.input_tokens ?? 0) * p.in +
    write +
    (usage.cache_read_input_tokens ?? 0) * p.in * 0.1 +
    (usage.output_tokens ?? 0) * p.out;
  return perMillion / 1e6;
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

export function median(numbers) {
  if (!numbers.length) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
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

export function summarizeSession(sessionId, records) {
  const turns = records.filter(isTurn);
  const depths = turns.map((r) => contextDepth(r.message.usage));
  const tools = {};
  const models = {};
  const costByModel = {};
  const costByStage = {};
  const costByAgentType = {};
  const unpriced = {};
  const bandCounts = Object.fromEntries(BAND_LABELS.map((l) => [l, 0]));
  const startupFloor = {};
  const carryWeighted = {};
  const dispatches = { total: 0, withoutModel: 0 };
  let totalCost = 0;

  for (const r of turns) {
    const model = r.message.model;
    if (model) models[model] = (models[model] ?? 0) + 1;
    const dollars = costUSD(r.message.usage, model);
    if (dollars === null) {
      bump(unpriced, model ?? "(none)", 1);
    } else {
      totalCost += dollars;
      bump(costByModel, model, dollars);
      bump(costByStage, r.attributionSkill ?? "unattributed", dollars);
      bump(costByAgentType, agentTypeOf(r), dollars);
    }
    bandCounts[depthBand(contextDepth(r.message.usage))] += 1;
    const content = r.message.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (!item || item.type !== "tool_use" || typeof item.name !== "string") continue;
      tools[item.name] = (tools[item.name] ?? 0) + 1;
      if (DISPATCH_TOOLS.has(item.name)) {
        dispatches.total += 1;
        if (!item.input?.model) dispatches.withoutModel += 1;
      }
    }
  }

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
    models,
  };
}

const DISCLOSURE =
  "note: skill attribution is sticky — sessions whose devcycle work continued after " +
  "the last skill invocation are under-counted.";

const usd = (n) => "$" + (n >= 1 ? n.toFixed(2) : n.toFixed(4));

// Largest first, so each section leads with what actually costs money.
function ranked(map, render) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${render(v)}`)
    .join(", ");
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
  lines.push("", vintage, DISCLOSURE, "");
  for (const s of summaries) {
    const modelList = Object.keys(s.models).join(", ") || "none";
    const toolList = Object.entries(s.tools).map(([k, v]) => `${k}:${v}`).join(", ") || "none";
    lines.push(
      `session ${s.id} — turns ${s.turns} (main ${s.mainTurns}, subagent ${s.subagentTurns}), ` +
        `depth median ${s.medianDepth} max ${s.maxDepth}, cost ${usd(s.costUSD)}, ` +
        `models [${modelList}], tools [${toolList}]`,
    );
  }
  return lines.join("\n");
}

// Recursively collects .jsonl transcript files under dir. Returns null when dir
// cannot be read at all (missing or not a directory).
function findTranscriptFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
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
function owningSession(file) {
  const parts = file.split(sep);
  const i = parts.lastIndexOf("subagents");
  return i > 0 ? parts[i - 1] : basename(file, ".jsonl");
}

// Malformed JSON lines are skipped, not fatal — transcripts are appended live
// and the last line may be partial.
function readRecords(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
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

function inWindow(timestamp, since, until) {
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

  const sessions = [];
  for (const [key, records] of groups) {
    // Membership is a session-level property, so it is decided over every record;
    // the window then narrows only what gets measured.
    if (!args.all && !isDevcycleSession(records)) continue;
    const windowed = records.filter((r) => inWindow(r.timestamp, args.since, args.until));
    if (windowed.length === 0) continue;
    const sessionId = records.find((r) => r.sessionId)?.sessionId ?? key;
    sessions.push(summarizeSession(sessionId, windowed));
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

  return { ok: true, window: { since: args.since, until: args.until }, sessions, totals };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = run(args);
  if (!result.ok) {
    console.error("SESSION METRICS FAILED:\n" + result.reasons.map((r) => ` - ${r}`).join("\n"));
    process.exit(1);
  }
  if (args.json) {
    console.log(
      JSON.stringify(
        { window: result.window, pricesAsOf: PRICING.asOf, sessions: result.sessions, totals: result.totals },
        null,
        2,
      ),
    );
  } else {
    console.log(formatReport(result.sessions));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
