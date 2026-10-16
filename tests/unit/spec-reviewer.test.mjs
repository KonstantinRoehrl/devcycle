import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const agent = readFileSync(join(root, "agents/spec-reviewer.md"), "utf8");
const fm = agent.split(/^---\s*$/m)[1] ?? "";

test("spec-reviewer has the read-only tool allowlist and no model pin", () => {
  assert.match(fm, /name:\s*spec-reviewer/);
  assert.match(fm, /tools:\s*Read,\s*Grep,\s*Glob,\s*Bash\s*$/m);
  assert.doesNotMatch(fm, /^\s*model:/m);
});

test("granting Bash and claiming read-only, it disclaims commit and push", () => {
  assert.match(agent, /read[- ]only/i);
  assert.ok(/\bcommits?\b/i.test(agent) && /\bpush(es)?\b/i.test(agent));
});

test("its charter is the spec's repo claims checked against the working tree, never the spec's own word", () => {
  assert.match(agent, /working tree/i);
  assert.match(agent, /spec's own word/i);
  assert.match(agent, /Status: clean \| findings/);
  assert.match(agent, /session tier/i);
});
