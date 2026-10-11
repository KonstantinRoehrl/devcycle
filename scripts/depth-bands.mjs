// The context-depth arithmetic, with no Node import, so the hooks module (hooks/devcycle-mod.mjs) — which runs without Node — measures a subagent with the same functions depth-probe.mjs and doctor.mjs use. It imports only pricing.mjs.
import { PRICING, parseModelId, priceFor, provisionalPriceFor } from "./pricing.mjs";

// An unpriced model with no priced family is most likely a newer one, and every current Claude 5
// model runs a 1M window; the label, not the number, is what tells the reader to fix pricing.mjs.
export const ASSUMED_WINDOW = 1_000_000;

// A step the engine reports with no usage block has no depth to measure — never zero.
export function contextDepth(usage) {
  if (!usage) return null;
  return (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
}

// Fractions of the running model's context window. The underlying measurement is absolute —
// cost per 1k output tokens bottoms at 15.1k in the 100-150k band and climbs to 40.7k past
// 300k — taken on 1M-window sessions, so these fractions are those absolutes divided by 1M.
// Expressing them as fractions is a deliberate approximation that lets them adapt to smaller
// windows; cache-read cost actually scales with absolute tokens, not with the fraction used.
// Doctor's own per-model band data is what should confirm or correct them once smaller-window
// sessions have been measured.
export const OVER_BUDGET = 0.15;
export const HARD_STOP = 0.2;

export function budgetBand(depth, window) {
  const f = depth / window;
  if (f >= HARD_STOP) return "hard-stop";
  if (f >= OVER_BUDGET) return "over-budget";
  return "ok";
}

// The id pricing.mjs would key the model under: strips the wrappers a host reports around it
// (Claude Code's `[1m]`, Bedrock's `<region>.anthropic.` prefix and `-v<n>:<n>` suffix, Vertex's
// `@<date>`) and reorders the older `claude-3-5-sonnet-...` naming to family-first.
function canonicalModelId(model) {
  return model
    .replace(/\[1m\]$/i, "")
    .replace(/^(?:[a-z]+\.)?anthropic\./, "")
    .replace(/-v\d+:\d+$/, "")
    .replace(/@\d{8}$/, "")
    .replace(/^claude-(\d+(?:-\d+)*)-(opus|sonnet|haiku)(-\d{8})?$/, "claude-$2-$1$3");
}

const PRICED_VERSIONS = Object.keys(PRICING.models).map((id) => ({ id, ...parseModelId(id) })).filter((p) => p.family);
const sameVersion = (a, b) => a.family === b.family && a.version.join("-") === b.version.join("-");

// Null when no window is knowable: an unpriced version older than its family's newest priced one
// (Sonnet 4.5, Opus 4.1) may have run a smaller window than that sibling, so the assumed 1M would
// read its depth several times too shallow. An id that does not parse is assumed, not unknown.
export function windowFor(model) {
  const id = typeof model === "string" ? canonicalModelId(model) : model;
  const exact = priceFor(id);
  if (exact) return { window: exact.window };
  const provisional = provisionalPriceFor(id);
  if (provisional) return { window: provisional.price.window, windowProvisionalAs: provisional.basedOn };
  const parsed = typeof id === "string" ? parseModelId(id) : null;
  if (parsed) {
    // A dated snapshot of a priced version is that version.
    const snapshotOf = PRICED_VERSIONS.find((p) => sameVersion(p, parsed));
    if (snapshotOf) return { window: PRICING.models[snapshotOf.id].window, windowProvisionalAs: snapshotOf.id };
    // provisionalPriceFor declines a parsed id of a priced family only when it is older.
    if (PRICED_VERSIONS.some((p) => p.family === parsed.family)) return null;
  }
  return { window: ASSUMED_WINDOW, windowAssumed: true };
}

// The coordinator's per-stage counters, references/delegation.md § The stage budget; the stage meter
// displays them and golden-path holds them equal to that section.
export const STAGE_TOOL_CALLS = 30;
export const STAGE_FILES_READ = 15;
