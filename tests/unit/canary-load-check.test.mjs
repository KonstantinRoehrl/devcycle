// scripts/canary-load-check.mjs: `claude plugin list --json` exits 0 even when a plugin failed to
// load (docs/platform-notes.md § (m)), so the errors field is the whole check.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { writeInto } from "./helpers.mjs";
import { loadProblems } from "../../scripts/canary-load-check.mjs";

const SCRIPT = join(process.cwd(), "scripts/canary-load-check.mjs");
const healthy = { id: "devcycle@devcycle", enabled: true };

test("the repo's real plugin list shape is healthy", () => {
  assert.deepEqual(loadProblems(JSON.parse(readFileSync("tests/fixtures/plugin-list.json", "utf8"))), []);
});

test("missing, disabled and failed devcycle are each a problem, printing the errors", () => {
  assert.match(loadProblems([{ id: "other@x", enabled: true }])[0], /not installed/);
  assert.match(loadProblems([{ ...healthy, enabled: false }])[0], /disabled/);
  assert.match(loadProblems([{ ...healthy, errors: ["manifest rejected"] }])[0], /manifest rejected/);
  assert.match(loadProblems([{ ...healthy, errors: [{ message: "bad hook" }] }])[0], /bad hook/);
  assert.deepEqual(loadProblems([{ ...healthy, errors: [] }]), []);
});

test("a list that is not an array is a problem, never a pass", () => {
  assert.match(loadProblems({ plugins: [] })[0], /not a list/);
});

test("the CLI exits 1 on a problem and on an unreadable file, 0 when healthy", () => {
  const dir = makeTempDir("canary-load-");
  const at = (name, value) => writeInto(dir, name, JSON.stringify(value));
  assert.equal(spawnSync("node", [SCRIPT, at("ok.json", [healthy])]).status, 0);
  const failed = spawnSync("node", [SCRIPT, at("bad.json", [{ ...healthy, errors: ["boom"] }])], { encoding: "utf8" });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /boom/);
  assert.equal(spawnSync("node", [SCRIPT, join(dir, "absent.json")]).status, 1);
});
