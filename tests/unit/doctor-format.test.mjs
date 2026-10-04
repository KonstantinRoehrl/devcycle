// The text helpers doctor.mjs and doctor-overview.mjs share. Pure: each takes a value and returns
// text, so a test pins the rendering from a hand-built input.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  usd, markdownTable, deltaText, cohortSessionsText, directionLine, directionPhrase,
  unpricedMediansNote,
} from "../../scripts/doctor-format.mjs";

test("usd keeps four decimals below a dollar and two from a dollar up", () => {
  assert.equal(usd(0.05), "$0.0500");
  assert.equal(usd(0.99996), "$1.0000");
  assert.equal(usd(1), "$1.00");
  assert.equal(usd(12.345), "$12.35");
});

test("markdownTable renders header, separator and rows, and an absent cell as an em dash, never a blank", () => {
  assert.deepEqual(markdownTable(["A", "B"], [[1, null]], "unused"), ["| A | B |", "| --- | --- |", "| 1 | — |"]);
  assert.deepEqual(markdownTable(["A"], [[undefined], [""], [0]], "unused").slice(2), ["| — |", "| — |", "| 0 |"]);
  // An empty table says why it is empty.
  assert.deepEqual(markdownTable(["A"], [], "nothing recorded"), [
    "| A |", "| --- |", "", "_No rows: nothing recorded._",
  ]);
});

test("deltaText names why a comparison was not taken, and never falls back to 0%", () => {
  assert.equal(deltaText({ state: "compared", pct: 12.34 }), "+12.3%");
  assert.equal(deltaText({ state: "compared", pct: -5 }), "-5.0%");
  assert.equal(deltaText({ state: "first-seen", pct: null }), "first seen");
  assert.equal(deltaText({ state: "not-compared", pct: null }), "not compared");
  assert.equal(deltaText({ state: "not-compared", pct: null, reason: "unpriced" }), "not compared (⚠ unpriced)");
});

test("deltaText ignores a reason on a delta that was in fact compared", () => {
  assert.equal(deltaText({ state: "compared", pct: 1, reason: "unpriced" }), "+1.0%");
});

test("cohortSessionsText marks a low-confidence row with the band it was judged against", () => {
  assert.equal(cohortSessionsText({ sessions: 2, lowConfidence: true }, 3), "2 (low confidence: n<3)");
  assert.equal(cohortSessionsText({ sessions: 2, lowConfidence: true }, 5), "2 (low confidence: n<5)");
  assert.equal(cohortSessionsText({ sessions: 7, lowConfidence: false }, 3), "7");
});

test("directionLine states a determined direction with its evidence", () => {
  const line = directionLine({
    direction: "down", deltaPct: -50, matchKey: "standard|feature|M", from: "0.11.0", to: "0.12.0",
  });
  assert.equal(line, "Direction of travel: down (-50.0% median cost, standard|feature|M, 0.11.0→0.12.0)");
  assert.equal(
    directionLine({ direction: "up", deltaPct: 30, matchKey: "k", from: "1", to: "2", inferred: "3 requests" }),
    "Direction of travel: up (30.0% median cost, k, 1→2) (inferred: 3 requests)",
  );
});

test("directionLine says undetermined when the corpus cannot say, never a guessed direction (#44)", () => {
  const direction = { direction: "insufficient-data", deltaPct: null, reason: "no matched cohort spans two versions with n>=3" };
  assert.equal(directionLine(direction), "Direction of travel: undetermined (no matched cohort spans two versions with n>=3)");
  assert.doesNotMatch(directionLine(direction), /\b(up|down|flat)\b|insufficient/);
  assert.equal(directionPhrase(direction), "undetermined (no matched cohort spans two versions with n>=3)");
});

test("unpricedMediansNote names the versions whose medians leave out unpriced requests", () => {
  assert.equal(
    unpricedMediansNote(["0.12.0", "0.13.0"]),
    "_Medians for 0.12.0, 0.13.0 leave out requests on a model with no exact price (inferred) — compare across them with care._",
  );
});

test("doctor-format is a leaf: it imports nothing and carries no shebang or CLI argument text", () => {
  const text = readFileSync(new URL("../../scripts/doctor-format.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(text, /^\s*import\b/m);
  assert.ok(!text.startsWith("#!"));
  assert.ok(!text.includes("process.argv"));
});
