// The one place model prices and context windows live. Both ride together because the
// context-depth gate needs the window and a second table would be a second thing to let drift.
// Prices are US dollars per million tokens.
//
// A row may carry `cacheRead`, the listed cache-read price. A row without it is "unlisted,
// assumed": it reads at CACHE_READ_DEFAULT_MULTIPLIER x its input price, the rate doctor applied
// to every model before cache reads were priced per model. `claude-fable-5` and the rows whose
// reference entry names no cache-read price are in that state until one is listed.

export const CACHE_READ_DEFAULT_MULTIPLIER = 0.1;

export const PRICING = Object.freeze({
  // The date the claude-api reference these prices came from was cached.
  asOf: "2026-09-25",
  models: Object.freeze({
    "claude-opus-5-5": Object.freeze({ in: 4, out: 20, cacheRead: 0.2, window: 1_000_000 }),
    "claude-opus-5": Object.freeze({ in: 5, out: 25, window: 1_000_000 }),
    "claude-opus-4-8": Object.freeze({ in: 5, out: 25, window: 1_000_000 }),
    "claude-fable-5": Object.freeze({ in: 10, out: 50, window: 1_000_000 }),
    "claude-fable-5-1": Object.freeze({ in: 10, out: 50, cacheRead: 0.25, window: 1_000_000 }),
    "claude-sonnet-5-5": Object.freeze({ in: 2, out: 10, cacheRead: 0.2, window: 1_000_000 }),
    // List price per the claude-api reference as of asOf.
    "claude-sonnet-5": Object.freeze({ in: 2, out: 10, window: 1_000_000 }),
    "claude-haiku-4-5-20251001": Object.freeze({ in: 1, out: 5, window: 200_000 }),
  }),
});

// The exact id, or null. Strict on purpose: the routing advisories, the impact ledger and
// dispatch-cost present what they compute as measured, so none of them may receive a price
// that was inferred for a model the table has never heard of.
export function priceFor(model) {
  if (typeof model !== "string" || model === "") return null;
  return PRICING.models[model] ?? null;
}

// Cache-read cost for `tokens`, in per-million-weighted units (doctor divides by 1e6). The
// unlisted branch keeps the operation order the flat rate used, so every figure for a row with
// no listed cache-read price is bit-identical to what it was before.
export function cacheReadDollars(tokens, price) {
  return price.cacheRead !== undefined
    ? tokens * price.cacheRead
    : tokens * price.in * CACHE_READ_DEFAULT_MULTIPLIER;
}

// `claude-<family>-<n>[-<n>...][-<8-digit date>]`. Anything else (a family after the version, a
// non-numeric suffix, a family the table does not price) does not parse and gets no fallback.
const MODEL_ID = /^claude-(opus|sonnet|haiku|fable)-(\d+(?:-\d+)*?)(?:-\d{8})?$/;

function parseModelId(id) {
  const m = MODEL_ID.exec(id);
  if (!m) return null;
  const version = m[2].split("-").map(Number);
  // A lone date stamp is not a version: no real model line has a segment this large.
  if (version.some((n) => n > 99)) return null;
  return { family: m[1], version };
}

function compareSegments(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// A provisional price for a model the table has no row for — only when the model is NEWER than
// every priced model of its family, so a future `claude-opus-5-6` prices as Opus 5.5. An older
// model is deliberately not covered: its price may differ from the newest sibling's (Sonnet 4.6
// is $3/$15 against Sonnet 5.5's $2/$10), and a plausible wrong figure is worse than an exclusion.
// Doctor reports what this returns on its own line and never folds it into a measured figure.
export function provisionalPriceFor(model) {
  if (typeof model !== "string" || priceFor(model)) return null;
  const parsed = parseModelId(model);
  if (!parsed) return null;
  let best = null;
  for (const [id, price] of Object.entries(PRICING.models)) {
    const known = parseModelId(id);
    if (!known || known.family !== parsed.family) continue;
    if (!best || compareSegments(known.version, best.version) > 0) best = { id, price, version: known.version };
  }
  if (!best || compareSegments(parsed.version, best.version) < 0) return null;
  return { price: best.price, basedOn: best.id };
}
