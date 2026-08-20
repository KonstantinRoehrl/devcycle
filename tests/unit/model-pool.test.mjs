import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parsePool, rungFor, rank, resolveModel, loadTable } from "../../scripts/model-pool.mjs";

const TABLE = [
  { family: "haiku", rank: 1, match: "haiku" },
  { family: "sonnet", rank: 2, match: "sonnet" },
  { family: "opus", rank: 3, match: "opus" },
  { family: "mythos", rank: 4, match: "mythos" },
];
const POOL = "claude-haiku-4-5, claude-sonnet-5 ,claude-opus-5";
const resolve = (over = {}) =>
  resolveModel({ value: POOL, signalCount: 0, orchestratorId: "claude-opus-5", table: TABLE, ...over });

test("an unset knob and `auto` both read as unset, leaving today's derivation untouched", () => {
  assert.deepEqual(parsePool(undefined), { kind: "unset", entries: [] });
  assert.deepEqual(parsePool("${user_config.implementerModel}"), { kind: "unset", entries: [] });
  assert.deepEqual(parsePool("auto"), { kind: "unset", entries: [] });
  assert.deepEqual(parsePool("  auto  "), { kind: "unset", entries: [] });
});

test("a value with no comma is a pin; a single-entry pool is also a pin", () => {
  assert.deepEqual(parsePool("claude-opus-5"), { kind: "pin", entries: ["claude-opus-5"] });
  assert.deepEqual(parsePool("claude-opus-5,"), { kind: "pin", entries: ["claude-opus-5"] });
  assert.deepEqual(parsePool(" , claude-opus-5 , "), { kind: "pin", entries: ["claude-opus-5"] });
});

test("a comma-separated value parses to a pool, trimmed, with empties dropped", () => {
  assert.deepEqual(parsePool(POOL), {
    kind: "pool",
    entries: ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5"],
  });
});

test("a three-entry pool maps three complexity bands", () => {
  assert.equal(rungFor(0, 3), 1);
  assert.equal(rungFor(1, 3), 2);
  assert.equal(rungFor(2, 3), 3);
});

test("a signal count above the pool length clamps to the top rung rather than overflowing", () => {
  assert.equal(rungFor(4, 3), 3);
  assert.equal(rungFor(99, 2), 2);
  // walkthroughModel and branchReviewModel have no complexity predicate — both judge — so their
  // callers saturate the ladder rather than inventing a signal count. Infinity must reach the top
  // rung, not fall through to rung 1 as a non-finite value otherwise would.
  assert.equal(rungFor(Infinity, 3), 3);
});

test("a signal count that is not a number resolves to the simplest rung rather than throwing", () => {
  assert.equal(rungFor(NaN, 3), 1);
  assert.equal(rungFor(undefined, 3), 1);
});

test("a negative or absent signal count resolves to the simplest rung, never below it", () => {
  assert.equal(rungFor(-1, 3), 1);
  assert.equal(rungFor(0, 1), 1);
});

test("rank orders by family, not by version within a family", () => {
  assert.equal(rank("claude-sonnet-9", TABLE), 2);
  assert.equal(rank("claude-opus-1", TABLE), 3);
  assert.ok(rank("claude-opus-1", TABLE) > rank("claude-sonnet-9", TABLE));
  assert.equal(rank("us.anthropic.claude-sonnet-5", TABLE), 2);
  assert.equal(rank("some-other-model", TABLE), null);
});

test("a pooled pick under the ceiling logs its rung and clamps nothing", () => {
  assert.deepEqual(resolve({ signalCount: 1 }), {
    model: "claude-sonnet-5",
    outcome: "model claude-sonnet-5 (pooled: rung 2/3)",
  });
});

test("a pooled pick above the orchestrator's tier clamps down and names what it clamped from", () => {
  assert.deepEqual(resolve({ signalCount: 2, orchestratorId: "claude-sonnet-5" }), {
    model: "claude-sonnet-5",
    outcome: "model claude-sonnet-5 (pooled: rung 3/3, clamped from claude-opus-5)",
  });
});

test("a pin above the orchestrator's tier clamps the same way — the ceiling is uniform", () => {
  assert.deepEqual(resolve({ value: "claude-opus-5", orchestratorId: "claude-haiku-4-5" }), {
    model: "claude-haiku-4-5",
    outcome: "model claude-haiku-4-5 (pinned, clamped from claude-opus-5)",
  });
});

test("a pin at or below the orchestrator's tier is used verbatim", () => {
  assert.deepEqual(resolve({ value: "claude-sonnet-5", orchestratorId: "claude-opus-5" }), {
    model: "claude-sonnet-5",
    outcome: "model claude-sonnet-5 (pinned)",
  });
});

test("when no entry sits at or below the orchestrator, resolution falls through to session tier", () => {
  assert.deepEqual(resolve({ signalCount: 0, orchestratorId: "claude-haiku-4-5", value: "claude-sonnet-5,claude-opus-5" }), {
    model: null,
    outcome: "model session (ceiling: no rung at or below claude-haiku-4-5)",
  });
});

test("an unrankable requested id falls through to session tier rather than being trusted", () => {
  assert.deepEqual(resolve({ value: "some-unknown-model" }), {
    model: null,
    outcome: "model session (ceiling: some-unknown-model unranked)",
  });
});

test("an unrankable orchestrator id falls through to session tier too", () => {
  assert.deepEqual(resolve({ signalCount: 1, orchestratorId: "some-unknown-orchestrator" }), {
    model: null,
    outcome: "model session (ceiling: some-unknown-orchestrator unranked)",
  });
});

test("an unset knob resolves to no override and says so, leaving auto's own derivation to the caller", () => {
  assert.deepEqual(resolve({ value: "auto" }), { model: null, outcome: "model session (auto)" });
});

test("the shipped table loads and ranks the families the ceiling rule names", () => {
  const shipped = loadTable();
  assert.deepEqual(
    shipped.map((e) => e.family),
    ["haiku", "sonnet", "opus", "mythos"]
  );
  assert.ok(rank("claude-haiku-4-5", shipped) < rank("claude-sonnet-5", shipped));
  assert.ok(rank("claude-sonnet-5", shipped) < rank("claude-opus-5", shipped));
});

const CLI = new URL("../../scripts/model-pool.mjs", import.meta.url).pathname;
const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

// The module is the ceiling policy's only implementation; until it had a CLI, nothing could
// invoke it, which is exactly what audit finding F6 measured.
test("cli: a pool resolves by rung and prints the audit outcome string", () => {
  const res = cli("--value", POOL, "--orchestrator", "claude-opus-5", "--signals", "1");
  assert.equal(res.status, 0);
  assert.deepEqual(JSON.parse(res.stdout), {
    model: "claude-sonnet-5",
    outcome: "model claude-sonnet-5 (pooled: rung 2/3)",
  });
});

test("cli: an unset knob resolves to the session tier without an override", () => {
  const res = cli("--value", "auto", "--orchestrator", "claude-opus-5");
  assert.equal(res.status, 0);
  assert.deepEqual(JSON.parse(res.stdout), { model: null, outcome: "model session (auto)" });
});

test("cli: a pin above the orchestrator's tier is clamped, never dispatched", () => {
  const res = cli("--value", "claude-opus-5", "--orchestrator", "claude-sonnet-5");
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.model, "claude-sonnet-5");
  assert.match(out.outcome, /clamped from claude-opus-5/);
});

test("cli: --signals accepts Infinity, the form a knob with no complexity predicate passes", () => {
  const res = cli("--value", POOL, "--orchestrator", "claude-opus-5", "--signals", "Infinity");
  assert.equal(res.status, 0);
  assert.equal(JSON.parse(res.stdout).model, "claude-opus-5", "saturates at the top rung");
});

test("cli: a missing --orchestrator fails loudly rather than assuming a tier", () => {
  const res = cli("--value", POOL);
  assert.notEqual(res.status, 0);
  assert.equal(res.stdout, "");
  assert.match(res.stderr, /--orchestrator is required/);
});

test("cli: a missing --value fails loudly rather than defaulting to unset", () => {
  const res = cli("--orchestrator", "claude-opus-5");
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /--value is required/);
});

test("cli: a non-numeric --signals is rejected rather than silently counted as zero", () => {
  const res = cli("--value", POOL, "--orchestrator", "claude-opus-5", "--signals", "many");
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /--signals/);
});

test("cli: --table overrides the shipped tier table", () => {
  const path = join(mkdtempSync(join(tmpdir(), "model-pool-table-")), "tiers.json");
  writeFileSync(path, JSON.stringify([{ family: "sonnet", rank: 1, match: "sonnet" }]));
  const res = cli("--value", "claude-sonnet-5", "--orchestrator", "claude-sonnet-5", "--table", path);
  assert.equal(res.status, 0);
  assert.equal(JSON.parse(res.stdout).model, "claude-sonnet-5");
});
