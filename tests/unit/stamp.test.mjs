import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { now } from "../../scripts/stamp.mjs";

const SCRIPT = new URL("../../scripts/stamp.mjs", import.meta.url).pathname;

test("now() returns a millisecond-stripped ISO-8601 UTC instant", () => {
  assert.match(now(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test("now() equals the system clock to the second", () => {
  const before = Math.floor(Date.now() / 1000);
  const stamped = Math.floor(Date.parse(now()) / 1000);
  const after = Math.floor(Date.now() / 1000);
  assert.ok(stamped >= before && stamped <= after, `${stamped} not in [${before}, ${after}]`);
});

test("the CLI prints the stamp on `stamp now`", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "now"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test("an unknown command exits non-zero", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "bogus"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown command/);
});
