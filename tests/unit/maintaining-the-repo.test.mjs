import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pb = readFileSync(join(root, "playbooks/maintaining-the-repo.md"), "utf8");

test("orientation is graph-first via the extracted helper with an Explore fallback", () => {
  assert.match(pb, /graph-availability\.mjs/);
  assert.match(pb, /Explore/);
});

test("a deterministic-facts pre-pass runs, reusing duplication-check.mjs", () => {
  assert.match(pb, /deterministic/i);
  assert.match(pb, /duplication-check\.mjs/);
});

test("orientation feeds a hotspot list to --match, not the whole tree", () => {
  assert.match(pb, /hotspot/i);
  assert.match(pb, /--match|--files/);
});

test("depth gates the lenses: standard adds abstraction, thorough adds history", () => {
  assert.match(pb, /maintenance depth/i);
  assert.match(pb, /standard[^\n]*abstraction/i);
  assert.match(pb, /thorough[^\n]*history/i);
});

test("history is dispatched at the fast tier within its traversal bound", () => {
  assert.match(pb, /history-inspector/);
  assert.match(pb, /fast tier/i);
});

test("fan-out ceiling: bounded concurrent + total lenses with a hard stop", () => {
  assert.match(pb, /at most 5|5 concurrent/i);
  assert.match(pb, /at most 8|8 total/i);
  assert.match(pb, /hard stop|20%/i);
});

test("still read-only: starts no cycle, writes no state file", () => {
  assert.match(pb, /read-only/i);
  assert.match(pb, /starts no cycle|no .*state file/i);
});

test("issue-folding: fetch is read-only via issue-intake.mjs, runs at all depths", () => {
  assert.match(pb, /issue-intake\.mjs/);
  assert.match(pb, /read-only/i);
  assert.match(pb, /all (profile )?depths|every depth|lean.*standard.*thorough/i);
});

test("decompose-before-classify, with the #44 shape as the worked example", () => {
  assert.match(pb, /decompose/i);
  assert.match(pb, /#44/);
  assert.match(pb, /before class/i);
});

test("feature-shaped fragments are excluded from ranking but counted", () => {
  assert.match(pb, /feature/i);
  assert.match(pb, /exclud/i);
  assert.match(pb, /count/i);
});

test("verification routes an in-scope fragment through existing lens methodology", () => {
  assert.match(pb, /verif/i);
  assert.match(pb, /lens methodology|whichever.*lens|existing lens/i);
});

test("issue findings merge into the same ranked list, tagged by origin", () => {
  assert.match(pb, /origin/i);
  assert.match(pb, /same (ranked )?list|alongside lens/i);
});

test("no gh issue mutation anywhere in the issue code path (playbook + script)", () => {
  const script = readFileSync(join(root, "scripts/issue-intake.mjs"), "utf8");
  assert.doesNotMatch(script, /"issue"\s*,\s*"(close|comment|edit|label|delete|reopen|transfer|pin|lock|unlock)"/);
  assert.doesNotMatch(pb, /gh\s+issue\s+(close|comment|edit|label|delete|reopen)\b/);
});
