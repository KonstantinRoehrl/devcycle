// hooks/lib/row-format.mjs: the drive band's row shape, ported from cc-statusline's hooks/format.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { MODEL_COLOR, SEPARATOR, VALUE_COLOR, cells, fitRow, fmtK, fmtModelName, gradientColor, joinDot, tierParts, width } from "../../hooks/lib/row-format.mjs";

const plain = (row) => row.map((s) => s.text).join("");

test("fmtModelName shortens a Claude id, drops a dated suffix and leaves any other id as it is", () => {
  assert.equal(fmtModelName("claude-opus-5-5"), "Opus-5.5");
  assert.equal(fmtModelName("claude-sonnet-5-5-20261001"), "Sonnet-5.5");
  assert.equal(fmtModelName("claude-haiku-5"), "Haiku-5");
  assert.equal(fmtModelName("gpt-x"), "gpt-x");
  assert.equal(fmtModelName(""), "—");
});

test("fmtK keeps one decimal, floored, from a thousand up", () => {
  assert.deepEqual([0, 999, 1000, 12_345, 36_012, 230_100].map(fmtK), ["0", "999", "1.0k", "12.3k", "36.0k", "230.1k"]);
});

test("gradientColor is green to 40, amber at the midpoint, red from 65, linear across each half", () => {
  assert.deepEqual([0, 18, 40, 52, 53, 65, 80, 100].map((p) => gradientColor(p, 40, 65)), [
    "rgb(0,215,0)", "rgb(0,215,0)", "rgb(0,215,0)", "rgb(244,139,0)", "rgb(255,130,0)", "rgb(255,0,0)", "rgb(255,0,0)", "rgb(255,0,0)",
  ]);
});

test("tierParts: the model in teal with its effort, ctx only over a known window, tokens whenever depth is known", () => {
  assert.deepEqual(tierParts({ model: "claude-opus-5-5", effort: "high", tokens: 230_100, window: 1_000_000 }), {
    model: [{ text: "Opus-5.5 (high)", color: MODEL_COLOR }],
    ctx: [{ text: "ctx 23%", color: "rgb(0,215,0)" }],
    tokens: [{ text: "230.1k tok", color: VALUE_COLOR }],
  });
  assert.deepEqual(tierParts({ model: "gpt-x", tokens: 5000, window: 1_000_000, windowAssumed: true }), {
    model: [{ text: "gpt-x", color: MODEL_COLOR }], ctx: [], tokens: [{ text: "5.0k tok", color: VALUE_COLOR }],
  });
  assert.deepEqual(tierParts({ model: "claude-opus-5-5", tokens: 1_200_000, window: 1_000_000 }).ctx, [{ text: "ctx 100%", color: "rgb(255,0,0)" }]);
  assert.deepEqual(tierParts({}), { model: [], ctx: [], tokens: [] });
});

test("joinDot drops an empty part together with its separator", () => {
  assert.equal(plain(joinDot([[{ text: "a" }], [], [{ text: "b" }]])), `a${SEPARATOR}b`);
  assert.deepEqual(joinDot([[], []]), []);
  assert.equal(cells("⠙ ·"), 3);
  assert.equal(width([{ text: "ab" }, { text: "⠙" }]), 3);
});

const parts = tierParts({ model: "claude-sonnet-5-5", effort: "high", tokens: 18_100, window: 1_000_000 });
const what = [{ text: "reviewing · round 1" }, { text: " (1 rejection)", color: "warning" }, { text: " · fast" }, { text: " · <1m · 2 tool calls" }];
const row = (columns) => plain(fitRow({ prefix: [{ text: "⠙ task 5  " }], lead: [parts.model, parts.ctx], what, keep: 2, tail: [parts.tokens] }, columns));

test("fitRow: a row that fits, or a limit of 0, is the whole row", () => {
  const whole = "⠙ task 5  Sonnet-5.5 (high) · ctx 1% · reviewing · round 1 (1 rejection) · fast · <1m · 2 tool calls · 18.1k tok";
  assert.equal(row(0), whole);
  assert.equal(row(120), whole);
});

test("fitRow: the kept head survives by dropping the tail, then ctx, then what is cut from its end", () => {
  assert.equal(row(80), "⠙ task 5  Sonnet-5.5 (high) · ctx 1% · reviewing · round 1 (1 rejection) · fast…");
  assert.equal(row(60), "⠙ task 5  Sonnet-5.5 (high) · reviewing · round 1 (1 reject…");
  for (const columns of [80, 60, 45, 30]) assert.ok(cells(row(columns)) <= columns, `${columns}: ${row(columns)}`);
});

test("fitRow: with no head to keep, what is cut first and the plain row is sliced when nothing is left", () => {
  const session = (columns) => plain(fitRow({ prefix: [{ text: "  session 3  " }], lead: [parts.model, parts.ctx], what: [{ text: "12m" }], tail: [parts.tokens] }, columns));
  assert.equal(session(80), "  session 3  Sonnet-5.5 (high) · ctx 1% · 12m · 18.1k tok");
  assert.equal(session(30), "  session 3  Sonnet-5.5 (high)");
});
