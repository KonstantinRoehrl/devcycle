import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const text = readFileSync(new URL("../../references/handoff.md", import.meta.url), "utf8");

test("handoff block carries a Lessons read line", () => {
  assert.match(text, /- Lessons read:/);
});

test("always-clearing boundaries no longer carry Keep/Drop content", () => {
  // planning → execution always clears; its row must not carry a Keep/Drop payload.
  const row = text.split("\n").find((l) => l.includes("planning → execution"));
  assert.ok(row, "planning → execution row present");
  assert.match(row, /n\/a — clears/);
});

test("the block template gates the compaction hint to Continue boundaries (present-direction)", () => {
  // Complements the absent-on-clearing assertion: the block-template rule must state the hint is
  // PRESENT precisely when the action is `Continue`. Keyed to the block template, not the action
  // table's lone Continue row (which carries `—`), so it does not race the playbook prose edits.
  const line = text.split("\n").find((l) => l.includes("Compaction hint:"));
  assert.ok(line, "the block template carries a Compaction hint line");
  assert.match(line, /present only when the action is `Continue`/,
    "the hint's presence is gated to the Continue boundary, not emitted on clearing boundaries");
});
