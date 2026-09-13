import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
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

// F-escalation: `sessionTierUnreachable` lets a caller that knows the session tier cannot be
// reached (e.g. a subagent with a configured default model) ask for an explicit override instead
// of the silent no-op the session tier otherwise means. The flag only matters when an escalation
// actually happened — signalCount > 0 — so an unescalated run is untouched.
test("without the flag, an escalation to the session tier is byte-identical to today", () => {
  const table = [{ family: "sonnet", rank: 2, match: "sonnet" }, { family: "opus", rank: 3, match: "opus" }];
  const args = { value: "claude-sonnet-5,claude-opus-5", signalCount: 9, orchestratorId: "claude-opus-5", table };
  assert.deepEqual(resolveModel(args), resolveModel({ ...args, sessionTierUnreachable: false }));
});

test("an unreachable session tier resolves to the orchestrator's own id as an explicit override", () => {
  const table = [{ family: "sonnet", rank: 2, match: "sonnet" }, { family: "opus", rank: 3, match: "opus" }];
  const r = resolveModel({
    value: "", signalCount: 9, orchestratorId: "claude-opus-5", table, sessionTierUnreachable: true,
  });
  assert.equal(r.model, "claude-opus-5");
  assert.equal(r.outcome, "model claude-opus-5 (escalated, session unreachable: explicit override)");
});

// The original form of this test passed `value: ""`, which resolves to the `unset` branch before
// any pool entry is ever considered — "claude-sonnet-5" appears nowhere in the computation, so
// `assert.notEqual(r.model, "claude-sonnet-5")` was true by construction and could not have caught
// a real demotion. This version puts two weaker, individually-admissible families right next to the
// unranked rung that triggers escalation, so a bug that fell back to "the next admissible pool
// entry" instead of the orchestrator's own id would produce exactly one of them.
test("an unreachable session tier names the orchestrator itself, not a weaker family sitting in the same pool", () => {
  const table = [
    { family: "haiku", rank: 1, match: "haiku" },
    { family: "sonnet", rank: 2, match: "sonnet" },
    { family: "opus", rank: 3, match: "opus" },
  ];
  const r = resolveModel({
    value: "claude-haiku-4-5,claude-sonnet-5,unknown-model",
    signalCount: 9,
    orchestratorId: "claude-opus-5",
    table,
    sessionTierUnreachable: true,
  });
  assert.equal(r.model, "claude-opus-5");
  assert.notEqual(r.model, "claude-sonnet-5");
  assert.notEqual(r.model, "claude-haiku-4-5");
});

test("an unrankable orchestrator keeps null and says so", () => {
  const r = resolveModel({
    value: "", signalCount: 9, orchestratorId: "who-knows", table: [{ family: "opus", rank: 3, match: "opus" }],
    sessionTierUnreachable: true,
  });
  assert.equal(r.model, null);
  assert.equal(r.outcome, "model session (escalated, unreachable and unranked)");
});

// The four tests below each pin one of the other session-tier return sites (ceiling-unranked,
// pin-unranked, pool-rung-unranked, no-admissible-rung) under an actual escalation. Each uses a
// `value` that is not empty/`auto`, so `parsePool` never takes the `unset` branch above — unlike
// the `unset`-only coverage the three tests above give, these reach ceiling/pin/pool logic first.

test("an unrankable orchestrator escalates from the ceiling check too, not just the unset path", () => {
  const table = [{ family: "sonnet", rank: 2, match: "sonnet" }];
  const r = resolveModel({
    value: "claude-sonnet-5", signalCount: 9, orchestratorId: "who-knows", table, sessionTierUnreachable: true,
  });
  assert.equal(r.model, null);
  assert.equal(r.outcome, "model session (escalated, unreachable and unranked)");
});

test("an unrankable pin escalates via explicit override, not a silent no-op", () => {
  const table = [{ family: "opus", rank: 3, match: "opus" }];
  const r = resolveModel({
    value: "unknown-model", signalCount: 9, orchestratorId: "claude-opus-5", table, sessionTierUnreachable: true,
  });
  assert.equal(r.model, "claude-opus-5");
  assert.equal(r.outcome, "model claude-opus-5 (escalated, session unreachable: explicit override)");
});

test("an unrankable pool rung escalates via explicit override, not a silent no-op", () => {
  const table = [{ family: "sonnet", rank: 2, match: "sonnet" }, { family: "opus", rank: 3, match: "opus" }];
  const r = resolveModel({
    value: "claude-opus-5,unknown-model",
    signalCount: 9,
    orchestratorId: "claude-opus-5",
    table,
    sessionTierUnreachable: true,
  });
  assert.equal(r.model, "claude-opus-5");
  assert.equal(r.outcome, "model claude-opus-5 (escalated, session unreachable: explicit override)");
});

test("a pool with no rung at or below the orchestrator still escalates via explicit override", () => {
  const table = [
    { family: "haiku", rank: 1, match: "haiku" },
    { family: "sonnet", rank: 2, match: "sonnet" },
    { family: "opus", rank: 3, match: "opus" },
  ];
  const r = resolveModel({
    value: "claude-sonnet-5,claude-opus-5",
    signalCount: 9,
    orchestratorId: "claude-haiku-4-5",
    table,
    sessionTierUnreachable: true,
  });
  assert.equal(r.model, "claude-haiku-4-5");
  assert.equal(r.outcome, "model claude-haiku-4-5 (escalated, session unreachable: explicit override)");
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
  const path = join(makeTempDir("model-pool-table-"), "tiers.json");
  writeFileSync(path, JSON.stringify([{ family: "sonnet", rank: 1, match: "sonnet" }]));
  const res = cli("--value", "claude-sonnet-5", "--orchestrator", "claude-sonnet-5", "--table", path);
  assert.equal(res.status, 0);
  assert.equal(JSON.parse(res.stdout).model, "claude-sonnet-5");
});

// F37: a hand-rolled `argv.indexOf` parser silently ignores a flag it does not know, so a typo
// resolves a *different model* than the caller asked for and says nothing.
test("cli: a typo'd flag is an error, not a silently different model", () => {
  const res = cli("--value", POOL, "--orchestrator", "claude-opus-5", "--signal", "5");
  assert.notEqual(res.status, 0, "a flag nothing reads must not resolve a model");
  assert.equal(res.stdout, "");
  assert.match(res.stderr, /model-pool: unrecognised flag --signal/);
});

test("cli: a flag followed by another flag is a missing value, never a borrowed one", () => {
  const res = cli("--value", "--orchestrator", "claude-opus-5");
  assert.notEqual(res.status, 0, "--value must not swallow the next flag's name as its value");
  assert.equal(res.stdout, "");
  assert.match(res.stderr, /model-pool: --value/);
});

// The shared parser's default noun is a path, and three of these flags take no path at all. Pinned
// so a future change to that default cannot silently send an operator looking for a file that was
// never involved.
test("cli: a valueless flag asks for what that flag actually takes, not a path", () => {
  const value = cli("--value", "--orchestrator", "claude-opus-5");
  assert.match(value.stderr, /model-pool: --value requires a model id or pool/);
  const orchestrator = cli("--value", POOL, "--orchestrator", "--signals", "1");
  assert.match(orchestrator.stderr, /model-pool: --orchestrator requires a model id/);
  const signals = cli("--value", POOL, "--orchestrator", "claude-opus-5", "--signals");
  assert.match(signals.stderr, /model-pool: --signals requires a number/);
  const table = cli("--value", POOL, "--orchestrator", "claude-opus-5", "--table");
  assert.match(table.stderr, /model-pool: --table requires .*path/, "--table really is a path");
});

// The other half of F37: dropping a flag *name* leaves a bare token the parser collects as a
// positional. model-pool takes no positional arguments, so discarding it resolved rung 1 while the
// caller had asked for rung 6 — the same silently-different-model outcome as the typo'd flag.
test("cli: a stray positional is an error, not a silently different model", () => {
  const res = cli("--value", POOL, "--orchestrator", "claude-opus-5", "5");
  assert.notEqual(res.status, 0, "a token nothing reads must not resolve a model");
  assert.equal(res.stdout, "");
  assert.match(res.stderr, /model-pool: unexpected argument "5"/);
});
