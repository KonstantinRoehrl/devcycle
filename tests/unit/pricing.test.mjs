// The versioned price/window table in scripts/pricing.mjs — the single place prices live.
import test from "node:test";
import assert from "node:assert/strict";
import { PRICING, priceFor } from "../../scripts/pricing.mjs";

test("PRICING: asOf is an ISO date", () => {
  assert.match(PRICING.asOf, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!Number.isNaN(Date.parse(PRICING.asOf)));
});

test("PRICING: every entry carries input price, output price, and context window", () => {
  const ids = Object.keys(PRICING.models);
  assert.ok(ids.length >= 5, "the measured corpus uses at least five model ids");
  for (const id of ids) {
    const m = PRICING.models[id];
    assert.equal(typeof m.in, "number", `${id}.in`);
    assert.equal(typeof m.out, "number", `${id}.out`);
    assert.equal(typeof m.window, "number", `${id}.window`);
    assert.ok(m.in > 0 && m.out > 0 && m.window > 0, `${id} has positive values`);
  }
});

test("PRICING: covers every model id the measured corpus actually used", () => {
  for (const id of [
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-fable-5",
    "claude-sonnet-5",
    "claude-haiku-4-5-20251001",
  ])
    assert.ok(PRICING.models[id], `${id} is priced`);
});

test("PRICING: fable is priced above opus, not below it", () => {
  assert.ok(PRICING.models["claude-fable-5"].in > PRICING.models["claude-opus-5"].in);
  assert.ok(PRICING.models["claude-fable-5"].out > PRICING.models["claude-opus-5"].out);
});

test("priceFor: a known id returns its entry", () => {
  assert.deepEqual(priceFor("claude-sonnet-5"), { in: 2, out: 10, window: 1_000_000 });
});

test("priceFor: an unknown id returns null rather than a default", () => {
  assert.equal(priceFor("claude-opus-9"), null);
  assert.equal(priceFor(undefined), null);
  assert.equal(priceFor(""), null);
});

test("PRICING: the table is frozen so no caller can mutate prices at runtime", () => {
  assert.throws(() => {
    PRICING.models["claude-opus-5"] = { in: 0, out: 0, window: 1 };
  }, TypeError);
});
