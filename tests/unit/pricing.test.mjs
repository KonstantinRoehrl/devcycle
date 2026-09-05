// The versioned price/window table in scripts/pricing.mjs — the single place prices live.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("PRICING: covers every model id the doctor corpus has recorded (tests/fixtures/observed-model-ids.json)", () => {
  const observed = JSON.parse(readFileSync(new URL("../fixtures/observed-model-ids.json", import.meta.url), "utf8"));
  assert.ok(Array.isArray(observed) && observed.length >= 6, "the fixture lists the observed ids");
  for (const id of observed) assert.ok(PRICING.models[id], `${id} is priced`);
});

test("PRICING: fable is priced above opus, not below it", () => {
  assert.ok(PRICING.models["claude-fable-5"].in > PRICING.models["claude-opus-5"].in);
  assert.ok(PRICING.models["claude-fable-5"].out > PRICING.models["claude-opus-5"].out);
});

test("PRICING: fable 5.1 is priced above opus, like fable 5", () => {
  assert.ok(PRICING.models["claude-fable-5-1"].in > PRICING.models["claude-opus-5"].in);
  assert.ok(PRICING.models["claude-fable-5-1"].out > PRICING.models["claude-opus-5"].out);
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
