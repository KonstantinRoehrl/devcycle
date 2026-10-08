import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as bands from "../../scripts/depth-bands.mjs";
import * as probe from "../../scripts/depth-probe.mjs";

const usage = (input, creation, read) =>
  ({ input_tokens: input, cache_creation_input_tokens: creation, cache_read_input_tokens: read, output_tokens: 7 });

test("contextDepth sums input, cache creation and cache reads, never output", () => {
  assert.equal(bands.contextDepth(usage(10, 200, 3000)), 3210);
});

test("contextDepth reads a step with no usage block as no depth, not as zero", () => {
  assert.equal(bands.contextDepth(null), null);
  assert.equal(bands.contextDepth(undefined), null);
});

test("budgetBand: over budget from 15% of the window, hard stop from 20%", () => {
  assert.equal(bands.OVER_BUDGET, 0.15);
  assert.equal(bands.HARD_STOP, 0.2);
  assert.equal(bands.budgetBand(29_999, 200_000), "ok");
  assert.equal(bands.budgetBand(30_000, 200_000), "over-budget");
  assert.equal(bands.budgetBand(40_000, 200_000), "hard-stop");
});

test("windowFor: a priced, a provisional, an assumed and an unknowable window", () => {
  assert.deepEqual(bands.windowFor("claude-haiku-4-5-20251001"), { window: 200_000 });
  assert.deepEqual(bands.windowFor("claude-haiku-4-5"), { window: 200_000, windowProvisionalAs: "claude-haiku-4-5-20251001" });
  assert.deepEqual(bands.windowFor("claude-mythos-9"), { window: bands.ASSUMED_WINDOW, windowAssumed: true });
  assert.equal(bands.windowFor("claude-sonnet-4-5-20250929"), null);
});

test("the stage budget's two counters", () => {
  assert.equal(bands.STAGE_TOOL_CALLS, 30);
  assert.equal(bands.STAGE_FILES_READ, 15);
});

test("depth-probe re-exports the leaf's own bindings, so every existing caller runs one implementation", () => {
  for (const name of ["contextDepth", "budgetBand", "windowFor", "ASSUMED_WINDOW"]) assert.equal(probe[name], bands[name], name);
});

test("depth-bands imports pricing.mjs and nothing else — the hooks module, which has no Node, loads it", () => {
  const src = readFileSync(new URL("../../scripts/depth-bands.mjs", import.meta.url), "utf8");
  assert.deepEqual([...src.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]), ["./pricing.mjs"]);
});
