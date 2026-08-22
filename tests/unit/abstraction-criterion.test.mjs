import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const criteria = readFileSync(join(root, "references/quality-criteria.md"), "utf8");
const section = () => criteria.slice(criteria.search(/^##\s+Abstraction\b/m));

test("quality-criteria.md carries an Abstraction criterion, distinct from Reuse before rebuild", () => {
  assert.match(criteria, /^##\s+Abstraction\b/m, "no `## Abstraction` heading");
  assert.match(criteria, /^##\s+Reuse before rebuild\b/m, "Reuse before rebuild must remain, distinct");
  assert.notEqual(criteria.search(/^##\s+Abstraction\b/m), criteria.search(/^##\s+Reuse before rebuild\b/m));
});

test("the charter states KEEP as a first-class success and forbids anti-abstraction bias", () => {
  assert.match(section(), /KEEP\s*\|\s*WATCH\s*\|\s*SIMPLIFY\s*\|\s*REMOVE\s*\|\s*CONSOLIDATE/);
  assert.match(section(), /KEEP[^\n]*success/i);
  assert.match(section(), /anti-abstraction bias/i);
});

test("the charter instructs the deletion test", () => {
  assert.match(section(), /deletion test/i);
  assert.match(section(), /inlined?\b/i);
});

test("the charter names the degraded-evidence fallback and vocabulary hygiene", () => {
  assert.match(section(), /corroborating evidence, not a precondition/i);
  assert.match(section(), /historical evidence[^\n]*not[^\n]*available|state[^\n]*wasn'?t checked/i);
  assert.match(section(), /`module`.*`interface`.*`implementation`.*`seam`.*`adapter`/);
});

test("review sources its criteria from quality-criteria.md, so it picks up Abstraction automatically", () => {
  const reviewing = readFileSync(join(root, "playbooks/reviewing-code.md"), "utf8");
  assert.match(reviewing, /quality-criteria\.md/);
});
