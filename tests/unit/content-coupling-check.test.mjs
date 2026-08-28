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

test("a coincidental path-suffix collision does not flag (table.mjs.bak is not table.mjs)", () => {
  const B_bak = "### Task 2: B\n**Files:**\n- Modify: `scripts/rule.mjs`\n\n- [ ] first back up to `scripts/table.mjs.bak`, then edit\n\n";
  const r = runPlan(HEADER + A + B_bak + MAP_SAME);
  assert.equal(r.status, 0, "scripts/table.mjs.bak is a different file than scripts/table.mjs and must not collide");
});

test("a coincidental path-suffix collision does not flag (a longer left-hand path is a different file)", () => {
  const B_vendor = "### Task 2: B\n**Files:**\n- Modify: `scripts/rule.mjs`\n\n- [ ] mirror `vendor/scripts/table.mjs` for the fixture\n\n";
  const r = runPlan(HEADER + A + B_vendor + MAP_SAME);
  assert.equal(r.status, 0, "vendor/scripts/table.mjs is a different file than scripts/table.mjs and must not collide");
});

test("a trailing word/dash/slash char after the path is not a boundary (table.mjs-old, table.mjsx)", () => {
  const B_dash = "### Task 2: B\n**Files:**\n- Modify: `scripts/rule.mjs`\n\n- [ ] reads the legacy `scripts/table.mjs-old` copy\n\n";
  const B_word = "### Task 2: B\n**Files:**\n- Modify: `scripts/rule.mjs`\n\n- [ ] reads the sibling `scripts/table.mjsx` module\n\n";
  const rDash = runPlan(HEADER + A + B_dash + MAP_SAME);
  assert.equal(rDash.status, 0, "scripts/table.mjs-old is a different file than scripts/table.mjs and must not collide");
  const rWord = runPlan(HEADER + A + B_word + MAP_SAME);
  assert.equal(rWord.status, 0, "scripts/table.mjsx is a different file than scripts/table.mjs and must not collide");
});

test("a genuine full-path reference still flags even alongside coincidental collisions", () => {
  const B_real = "### Task 2: B\n**Files:**\n- Modify: `scripts/rule.mjs`\n\n- [ ] references a file `scripts/table.mjs` here\n\n";
  const r = runPlan(HEADER + A + B_real + MAP_SAME);
  assert.equal(r.status, 1, "an exact path-token reference must still flag");
  assert.match(r.stderr, /Task 2 references scripts\/table\.mjs, which Task 1 edits/);
});

test("does not flag a trailing plan-level section absorbed into the last task's block (F4)", () => {
  // taskBlocks() runs the LAST task's block from its heading to end-of-file, so any trailing
  // plan-level "## " section (Dispatch Map, Blast-radius overrides, ...) is absorbed into that
  // last task's text. Task 2 here is clean in its own brief prose, but the trailing
  // "## Blast-radius overrides" section names Task 1's file `scripts/table.mjs` -- a mention
  // that belongs to the plan, not to Task 2's brief, and must not be scanned as Task 2's prose.
  const plan = HEADER + A + B_clean + MAP_SAME +
    "## Blast-radius overrides\n" +
    "- scripts/table.mjs — pre-authorized referencer <mentions scripts/table.mjs>\n";
  const r = runPlan(plan);
  assert.equal(r.status, 0, "a trailing plan-level section must not be scanned as the last task's prose");
});
