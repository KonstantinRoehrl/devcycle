#!/usr/bin/env node
// Re-measures devcycle's token cost from session transcripts: turn counts, main-thread
// vs subagent split, context depth, tool mix, and normalized cost units.
// Read-only. Emits counts, model ids, tool names, and skill names only.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

const DEVCYCLE_PREFIX = /^devcycle:/;
const OPUS_MODEL = /^claude-opus/;

export function parseArgs(argv) {
  const args = { dir: join(homedir(), ".claude", "projects"), since: null, until: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") args.dir = argv[++i];
    else if (a === "--since") args.since = argv[++i];
    else if (a === "--until") args.until = argv[++i];
    else if (a === "--json") args.json = true;
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

export function costUnits(usage, model) {
  const raw =
    (usage.input_tokens ?? 0) +
    1.25 * (usage.cache_creation_input_tokens ?? 0) +
    0.1 * (usage.cache_read_input_tokens ?? 0) +
    5 * (usage.output_tokens ?? 0);
  return raw * (OPUS_MODEL.test(model ?? "") ? 1 : 0.2);
}

export function median(numbers) {
  if (!numbers.length) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Only assistant-side records carrying a message.usage count as turns.
function isTurn(r) {
  return r.type === "assistant" && r.message && r.message.usage;
}

export function summarizeSession(sessionId, records) {
  const turns = records.filter(isTurn);
  const depths = turns.map((r) => contextDepth(r.message.usage));
  const tools = {};
  const models = {};
  let totalCost = 0;
  for (const r of turns) {
    if (r.message.model) models[r.message.model] = (models[r.message.model] ?? 0) + 1;
    totalCost += costUnits(r.message.usage, r.message.model);
    const content = r.message.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (item && item.type === "tool_use" && typeof item.name === "string")
        tools[item.name] = (tools[item.name] ?? 0) + 1;
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
    costUnits: Math.round(totalCost * 100) / 100,
    models,
  };
}

const DISCLOSURE =
  "note: skill attribution is sticky — sessions whose devcycle work continued after " +
  "the last skill invocation are under-counted.";

export function formatReport(summaries) {
  if (!summaries.length) return "no sessions matched.\n";
  const lines = summaries.map((s) => {
    const modelList = Object.keys(s.models).join(", ") || "none";
    const toolList = Object.entries(s.tools).map(([k, v]) => `${k}:${v}`).join(", ") || "none";
    return (
      `session ${s.id} — turns ${s.turns} (main ${s.mainTurns}, subagent ${s.subagentTurns}), ` +
      `depth median ${s.medianDepth} max ${s.maxDepth}, cost ${s.costUnits}, ` +
      `models [${modelList}], tools [${toolList}]`
    );
  });
  lines.push("", DISCLOSURE);
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

  const sessions = [];
  for (const file of files) {
    const records = readRecords(file);
    // Membership is a session-level property, so it is decided over every record;
    // the window then narrows only what gets measured.
    if (!isDevcycleSession(records)) continue;
    const windowed = records.filter((r) => inWindow(r.timestamp, args.since, args.until));
    if (windowed.length === 0) continue;
    const sessionId = records.find((r) => r.sessionId)?.sessionId ?? basename(file, ".jsonl");
    sessions.push(summarizeSession(sessionId, windowed));
  }

  const totals = { turns: 0, mainTurns: 0, subagentTurns: 0, costUnits: 0, tools: {}, models: {} };
  for (const s of sessions) {
    totals.turns += s.turns;
    totals.mainTurns += s.mainTurns;
    totals.subagentTurns += s.subagentTurns;
    totals.costUnits += s.costUnits;
    mergeCounts(totals.tools, s.tools);
    mergeCounts(totals.models, s.models);
  }
  totals.costUnits = Math.round(totals.costUnits * 100) / 100;

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
    console.log(JSON.stringify({ window: result.window, sessions: result.sessions, totals: result.totals }, null, 2));
  } else {
    console.log(formatReport(result.sessions));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
