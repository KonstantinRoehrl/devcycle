import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// This guards the routing SURFACE — the static form of the v9 brief's A25 "confusable
// surface" check. It deliberately does NOT exercise live intent→command routing, which is a
// model decision reading docs/routing.md, not a code path a node:test can run.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const routing = readFileSync(join(root, "docs/routing.md"), "utf8");
const maintainRow = routing
  .split("\n")
  .find((l) => l.trimStart().startsWith("|") && /\|\s*`?maintain`?\s*\|/.test(l));

test("routing surface: maintain has a read-only, model-invocable row", () => {
  assert.ok(maintainRow, "docs/routing.md has no `maintain` table row");
  assert.match(maintainRow, /\|\s*`?maintain`?\s*\|\s*read-only\s*\|\s*yes\s*\|/);
});

test("routing surface: maintain's row carries its distinguishing longitudinal keywords", () => {
  assert.ok(maintainRow, "docs/routing.md has no `maintain` table row");
  assert.match(maintainRow, /longitudinal|over time|health/i);
});

test("routing surface: a prose disambiguation separates maintain from review/doctor/learn", () => {
  const prose = routing
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("|") && !l.trimStart().startsWith("#"))
    .join("\n");
  assert.match(prose, /maintain/i, "no prose passage mentions maintain");
  assert.match(prose, /review/, "disambiguation must distinguish maintain from review");
  assert.ok(/doctor/.test(prose) && /learn/.test(prose), "must distinguish maintain from doctor and learn too");
  assert.match(prose, /longitudinal|over time/i, "disambiguation must name the longitudinal distinction");
});
