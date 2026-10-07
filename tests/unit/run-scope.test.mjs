import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { activeRun, RUN_ID, STAGES } from "../../hooks/lib/run-scope.mjs";

test("activeRun: a 16-hex run and a whitelisted stage name an active run", () => {
  assert.deepEqual(activeRun("# devcycle state\n- stage: planning\n- run: 00000000000000a1\n"), { run: "00000000000000a1", stage: "planning" });
});

test("activeRun: a run id that is not 16 lowercase hex, a stage outside the whitelist, or a missing field is no active run", () => {
  for (const text of ["- stage: planning\n- run: none\n", "- stage: planning\n- run: 00000000000000A1\n",
    "- stage: done\n- run: 00000000000000a1\n", "- run: 00000000000000a1\n", ""])
    assert.equal(activeRun(text), null, JSON.stringify(text));
  assert.equal(RUN_ID.test("00000000000000a1"), true);
});

test("STAGES is the run record's stage enum, in schema order", () => {
  const schema = JSON.parse(readFileSync(new URL("../fixtures/run-record.schema.json", import.meta.url), "utf8"));
  assert.deepEqual([...STAGES], schema.oneOf.find((s) => s.title === "agent-depth").properties.stage.enum);
});

test("run-scope imports md-field-core and nothing else — the hooks module, which has no Node, loads it", () => {
  const src = readFileSync(new URL("../../hooks/lib/run-scope.mjs", import.meta.url), "utf8");
  assert.deepEqual([...src.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]), ["../../scripts/md-field-core.mjs"]);
});
