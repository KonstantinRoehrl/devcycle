#!/usr/bin/env node
// The context-depth probe: one transcript's last usage record measured against the observed model's
// window. The depth gate calls this file directly so it no longer loads doctor's import closure;
// `doctor.mjs --depth` stays as an adapter over the same functions.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseFlags, requireValue } from "./cli-flags.mjs";
import { eachRecord } from "./jsonl.mjs";
import { isMain } from "./is-main.mjs";
import { ASSUMED_WINDOW, budgetBand, contextDepth, windowFor } from "./depth-bands.mjs";

export { ASSUMED_WINDOW, budgetBand, contextDepth, windowFor };

// Records Claude Code writes for its own placeholders (session-limit notices and the like).
// Every counter on them is zero, so they are skipped outright rather than reported unpriced.
export const SYNTHETIC_MODEL = "<synthetic>";

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
    throw new Error(`no context window known for ${model} (not priced, and older than its ` +
      `family's newest priced model; add it to scripts/pricing.mjs) — ${depth} tokens, band unknown`);
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
