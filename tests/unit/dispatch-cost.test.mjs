import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { priceTranscript, pricedDispatches } from "../../scripts/dispatch-cost.mjs";
import { hashSession } from "../../scripts/run-record.mjs";

const turn = (model, out = 1000) => JSON.stringify({
  type: "assistant",
  message: { model, usage: { input_tokens: 1000, output_tokens: out } },
});

// One session directory with a subagents/ folder, written the way Claude Code lays it out.
function slugDirWith(agents) {
  const slug = makeTempDir("dispatch-cost-");
  const dir = join(slug, "sess-1", "subagents");
  mkdirSync(dir, { recursive: true });
  for (const [id, { meta, lines }] of Object.entries(agents)) {
    writeFileSync(join(dir, `${id}.meta.json`), JSON.stringify(meta));
    if (lines !== null) writeFileSync(join(dir, `${id}.jsonl`), lines.join("\n") + "\n");
  }
  return slug;
}

const impl = (description) => ({ agentType: "devcycle:implementer", description });

test("pricedDispatches: prices an implementer dispatch at its own turns' models", () => {
  const slug = slugDirWith({
    "agent-a1": { meta: impl("Implement Task 3 (routing)"), lines: [turn("claude-sonnet-5"), turn("claude-sonnet-5")] },
  });
  const [row] = pricedDispatches(slug);
  assert.equal(row.taskId, "3");
  assert.equal(row.measurement, "ok");
  assert.equal(row.turns, 2);
  assert.deepEqual(row.models, ["claude-sonnet-5"]);
  // 2 turns x (1000 in @ $2/M + 1000 out @ $10/M) = 2 x $0.012
  assert.ok(Math.abs(row.usd - 0.024) < 1e-9, `expected 0.024, got ${row.usd}`);
  assert.equal(row.sessionId, "sess-1");
  assert.equal(row.sessionHash, hashSession("sess-1"));
  assert.equal(row.agentId, "agent-a1");
});

test("pricedDispatches: a sidecar whose transcript is gone is unmeasurable, never $0", () => {
  const slug = slugDirWith({ "agent-a2": { meta: impl("Task 1"), lines: null } });
  const [row] = pricedDispatches(slug);
  assert.equal(row.usd, null, "a missing transcript must not read as zero dollars");
  assert.equal(row.measurement, "missing-transcript");
});

test("pricedDispatches: a turn whose model has no price makes the dispatch unmeasurable", () => {
  const slug = slugDirWith({
    "agent-a3": { meta: impl("Task 1"), lines: [turn("claude-sonnet-5"), turn("claude-opus-99")] },
  });
  const [row] = pricedDispatches(slug);
  assert.equal(row.usd, null, "a partial sum over the priced turns would understate the dispatch");
  assert.equal(row.measurement, "unpriced-model:claude-opus-99");
});

test("pricedDispatches: <synthetic> turns are skipped, not treated as an unpriced model", () => {
  const slug = slugDirWith({
    "agent-a4": { meta: impl("Task 1"), lines: [turn("claude-sonnet-5"), turn("<synthetic>")] },
  });
  const [row] = pricedDispatches(slug);
  assert.equal(row.measurement, "ok");
  assert.deepEqual(row.models, ["claude-sonnet-5"]);
});

test("pricedDispatches: a subagent spanning two models is excluded, and still priced", () => {
  const slug = slugDirWith({
    "agent-a5": { meta: impl("Task 1"), lines: [turn("claude-sonnet-5"), turn("claude-opus-5")] },
  });
  const [row] = pricedDispatches(slug);
  assert.equal(row.measurement, "multi-model");
  assert.equal(row.models.length, 2);
  assert.ok(row.usd > 0, "a multi-model dispatch is attributable to no cell, but its cost is known");
});

test("pricedDispatches: a reviewer sidecar is excluded by agentType", () => {
  const slug = slugDirWith({
    "agent-a6": { meta: { agentType: "devcycle:task-reviewer", description: "Review Task 1" }, lines: [turn("claude-sonnet-5")] },
  });
  assert.deepEqual(pricedDispatches(slug), []);
});

test("pricedDispatches: a description with no task number yields taskId null, not a dropped row", () => {
  const slug = slugDirWith({
    "agent-a7": { meta: impl("Wire the renderer"), lines: [turn("claude-sonnet-5")] },
  });
  const [row] = pricedDispatches(slug);
  assert.equal(row.taskId, null);
  assert.equal(row.measurement, "ok");
});

test("pricedDispatches: a slug directory that does not exist is an empty corpus, not a throw", () => {
  assert.deepEqual(pricedDispatches(join(makeTempDir("dispatch-cost-"), "absent")), []);
});

test("priceTranscript: Fable 5.1 cache reads use the listed $0.25/M rate, Fable 5 the assumed 0.1x input", () => {
  const readTurn = (model) => JSON.stringify({
    type: "assistant",
    message: { model, usage: { input_tokens: 0, cache_read_input_tokens: 1_000_000, output_tokens: 0 } },
  });
  const slug = slugDirWith({
    "agent-f51": { meta: impl("Task 1"), lines: [readTurn("claude-fable-5-1")] },
    "agent-f5": { meta: impl("Task 2"), lines: [readTurn("claude-fable-5")] },
  });
  const rows = Object.fromEntries(pricedDispatches(slug).map((r) => [r.agentId, r]));
  assert.ok(Math.abs(rows["agent-f51"].usd - 0.25) < 1e-9, `got ${rows["agent-f51"].usd}`);
  assert.ok(Math.abs(rows["agent-f5"].usd - 1.0) < 1e-9, `got ${rows["agent-f5"].usd}`);
});

test("priceTranscript: returns the four token sums over the turns it counts, cache writes from the TTL breakdown when present", () => {
  const file = join(makeTempDir("dispatch-cost-"), "agent-sums.jsonl");
  const lines = [
    { type: "assistant", message: { model: "claude-sonnet-5", usage: { input_tokens: 10, cache_creation_input_tokens: 300, cache_read_input_tokens: 40, output_tokens: 5 } } },
    // The breakdown wins over the flat counter when it is present: 200 + 100, not 999.
    { type: "assistant", message: { model: "claude-sonnet-5", usage: { input_tokens: 20, cache_creation_input_tokens: 999, cache_creation: { ephemeral_1h_input_tokens: 200, ephemeral_5m_input_tokens: 100 }, cache_read_input_tokens: 60, output_tokens: 7 } } },
    { type: "assistant", message: { model: "<synthetic>", usage: { input_tokens: 5000, output_tokens: 5000 } } },
    { type: "user", message: { content: "x" } },
  ];
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const r = priceTranscript(file);
  assert.equal(r.measurement, "ok");
  assert.equal(r.turns, 2);
  assert.deepEqual([r.inputTokens, r.cacheWriteTokens, r.cacheReadTokens, r.outputTokens], [30, 600, 100, 12]);
});

test("priceTranscript: the token sums are 0 when the transcript is missing or has no counted turn", () => {
  const dir = makeTempDir("dispatch-cost-");
  const empty = join(dir, "agent-empty.jsonl");
  writeFileSync(empty, JSON.stringify({ type: "user", message: { content: "x" } }) + "\n");
  for (const file of [join(dir, "agent-absent.jsonl"), empty]) {
    const r = priceTranscript(file);
    assert.deepEqual([r.inputTokens, r.cacheWriteTokens, r.cacheReadTokens, r.outputTokens], [0, 0, 0, 0], file);
  }
});
