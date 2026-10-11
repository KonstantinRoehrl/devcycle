// scripts/budget-decisions.mjs: a budget fixture equals what the decisions log records.
import test from "node:test";
import assert from "node:assert/strict";
import { recordedBudgets, budgetDecisionErrors, newestRecorded } from "../../scripts/budget-decisions.mjs";

const log = (...lines) => ["# Decision log", "", ...lines, ""].join("\n");

test("the first budget line for a key is its recorded value — the log is newest first", () => {
  const { recorded, errors } = recordedBudgets(log("budget: surface-budget.json surfaceTotal 5000", "budget: surface-budget.json surfaceTotal 6000"));
  assert.deepEqual(errors, []);
  assert.equal(recorded.get("surface-budget.json surfaceTotal").value, 5000);
});

test("a value equal to the recorded figure passes; a raise above it fails naming the line it needs", () => {
  const logText = log("budget: surface-budget.json surfaceTotal 5000");
  assert.deepEqual(budgetDecisionErrors({ fixtures: { "surface-budget.json": { surfaceTotal: 5000 } }, logText }), []);
  const [err] = budgetDecisionErrors({ fixtures: { "surface-budget.json": { surfaceTotal: 5001 } }, logText });
  assert.match(err, /surfaceTotal is 5001, above the newest recorded figure 5000/);
  assert.match(err, /budget: surface-budget\.json surfaceTotal 5001/);
});

test("a value below the recorded figure fails too — a cut records its figure", () => {
  const logText = log("budget: surface-budget.json surfaceTotal 5000");
  const errors = budgetDecisionErrors({ fixtures: { "surface-budget.json": { surfaceTotal: 4990 } }, logText });
  assert.deepEqual(errors, [
    'tests/fixtures/surface-budget.json: surfaceTotal is 4990, below the newest recorded figure 5000 (docs/decisions/README.md:3) — ' +
      'a cut records its figure: add "budget: surface-budget.json surfaceTotal 4990" in docs/decisions/README.md',
  ]);
});

test("an unrecorded key counts as 0, so any value fails", () => {
  const [err] = budgetDecisionErrors({ fixtures: { "context-budget.json": { "playbooks/a.md": 10 } }, logText: log() });
  assert.match(err, /playbooks\/a\.md is 10, above the unrecorded 0/);
});

test("a line naming an unknown fixture or key fails, unless a newer line retires the key", () => {
  const fixtures = { "surface-budget.json": { surfaceTotal: 1 } };
  const stale = budgetDecisionErrors({
    fixtures,
    logText: log("budget: surface-budget.json surfaceTotal 1", "budget: nope.json x 3", "budget: surface-budget.json gone 4"),
  });
  assert.equal(stale.length, 2);
  assert.match(stale[0], /names fixture "nope\.json"/);
  assert.match(stale[1], /names key "gone", which surface-budget\.json does not have/);
  // Restoring is offered first: for a reference that still exists, retiring its entry is the wrong fix.
  assert.match(stale[1], /restore "gone" in surface-budget\.json, or retire it with a newer "budget: surface-budget\.json gone retired" line/);
  const retired = budgetDecisionErrors({
    fixtures,
    logText: log("budget: surface-budget.json surfaceTotal 1", "budget: surface-budget.json gone retired", "budget: surface-budget.json gone 4"),
  });
  assert.deepEqual(retired, []);
});

test("a key retired in the log while its fixture still carries a value counts as unrecorded", () => {
  const [err] = budgetDecisionErrors({
    fixtures: { "surface-budget.json": { surfaceTotal: 5 } },
    logText: log("budget: surface-budget.json surfaceTotal retired", "budget: surface-budget.json surfaceTotal 9"),
  });
  assert.match(err, /surfaceTotal is 5, above the unrecorded 0/);
});

// A negative value used to reach the cut branch with no recorded line to name, and threw — taking
// every failure validate had already collected with it.
for (const [state, lines] of [
  ["no recorded line", []],
  ["a retired newest line", ["budget: surface-budget.json surfaceTotal retired"]],
  ["a recorded figure", ["budget: surface-budget.json surfaceTotal 5000"]],
])
  test(`a negative value with ${state} fails as an impossible count, naming the measured-value fix`, () => {
    const errors = budgetDecisionErrors({ fixtures: { "surface-budget.json": { surfaceTotal: -5 } }, logText: log(...lines) });
    assert.deepEqual(errors, [
      "tests/fixtures/surface-budget.json: surfaceTotal is -5, not a byte or line count — set it to the measured value",
    ]);
  });

test("newestRecorded returns a key's newest line, retired included, and nothing for an unrecorded key", () => {
  const { recorded } = recordedBudgets(
    log("budget: context-budget.json references/a.md retired", "budget: context-budget.json references/a.md 40")
  );
  assert.equal(newestRecorded(recorded, "context-budget.json", "references/a.md")?.value, "retired");
  assert.equal(newestRecorded(recorded, "context-budget.json", "references/b.md"), undefined);
});

test("a malformed budget line fails with its line number", () => {
  const [err] = budgetDecisionErrors({ fixtures: {}, logText: log("budget: surface-budget.json surfaceTotal lots") });
  assert.match(err, /docs\/decisions\/README\.md:3: malformed budget line/);
});

// A near-miss is never skipped: an ignored newer line that lowers a figure would leave the older,
// higher one as the ceiling. The fixture sits at that older figure, so skipping the near-miss would
// report nothing at all.
for (const [shape, line] of [
  ["an indented line", "  budget: surface-budget.json surfaceTotal 1"],
  ["a list item", "- budget: surface-budget.json surfaceTotal 1"],
  ["a capitalised keyword", "Budget: surface-budget.json surfaceTotal 1"],
])
  test(`${shape} is a malformed budget line, not an ignored one`, () => {
    const errors = budgetDecisionErrors({
      fixtures: { "surface-budget.json": { surfaceTotal: 5 } },
      logText: log(line, "budget: surface-budget.json surfaceTotal 5"),
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /docs\/decisions\/README\.md:3: malformed budget line/);
  });
