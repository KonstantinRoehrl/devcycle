import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = join(process.cwd(), "scripts/content-coupling-check.mjs");

function runPlan(text) {
  const dir = mkdtempSync(join(tmpdir(), "coupling-"));
  const plan = join(dir, "plan.md");
  writeFileSync(plan, text, "utf8");
  const r = spawnSync("node", [SCRIPT, plan], { encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  return r;
}

const HEADER = "# P\n\n";
const A = "### Task 1: A\n**Files:**\n- Modify: `scripts/table.mjs`\n\n- [ ] step\n\n";
const B_couples = "### Task 2: B\n**Files:**\n- Modify: `scripts/rule.mjs`\n\n- [ ] reads `scripts/table.mjs` values\n\n";
const B_clean = "### Task 2: B\n**Files:**\n- Modify: `scripts/rule.mjs`\n\n- [ ] independent step\n\n";
const MAP_SAME = "## Dispatch Map\n- Wave 1: Task 1, Task 2\n";
const MAP_SEQ = "## Dispatch Map\n- Wave 1: Task 1\n- Wave 2: Task 2 (needs Task 1)\n";

test("flags a same-wave brief that names a sibling's edited file", () => {
  const r = runPlan(HEADER + A + B_couples + MAP_SAME);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Wave 1 .* Task 2 references scripts\/table\.mjs, which Task 1 edits/);
});

test("does not flag when the reference is in a later wave", () => {
  const r = runPlan(HEADER + A + B_couples + MAP_SEQ);
  assert.equal(r.status, 0);
});

test("does not flag a clean same-wave pair", () => {
  const r = runPlan(HEADER + A + B_clean + MAP_SAME);
  assert.equal(r.status, 0);
});

test("an override clears the coupling; a reasonless override is a hard error", () => {
  const ok = runPlan(HEADER + A + B_couples + MAP_SAME +
    "- Content-coupling override: Task 2 → scripts/table.mjs (Task 1) — B only reads, A only appends\n");
  assert.equal(ok.status, 0);
  const bad = runPlan(HEADER + A + B_couples + MAP_SAME +
    "- Content-coupling override: Task 2 → scripts/table.mjs (Task 1)\n");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /reason/i);
});

test("a coincidental substring does not flag (path-token precision)", () => {
  const A2 = "### Task 1: A\n**Files:**\n- Modify: `scripts/tab.mjs`\n\n- [ ] step\n\n";
  const B2 = "### Task 2: B\n**Files:**\n- Modify: `scripts/rule.mjs`\n\n- [ ] mentions the word tabulate\n\n";
  const r = runPlan(HEADER + A2 + B2 + MAP_SAME);
  assert.equal(r.status, 0, "the bare word 'tabulate' must not match scripts/tab.mjs");
});
