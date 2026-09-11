// The single reader of references/reinforcement-policy.md's machine block. Every threshold the
// learn loop reinforces on lives in that file; this module parses it, enforces its invariants,
// and is the only place the rest of the plugin gets those numbers from.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const POLICY_BLOCK_RE =
  /<!--\s*reinforcement-policy:begin\s*-->\s*```json\s*([\s\S]*?)\s*```\s*<!--\s*reinforcement-policy:end\s*-->/;

const DEFAULT_POLICY_PATH = join(
  dirname(fileURLToPath(import.meta.url)), "..", "references", "reinforcement-policy.md",
);

export function parsePolicy(text) {
  const m = POLICY_BLOCK_RE.exec(text);
  if (!m) throw new Error("reinforcement-policy: machine block not found between markers");
  let policy;
  try { policy = JSON.parse(m[1]); }
  catch (e) { throw new Error(`reinforcement-policy: block is not valid JSON — ${e.message}`); }

  const table = policy.severityPercentileByProfile;
  if (!table || typeof table !== "object")
    throw new Error("reinforcement-policy: severityPercentileByProfile missing");
  for (const profile of ["lean", "standard", "thorough"]) {
    const p = table[profile];
    if (!Number.isFinite(p) || p <= 0 || p >= 100)
      throw new Error(`reinforcement-policy: severityPercentileByProfile.${profile} must be in (0,100), got ${JSON.stringify(p)}`);
  }
  for (const key of ["culpritRecurrenceBar", "winRecurrenceBar", "graduationRuns", "minPricedKeysForPercentile"]) {
    if (!Number.isInteger(policy[key]) || policy[key] < 1)
      throw new Error(`reinforcement-policy: ${key} must be an integer >= 1, got ${JSON.stringify(policy[key])}`);
  }
  if (!(policy.winRecurrenceBar > policy.culpritRecurrenceBar))
    throw new Error(`reinforcement-policy: winRecurrenceBar (${policy.winRecurrenceBar}) must be strictly greater than culpritRecurrenceBar (${policy.culpritRecurrenceBar})`);
  return policy;
}

export function readPolicy(path = DEFAULT_POLICY_PATH) {
  return parsePolicy(readFileSync(path, "utf8"));
}

export function severityPercentile(policy, profile) {
  const table = policy.severityPercentileByProfile;
  return table[profile] ?? table.standard;
}

export function derivedSeverityThreshold(costValues, percentile, minKeys) {
  const vals = (costValues ?? []).filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  const N = vals.length;
  if (N < minKeys) return null;
  const idx = Math.min(Math.max(Math.floor((percentile / 100) * N), 0), N - 1);
  return vals[idx];
}
