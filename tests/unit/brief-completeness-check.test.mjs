import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { taskFileMap } from "../../scripts/task-files.mjs";

const SCRIPT = join(process.cwd(), "scripts/brief-completeness-check.mjs");

function run(planText) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "bcc-")));
  const plan = join(dir, "plan.md");
  writeFileSync(plan, planText);
  try {
    const stdout = execFileSync("node", [SCRIPT, plan], { encoding: "utf8" });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status, out: `${e.stdout || ""}${e.stderr || ""}` };
  }
}

const COMPLETE = `# Plan
### Task 1: Thing
**Files:**
- Create: \`a.mjs\`
**Interfaces:**
- Consumes: nothing.
**Dependencies:** none (completely independent)
**Evidence:** red-green
**Quality constraints:** none
**Lessons:**
- [ ] step
## Dispatch Map
- Wave 1: Task 1 (no deps)
`;

test("passes a complete brief", () => {
  const r = run(COMPLETE);
  assert.equal(r.code, 0);
  assert.match(r.out, /ok/);
});

test("fails when Dependencies is missing", () => {
  const r = run(COMPLETE.replace("**Dependencies:** none (completely independent)\n", ""));
  assert.equal(r.code, 1);
  assert.match(r.out, /Task 1: missing \*\*Dependencies:\*\* field/);
});

test("fails on an invalid Evidence class", () => {
  const r = run(COMPLETE.replace("**Evidence:** red-green", "**Evidence:** maybe-tested"));
  assert.equal(r.code, 1);
  assert.match(r.out, /valid class/);
});

test("fails when a task is absent from the Dispatch Map", () => {
  const r = run(COMPLETE.replace("- Wave 1: Task 1 (no deps)", "- Wave 1: (none)"));
  assert.equal(r.code, 1);
  assert.match(r.out, /Task 1: not listed in the ## Dispatch Map/);
});

test("fails on an Evidence value that merely starts with a valid class name", () => {
  const r = run(COMPLETE.replace("**Evidence:** red-green", "**Evidence:** conventionally-wrong-class"));
  assert.equal(r.code, 1);
  assert.match(r.out, /valid class/);
});

test("passes a valid Evidence class with a parenthetical suffix", () => {
  const r = run(COMPLETE.replace("**Evidence:** red-green", "**Evidence:** convention (node test)"));
  assert.equal(r.code, 0);
  assert.match(r.out, /ok/);
});

const TWO_TASK = `# Plan
### Task 1: Thing
**Files:**
- Create: \`a.mjs\`
**Interfaces:**
- Consumes: nothing.
**Dependencies:** none (completely independent)
**Evidence:** red-green
**Quality constraints:** none
**Lessons:**
- [ ] step
### Task 2: Other
**Files:**
- Create: \`b.mjs\`
**Interfaces:**
- Consumes: nothing.
**Dependencies:** none (completely independent)
**Evidence:** red-green
**Quality constraints:** none
**Lessons:**
- [ ] step
## Dispatch Map
- Wave 1: Task 1
- Wave 2: Task 1 (needs Task 2)
`;

test("fails when a task appears only inside another wave's dependency parenthetical, never assigned to a wave itself", () => {
  const r = run(TWO_TASK);
  assert.equal(r.code, 1);
  assert.match(r.out, /Task 2: not listed in the ## Dispatch Map/);
});

test("fails when a required field is present but blank", () => {
  const r = run(COMPLETE.replace("**Dependencies:** none (completely independent)", "**Dependencies:**"));
  assert.equal(r.code, 1);
  assert.match(r.out, /\*\*Dependencies:\*\* field is empty/);
});

const INLINE_FILES = COMPLETE.replace("**Files:**\n- Create: `a.mjs`", "**Files:** Create `a.mjs`");

test("the Files field this gate accepts is the same one the plan gates parse", () => {
  // One grammar owns **Files:**. If this gate accepts a declaration the shared owner cannot see,
  // a plan passes brief-completeness and then dies in wave-disjointness on a "no blocks found".
  const r = run(INLINE_FILES);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual([...(taskFileMap(INLINE_FILES).get(1) ?? new Set())], ["a.mjs"]);
});

test("a missing Files field is still named as missing", () => {
  const r = run(COMPLETE.replace("**Files:**\n- Create: `a.mjs`\n", ""));
  assert.equal(r.code, 1);
  assert.match(r.out, /Task 1: missing \*\*Files:\*\* field/);
});

test("a Files field present but blank is still named as empty", () => {
  const r = run(COMPLETE.replace("**Files:**\n- Create: `a.mjs`", "**Files:**"));
  assert.equal(r.code, 1);
  assert.match(r.out, /Task 1: \*\*Files:\*\* field is empty/);
});

test("a mid-line mention of the Files label is not a Files field -- the shared-owner delegation, pinned", () => {
  // readField hands **Files:** to task-files.mjs, whose grammar anchors the label to line start;
  // this gate's own generic field regex does not. So a brief that only mentions the label in
  // prose reads as a present, non-empty field the moment that delegation is reverted.
  const prose = COMPLETE.replace(
    "**Files:**\n- Create: `a.mjs`\n",
    "Every task's **Files:** list is authoritative.\n",
  );
  const r = run(prose);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Task 1: missing \*\*Files:\*\* field/);
});

// The budget-fixture join: a brief that mandates doc growth but never lists the baseline that
// growth trips sends the implementer into a validate.mjs failure the brief itself caused.
// The join is owned by budget-fixture-check.mjs; this gate runs it as a leg so the first
// scripted check a planner runs already names the missing fixture.

const SURFACE_EDIT = COMPLETE.replace("- Create: \`a.mjs\`", "- Modify: \`playbooks/planning-waves.md\`");

test("fails when a task edits a budgeted surface file but omits the baseline fixtures that edit trips", () => {
  const r = run(SURFACE_EDIT);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Task 1: .*playbooks\/planning-waves\.md.*tests\/fixtures\/surface-budget\.json/);
  assert.match(r.out, /Task 1: .*playbooks\/planning-waves\.md.*tests\/fixtures\/context-budget\.json/);
});

test("passes once the surface edit lists both baseline fixtures", () => {
  const r = run(
    SURFACE_EDIT.replace(
      "- Modify: \`playbooks/planning-waves.md\`",
      "- Modify: \`playbooks/planning-waves.md\`\n- Modify: \`tests/fixtures/surface-budget.json\`\n- Modify: \`tests/fixtures/context-budget.json\`",
    ),
  );
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ok/);
});

test("honours the same Budget-fixture override grammar the standalone gate reads", () => {
  const r = run(
    SURFACE_EDIT.replace(
      "- Modify: \`playbooks/planning-waves.md\`",
      "- Modify: \`playbooks/planning-waves.md\`\n- Budget-fixture override: playbooks/planning-waves.md — copy-only, no growth",
    ),
  );
  assert.equal(r.code, 0, r.out);
});

test("reports a reasonless Budget-fixture override as malformed rather than silently ignoring it", () => {
  const r = run(
    SURFACE_EDIT.replace(
      "- Modify: \`playbooks/planning-waves.md\`",
      "- Modify: \`playbooks/planning-waves.md\`\n- Budget-fixture override: playbooks/planning-waves.md",
    ),
  );
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /malformed override/i);
});
