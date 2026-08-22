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
  assert.match(pb, /at most 6|6 total/i);
  assert.match(pb, /hard stop|20%/i);
});

test("still read-only: starts no cycle, writes no state file", () => {
  assert.match(pb, /read-only/i);
  assert.match(pb, /starts no cycle|no .*state file/i);
});
