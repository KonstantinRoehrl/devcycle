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
