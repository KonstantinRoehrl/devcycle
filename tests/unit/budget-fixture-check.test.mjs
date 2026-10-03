import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";

const SCRIPT = join(process.cwd(), "scripts/budget-fixture-check.mjs");

function run(planText) {
  const dir = realpathSync(makeTempDir("bfc-"));
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
- Modify: \`docs/decisions/README.md\`
## Dispatch Map
- Wave 1: Task 1
`;

test("a task touching a playbook with both budget fixtures and the decisions log declared passes clean", () => {
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

const FIXTURES_WITHOUT_LOG = PLAYBOOK_WITH_BOTH_FIXTURES.replace("- Modify: \`docs/decisions/README.md\`\n", "");

test("a task that bumps the budget fixtures but omits the decisions log fails once, naming the log", () => {
  const { code, out } = run(FIXTURES_WITHOUT_LOG);
  assert.equal(code, 1);
  assert.equal(out.match(/omit docs\/decisions\/README\.md/g)?.length, 1, out);
  assert.match(out, /a fixture raise needs a budget: line there/);
});

test("a task listing only a budget fixture still needs the decisions log", () => {
  const { code, out } = run(`# Plan
### Task 1: Re-anchor
**Files:**
- Modify: \`tests/fixtures/surface-budget.json\`
## Dispatch Map
- Wave 1: Task 1
`);
  assert.equal(code, 1);
  assert.match(out, /Task 1 edits tests\/fixtures\/surface-budget\.json but its Files omit docs\/decisions\/README\.md/);
});

test("the decisions log follows the fixture's override: overriding the fixture or the log clears it", () => {
  const surfaceOverride = `# Plan
### Task 1: Tweak an agent
**Files:**
- Modify: \`agents/implementer.md\`
- Budget-fixture override: tests/fixtures/surface-budget.json — wording only, no growth
## Dispatch Map
- Wave 1: Task 1
`;
  assert.equal(run(surfaceOverride).code, 0, run(surfaceOverride).out);
  const logOverride = FIXTURES_WITHOUT_LOG.replace(
    "## Dispatch Map",
    "- Budget-fixture override: docs/decisions/README.md — lowering only, no raise to record\n## Dispatch Map"
  );
  const { code, out } = run(logOverride);
  assert.equal(code, 0, out);
});
