import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = join(process.cwd(), "scripts/budget-fixture-check.mjs");

function run(planText) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "bfc-")));
  const plan = join(dir, "plan.md");
  writeFileSync(plan, planText);
  const r = spawnSync("node", [SCRIPT, plan], { encoding: "utf8" });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

const PLAYBOOK_ONLY = `# Plan
### Task 1: Tweak wave planning
**Files:**
- Modify: \`playbooks/planning-waves.md\`
## Dispatch Map
- Wave 1: Task 1
`;

test("a task touching a playbook without either budget fixture names both missing fixtures", () => {
  const { code, out } = run(PLAYBOOK_ONLY);
  assert.equal(code, 1);
  assert.match(out, /tests\/fixtures\/surface-budget\.json/);
  assert.match(out, /tests\/fixtures\/context-budget\.json/);
});

const AGENT_ONLY = `# Plan
### Task 1: Tweak implementer
**Files:**
- Modify: \`agents/implementer.md\`
## Dispatch Map
- Wave 1: Task 1
`;

test("a task touching a non-playbook surface file without surface-budget.json fails on surface-budget only, not context-budget", () => {
  const { code, out } = run(AGENT_ONLY);
  assert.equal(code, 1);
  assert.match(out, /tests\/fixtures\/surface-budget\.json/);
  assert.doesNotMatch(out, /tests\/fixtures\/context-budget\.json/);
});

const PLAYBOOK_WITH_BOTH_FIXTURES = `# Plan
### Task 1: Tweak wave planning
**Files:**
- Modify: \`playbooks/planning-waves.md\`
- Modify: \`tests/fixtures/surface-budget.json\`
- Modify: \`tests/fixtures/context-budget.json\`
## Dispatch Map
- Wave 1: Task 1
`;

test("a task touching a playbook with both budget fixtures declared passes clean", () => {
  const { code, out } = run(PLAYBOOK_WITH_BOTH_FIXTURES);
  assert.equal(code, 0, out);
  assert.match(out, /ok/);
});

const NON_SURFACE_ONLY = `# Plan
### Task 1: Add a helper
**Files:**
- Create: \`scripts/helper.mjs\`
- Test: \`tests/unit/helper.test.mjs\`
## Dispatch Map
- Wave 1: Task 1
`;

test("a task touching only scripts/ and tests/ (non-surface) needs no budget fixture", () => {
  const { code, out } = run(NON_SURFACE_ONLY);
  assert.equal(code, 0, out);
});

const PLAYBOOK_WITH_OVERRIDE = `# Plan
### Task 1: Tweak x
**Files:**
- Modify: \`playbooks/x.md\`
- Budget-fixture override: playbooks/x.md — copy-only, no growth
## Dispatch Map
- Wave 1: Task 1
`;

test("an override keyed on the surface path clears both missing-fixture violations for it", () => {
  const { code, out } = run(PLAYBOOK_WITH_OVERRIDE);
  assert.equal(code, 0, out);
});

const PLAYBOOK_WITH_REASONLESS_OVERRIDE = `# Plan
### Task 1: Tweak x
**Files:**
- Modify: \`playbooks/x.md\`
- Budget-fixture override: playbooks/x.md
## Dispatch Map
- Wave 1: Task 1
`;

test("an override with no reason is a malformed-override error", () => {
  const { code, out } = run(PLAYBOOK_WITH_REASONLESS_OVERRIDE);
  assert.equal(code, 1);
  assert.match(out, /malformed override/i);
});

test("a plan with no task headings is a parse failure, not an ok", () => {
  const { code, out } = run("# Prose only, no tasks\n");
  assert.equal(code, 1);
  assert.match(out, /no "### Task N" blocks found/);
});

const REFERENCE_ONLY = `# Plan
### Task 1: Extend the evidence contract
**Files:**
- Modify: \`references/evidence.md\`
- Modify: \`tests/fixtures/surface-budget.json\`
## Dispatch Map
- Wave 1: Task 1
`;

test("a reference edit needs context-budget.json too — a playbook's context budget counts the references it cites", () => {
  const { code, out } = run(REFERENCE_ONLY);
  assert.equal(code, 1);
  assert.match(out, /tests\/fixtures\/context-budget\.json/);
});
