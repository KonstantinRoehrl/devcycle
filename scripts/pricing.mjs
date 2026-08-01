// The one place model prices and context windows live. Both ride together because the
// context-depth gate needs the window and a second table would be a second thing to let drift.
// Prices are US dollars per million tokens.

export const PRICING = Object.freeze({
  asOf: "2026-08-01",
  models: Object.freeze({
    "claude-opus-5": Object.freeze({ in: 5, out: 25, window: 1_000_000 }),
    "claude-opus-4-8": Object.freeze({ in: 5, out: 25, window: 1_000_000 }),
    "claude-fable-5": Object.freeze({ in: 10, out: 50, window: 1_000_000 }),
    // $2/$10 introductory pricing through 2026-08-31.
    "claude-sonnet-5": Object.freeze({ in: 2, out: 10, window: 1_000_000 }),
    "claude-haiku-4-5-20251001": Object.freeze({ in: 1, out: 5, window: 200_000 }),
  }),
});

export function priceFor(model) {
  if (typeof model !== "string" || model === "") return null;
  return PRICING.models[model] ?? null;
}
