#!/usr/bin/env node
// Resolves a *Model knob to a concrete dispatch model, under the orchestrator-tier ceiling.
// references/config.md states the policy for the coordinator that reads it and names this file
// as the policy's single implementation; this file owns the arithmetic and nothing else.
//
// `model: null` means "dispatch with no model override" — the session tier, which inherits the
// orchestrator's own model and therefore cannot exceed it. Every unresolvable case converges on
// that one form, because it is the only dispatch that cannot break the ceiling invariant.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
