import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const config = readFileSync(join(root, "references/config.md"), "utf8");
const row = () => config.split("\n").find((l) => /^\|\s*maintenance depth\s*\|/.test(l));

test("config.md profile matrix carries a maintenance depth row", () => {
  assert.ok(row(), "no `maintenance depth` matrix row");
});

test("maintenance depth gates lenses: existing < abstraction < history", () => {
  assert.match(row(), /existing/i);
  assert.match(row(), /abstraction/i);
  assert.match(row(), /history/i);
});

test("config.md states maintenance's deliberate workload non-participation (§M7 gap)", () => {
  assert.match(config, /workload[^\n]*run-record|no `?workload`? run-record/i);
  assert.match(config, /At a glance|EXCESS-COST/);
});
