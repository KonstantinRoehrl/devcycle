#!/usr/bin/env node
// Resolves a *Model knob to a concrete dispatch model, under the orchestrator-tier ceiling.
// references/config.md states the policy for the coordinator that reads it and names this file
// as the policy's single implementation; this file owns the arithmetic and nothing else.
//
// `model: null` means "dispatch with no model override" — the session tier, which inherits the
// orchestrator's own model and therefore cannot exceed it. Every unresolvable case converges on
// that one form, because it is the only dispatch that cannot break the ceiling invariant.
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseFlags, requireValue } from "./cli-flags.mjs";

const DEFAULT_TABLE = fileURLToPath(new URL("../references/model-tiers.json", import.meta.url));

export function loadTable(path = DEFAULT_TABLE) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// A knob is unset when it still renders as a literal ${user_config...} placeholder or reads
// `auto` — the two forms references/config.md already treats identically.
export function parsePool(value) {
  const raw = (value ?? "").trim();
  if (!raw || raw === "auto" || raw.startsWith("${user_config")) return { kind: "unset", entries: [] };
  const entries = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (entries.length === 0) return { kind: "unset", entries: [] };
  return { kind: entries.length === 1 ? "pin" : "pool", entries };
}

// Rung = 1 + signals fired, clamped into the pool. Zero signals is the simplest rung, which is
// what keeps an unset knob's behaviour identical to today's fast-tier default. A caller with no
// complexity predicate at all — walkthroughModel, branchReviewModel, both judging roles — passes
// Infinity to saturate at the top rung rather than inventing a count, so the comparison below is
// deliberately `> 0` rather than a finiteness test; NaN and undefined fail it and land on rung 1.
export function rungFor(signalCount, len) {
  const fired = signalCount > 0 ? Math.floor(signalCount) : 0;
  return Math.min(1 + fired, len);
}

// Rank by family, never by version inside a family: a newer Sonnet does not outrank an older Opus.
export function rank(id, table) {
  for (const entry of table) if (new RegExp(entry.match, "i").test(id)) return entry.rank;
  return null;
}

export function resolveModel({ value, signalCount = 0, orchestratorId, table }) {
  const parsed = parsePool(value);
  if (parsed.kind === "unset") return { model: null, outcome: "model session (auto)" };

  const ceiling = rank(orchestratorId, table);
  if (ceiling === null)
    return { model: null, outcome: `model session (ceiling: ${orchestratorId} unranked)` };

  if (parsed.kind === "pin") {
    const [pinned] = parsed.entries;
    const pinnedRank = rank(pinned, table);
    if (pinnedRank === null)
      return { model: null, outcome: `model session (ceiling: ${pinned} unranked)` };
    if (pinnedRank <= ceiling) return { model: pinned, outcome: `model ${pinned} (pinned)` };
    // Clamp a pin exactly as a pool entry is clamped: the ceiling applies to every path.
    const below = parsed.entries.filter((id) => (rank(id, table) ?? Infinity) <= ceiling);
    const fallback = below.at(-1) ?? orchestratorId;
    return { model: fallback, outcome: `model ${fallback} (pinned, clamped from ${pinned})` };
  }

  const len = parsed.entries.length;
  const rungIndex = rungFor(signalCount, len);
  const requested = parsed.entries[rungIndex - 1];
  const requestedRank = rank(requested, table);
  if (requestedRank === null)
    return { model: null, outcome: `model session (ceiling: ${requested} unranked)` };
  if (requestedRank <= ceiling)
    return { model: requested, outcome: `model ${requested} (pooled: rung ${rungIndex}/${len})` };

  // The highest entry that still sits under the ceiling. If the pool has none — the orchestrator
  // is weaker than even the simplest rung — no override is the only answer that honours both the
  // ceiling and D11's refusal to error out on a misconfigured pool.
  const admissible = parsed.entries.filter((id) => (rank(id, table) ?? Infinity) <= ceiling);
  if (!admissible.length)
    return { model: null, outcome: `model session (ceiling: no rung at or below ${orchestratorId})` };
  const clamped = admissible.at(-1);
  return {
    model: clamped,
    outcome: `model ${clamped} (pooled: rung ${rungIndex}/${len}, clamped from ${requested})`,
  };
}

// Every flag this CLI reads. Anything else is an operator error, not a no-op: an unrecognised
// flag that parsed silently -- `--signal` for `--signals` -- resolved a different model than
// the caller asked for.
const KNOWN_FLAGS = {
  "--value": "value", "--orchestrator": "value", "--signals": "value", "--table": "value",
};

// CLI only, so the pure helpers above stay importable by tests — the guard scripts/bump-version.mjs
// already uses. references/config.md § Model tiers owns when a caller runs this: only for a knob
// that resolves to a pin or a pool, since parsePool reads `auto` and an unsubstituted placeholder
// as unset and there is nothing for this module to decide.
function cliResolve(argv) {
  // This CLI takes no positional arguments, so a bare token is a dropped flag name -- `--signals 5`
  // typed as `5` -- and discarding it resolves rung 1 for a caller who asked for rung 6. Same
  // silently-different-model outcome as an unrecognised flag, and cli-flags.mjs refuses it the same
  // way for every consumer, so there is no check to repeat here.
  const { flags } = parseFlags(argv, KNOWN_FLAGS);
  const value = requireValue(flags, "--value", "a model id or pool");
  if (value === undefined) throw new Error("--value is required");
  const orchestratorId = requireValue(flags, "--orchestrator", "a model id");
  if (orchestratorId === undefined) throw new Error("--orchestrator is required");
  const rawSignals = requireValue(flags, "--signals", "a number");
  const signalCount = rawSignals === undefined ? 0 : Number(rawSignals);
  if (Number.isNaN(signalCount))
    throw new Error(`--signals must be a number or Infinity, got ${rawSignals}`);
  const tablePath = requireValue(flags, "--table");
  const table = tablePath === undefined ? loadTable() : loadTable(tablePath);
  return resolveModel({ value, signalCount, orchestratorId, table });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(cliResolve(process.argv.slice(2))));
  } catch (e) {
    console.error(`model-pool: ${e.message}`);
    process.exit(1);
  }
}
