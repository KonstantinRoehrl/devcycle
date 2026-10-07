#!/usr/bin/env node
// The context-depth probe: one transcript's last usage record measured against the observed model's
// window. The depth gate calls this file directly so it no longer loads doctor's import closure;
// `doctor.mjs --depth` stays as an adapter over the same functions.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseFlags, requireValue } from "./cli-flags.mjs";
import { PRICING, priceFor, provisionalPriceFor } from "./pricing.mjs";
import { eachRecord } from "./jsonl.mjs";
import { isMain } from "./is-main.mjs";

// Records Claude Code writes for its own placeholders (session-limit notices and the like).
// Every counter on them is zero, so they are skipped outright rather than reported unpriced.
export const SYNTHETIC_MODEL = "<synthetic>";
// An unpriced model with no priced family is most likely a newer one, and every current Claude 5
// model runs a 1M window; the label, not the number, is what tells the reader to fix pricing.mjs.
export const ASSUMED_WINDOW = 1_000_000;

export function contextDepth(usage) {
  return (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
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

// Recursively collects .jsonl transcript files under dir. Returns null when dir is simply
// not there (missing, or a path that is not a directory).
export function findTranscriptFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // An absent path is "nothing here", but a permissions or I/O failure is a real fault and
    // must not read as a directory holding no transcripts.
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

// The families pricing.mjs prices, read off its ids (`claude-<family>-...`). Matched against any
// segment of a model id, so the older `claude-3-5-sonnet-...` naming still finds its family.
const PRICED_FAMILIES = new Set(Object.keys(PRICING.models).map((id) => id.split("-")[1]));

// Null when no window is knowable: an older member of a priced family (Sonnet 4.5, Opus 4.1) ran a
// smaller window than its newest sibling and pricing.mjs records none for it, so the assumed 1M
// would read its depth several times too shallow.
export function windowFor(model) {
  const exact = priceFor(model);
  if (exact) return { window: exact.window };
  const provisional = provisionalPriceFor(model);
  if (provisional) return { window: provisional.price.window, windowProvisionalAs: provisional.basedOn };
  if (typeof model === "string" && model.split("-").some((segment) => PRICED_FAMILIES.has(segment))) return null;
  return { window: ASSUMED_WINDOW, windowAssumed: true };
}

const lastUsageOf = (r) => (r.message?.usage && r.message.model && r.message.model !== SYNTHETIC_MODEL ? r.message : null);

export function transcriptStats(file) {
  let last = null;
  let toolUses = 0;
  let first = null;
  let end = null;
  eachRecord(file, (r) => {
    const t = Date.parse(r.timestamp ?? "");
    if (Number.isFinite(t)) {
      first ??= t;
      end = t;
    }
    for (const c of Array.isArray(r.message?.content) ? r.message.content : []) if (c?.type === "tool_use") toolUses += 1;
    last = lastUsageOf(r) ?? last;
  });
  if (!last) return null;
  return {
    depth: contextDepth(last.usage), model: last.model, toolUses,
    durationMs: first !== null && end !== null ? end - first : 0,
  };
}

// CLAUDE_DOCTOR_PROJECTS overrides the transcript root; it exists so the probe is testable
// without writing into the real ~/.claude. It defaults to ~/.claude/projects.
export function resolveTranscript(env, cwd, { agentId } = {}) {
  const id = env.CLAUDE_CODE_SESSION_ID;
  if (!id) throw new Error("CLAUDE_CODE_SESSION_ID is not set — cannot identify this session");
  const root = env.CLAUDE_DOCTOR_PROJECTS || join(homedir(), ".claude", "projects");
  const name = agentId ? `agent-${agentId}.jsonl` : `${id}.jsonl`;

  // 1. cwd slug, 2. a filename search for a session whose cwd moved after it started.
  const slugDir = join(root, cwd.replaceAll("/", "-"));
  const direct = agentId ? join(slugDir, id, "subagents", name) : join(slugDir, name);
  const file = existsSync(direct) ? direct : (findTranscriptFiles(root) ?? []).find((f) => basename(f) === name);
  if (!file) throw new Error(`no transcript found for ${agentId ? `agent ${agentId} of ` : ""}session ${id} under ${root}`);
  return file;
}

const measured = (depth, model) => {
  const w = windowFor(model);
  // An unknown depth is never evidence of a shallow one: fail the probe rather than band it.
  if (!w) {
    throw new Error(`no context window known for ${model} (older than every priced model of its family; ` +
      `add it to scripts/pricing.mjs) — ${depth} tokens, band unknown`);
  }
  return { depth, model, ...w, fraction: depth / w.window, band: budgetBand(depth, w.window) };
};

export function resolveDepth(env, cwd, { agentId } = {}) {
  const file = resolveTranscript(env, cwd, { agentId });
  let last = null;
  // The "usage" substring is a cheap pre-filter: most transcript lines are not assistant turns with a
  // usage block, and a rejected line costs no parse. eachRecord streams the file in chunks, so no
  // whole-file string is held however long the session is. A torn trailing line (transcripts are
  // appended live) fails to parse and is skipped by the reader.
  eachRecord(file, (r) => { last = lastUsageOf(r) ?? last; }, { lineFilter: (line) => line.includes('"usage"') });
  if (!last) throw new Error(`no usage record in ${basename(file)} — nothing to measure`);
  return measured(contextDepth(last.usage), last.model);
}

export function depthLine(r) {
  const pct = (r.fraction * 100).toFixed(1);
  const assumed = r.windowProvisionalAs
    ? `, window assumed from ${r.windowProvisionalAs}`
    : r.windowAssumed ? ", window assumed — model not in scripts/pricing.mjs" : "";
  return `depth: ${r.depth} tokens (${pct}% of ${r.window}, model ${r.model}${assumed}) — band: ${r.band}`;
}

function main(argv) {
  let r;
  let json = false;
  try {
    const { flags } = parseFlags(argv, { "--agent": "value", "--transcript": "value", "--json": "none" });
    json = "--json" in flags;
    const file = requireValue(flags, "--transcript");
    const agentId = requireValue(flags, "--agent", "an agent id");
    if (file) {
      // transcriptStats reads a missing file as an empty one, which would misreport a typo'd path.
      if (!existsSync(file)) throw new Error(`transcript not found: ${file}`);
      const s = transcriptStats(file);
      if (!s) throw new Error(`no usage record in ${basename(file)} — nothing to measure`);
      r = measured(s.depth, s.model);
    } else {
      r = resolveDepth(process.env, process.cwd(), { agentId });
    }
  } catch (e) {
    console.error(`depth-probe: ${e.message}`);
    process.exit(1);
  }
  console.log(json ? JSON.stringify(r) : depthLine(r));
}

if (isMain(import.meta.url, process.argv[1])) main(process.argv.slice(2));
