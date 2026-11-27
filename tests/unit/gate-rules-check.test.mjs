import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { writeInto } from "./helpers.mjs";
import { gateRulesLeg, loadGateRules, GATE_RULES_PATH, DEPRECATED_ALIAS_NOTE } from "../../scripts/gate-rules-check.mjs";

// devcycle's own rules file, so these cases pin the chain this repo declares.
const RULES = readFileSync(new URL("../fixtures/gate-rules.json", import.meta.url), "utf8");

function run(planText, { rules = RULES } = {}) {
  const repo = realpathSync(makeTempDir("grc-"));
  if (rules !== null) writeInto(repo, GATE_RULES_PATH, rules);
  const r = gateRulesLeg(planText, { planPath: "plan.md", repoRoot: repo });
  return { code: r.findings.length ? 1 : 0, out: [...r.findings, ...r.notes, r.ok].join("\n"), ...r };
}

const planWith = (...lines) => ["# Plan", "### Task 1: Thing", "**Files:**", ...lines, "## Dispatch Map", "- Wave 1: Task 1", ""].join("\n");

const PLAYBOOK_ONLY = planWith("- Modify: `playbooks/planning-waves.md`");
const AGENT_ONLY = planWith("- Modify: `agents/implementer.md`");
const PLAYBOOK_WITH_BOTH_FIXTURES = planWith(
  "- Modify: `playbooks/planning-waves.md`",
  "- Modify: `tests/fixtures/surface-budget.json`",
  "- Modify: `tests/fixtures/context-budget.json`",
  "- Modify: `docs/decisions/README.md`",
);
const FIXTURES_WITHOUT_LOG = PLAYBOOK_WITH_BOTH_FIXTURES.replace("- Modify: `docs/decisions/README.md`\n", "");

test("a task touching a playbook without either budget fixture names both missing fixtures", () => {
  const { code, out } = run(PLAYBOOK_ONLY);
  assert.equal(code, 1);
  assert.match(out, /tests\/fixtures\/surface-budget\.json/);
  assert.match(out, /tests\/fixtures\/context-budget\.json/);
});

test("an agent edit needs context-budget.json too — check 15 counts an agent among a reference's readers", () => {
  const { code, out } = run(AGENT_ONLY);
  assert.equal(code, 1);
  assert.match(out, /Task 1 edits agents\/implementer\.md but its Files omit tests\/fixtures\/surface-budget\.json/);
  assert.match(out, /Task 1 edits agents\/implementer\.md but its Files omit tests\/fixtures\/context-budget\.json/);
});

test("an agent edit listing the line budget and the log but not context-budget.json fails", () => {
  const { code, out } = run(planWith("- Modify: `agents/implementer.md`", "- Modify: `tests/fixtures/surface-budget.json`", "- Modify: `docs/decisions/README.md`"));
  assert.equal(code, 1, out);
  assert.match(out, /Task 1 edits agents\/implementer\.md but its Files omit tests\/fixtures\/context-budget\.json/);
  assert.doesNotMatch(out, /omit tests\/fixtures\/surface-budget\.json|omit docs\/decisions/);
});

test("a task touching a playbook with both budget fixtures and the decisions log declared passes clean", () => {
  const { code, out } = run(PLAYBOOK_WITH_BOTH_FIXTURES);
  assert.equal(code, 0, out);
  assert.match(out, /ok/);
});

test("a task modifying only scripts/ and tests/ (non-surface) needs no budget fixture", () => {
  const { code, out } = run(planWith("- Modify: `scripts/helper.mjs`", "- Test: `tests/unit/helper.test.mjs`"));
  assert.equal(code, 0, out);
});

test("an override keyed on the surface path clears both missing-fixture violations for it", () => {
  const { code, out } = run(planWith("- Modify: `playbooks/x.md`", "- Gate-rule override: playbooks/x.md — copy-only, no growth"));
  assert.equal(code, 0, out);
});

test("an override in a plan-level section after the last task clears the missing-fixture violations", () => {
  const plan = planWith("- Modify: `playbooks/x.md`") + "\n## Plan-check overrides\n- Gate-rule override: playbooks/x.md — copy-only, no growth\n";
  const { code, out } = run(plan);
  assert.equal(code, 0, out);
});

test("an override with no reason is a malformed-override finding", () => {
  const { code, out } = run(planWith("- Modify: `playbooks/x.md`", "- Gate-rule override: playbooks/x.md"));
  assert.equal(code, 1);
  assert.match(out, /malformed override/i);
});

test("a plan with no task headings is a parse failure, not an ok", () => {
  const { code, out } = run("# Prose only, no tasks\n");
  assert.equal(code, 1);
  assert.match(out, /no "### Task N" blocks found/);
});

test("a reference edit needs context-budget.json too — a playbook's context budget counts the references it cites", () => {
  const { code, out } = run(planWith("- Modify: `references/evidence.md`", "- Modify: `tests/fixtures/surface-budget.json`"));
  assert.equal(code, 1);
  assert.match(out, /tests\/fixtures\/context-budget\.json/);
});

test("a command edit needs context-budget.json too — a command is an entry point with its own context budget", () => {
  const { code, out } = run(planWith("- Modify: `commands/x.md`", "- Modify: `tests/fixtures/surface-budget.json`", "- Modify: `docs/decisions/README.md`"));
  assert.equal(code, 1);
  assert.match(out, /Task 1 edits commands\/x\.md but its Files omit tests\/fixtures\/context-budget\.json/);
});

test("a task that bumps the budget fixtures but omits the decisions log fails once, naming the log", () => {
  const { code, out } = run(FIXTURES_WITHOUT_LOG);
  assert.equal(code, 1);
  assert.equal(out.match(/omit docs\/decisions\/README\.md/g)?.length, 1, out);
  assert.match(out, /every fixture change needs a budget: line there/);
});

test("a task listing only a budget fixture still needs the decisions log", () => {
  const { code, out } = run(planWith("- Modify: `tests/fixtures/surface-budget.json`"));
  assert.equal(code, 1);
  assert.match(out, /Task 1 edits tests\/fixtures\/surface-budget\.json but its Files omit docs\/decisions\/README\.md/);
});

test("the decisions log follows the fixture's override: overriding the fixture or the log clears it", () => {
  const fixtureOverrides = planWith(
    "- Modify: `agents/implementer.md`",
    "- Gate-rule override: tests/fixtures/surface-budget.json — wording only, no growth",
    "- Gate-rule override: tests/fixtures/context-budget.json — cites no reference, so no closure moves",
  );
  assert.equal(run(fixtureOverrides).code, 0, run(fixtureOverrides).out);
  const logOverride = FIXTURES_WITHOUT_LOG.replace(
    "## Dispatch Map",
    "- Gate-rule override: docs/decisions/README.md — lowering only, no raise to record\n## Dispatch Map",
  );
  const { code, out } = run(logOverride);
  assert.equal(code, 0, out);
});

test("a gap's remedy gives the missing file's own reason and keys the override on that file, never on the edited surface file", () => {
  const log = run(FIXTURES_WITHOUT_LOG);
  assert.equal(log.code, 1);
  assert.match(
    log.out,
    /omit docs\/decisions\/README\.md — add it \(every fixture change needs a budget: line there\) or record a "- Gate-rule override: docs\/decisions\/README\.md — <reason>"/,
  );
  const fixture = run(AGENT_ONLY);
  assert.match(
    fixture.out,
    /omit tests\/fixtures\/surface-budget\.json — add it \(growth needs a baseline bump\) or record a "- Gate-rule override: tests\/fixtures\/surface-budget\.json — <reason>"/,
  );
  assert.doesNotMatch(log.out + fixture.out, /override: (?:playbooks|agents)\//);
});

test("a skill edit needs both budget fixtures — a SKILL.md is surface and an entry point", () => {
  const { code, out } = run(planWith("- Create: `skills/x/SKILL.md`"));
  assert.equal(code, 1);
  assert.match(out, /Task 1 edits skills\/x\/SKILL\.md but its Files omit tests\/fixtures\/surface-budget\.json/);
  assert.match(out, /Task 1 edits skills\/x\/SKILL\.md but its Files omit tests\/fixtures\/context-budget\.json/);
});

// --- the deprecated alias ---

test("the old Budget-fixture override line still clears, with a deprecation note", () => {
  const r = run(planWith("- Modify: `playbooks/x.md`", "- Budget-fixture override: playbooks/x.md — copy-only, no growth"));
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.notes, [DEPRECATED_ALIAS_NOTE]);
});

test("a reasonless Budget-fixture override is still malformed", () => {
  const { code, out } = run(planWith("- Modify: `playbooks/x.md`", "- Budget-fixture override: playbooks/x.md"));
  assert.equal(code, 1);
  assert.match(out, /malformed override/i);
});

// --- the created-script rule (#505 stop 3) ---

const CREATES_SCRIPT = planWith("- Create: `scripts/new.mjs`", "- Modify: `scripts/other.mjs`", "- Test: `tests/unit/new.test.mjs`");

test("a task creating a script with no surface file in its Files fails, naming the surface globs", () => {
  const { code, out } = run(CREATES_SCRIPT);
  assert.equal(code, 1, out);
  assert.match(out, /Task 1 creates scripts\/new\.mjs but its Files name none of commands\/\*\.md, playbooks\/\*\.md, references\/\*\.md/);
  assert.match(out, /record a "- Gate-rule override: scripts\/new\.mjs — <reason>"/);
});

test("a Gate-rule override naming the importer clears a module-only script", () => {
  const { code, out } = run(CREATES_SCRIPT.replace("## Dispatch Map", "- Gate-rule override: scripts/new.mjs — module only; imported by scripts/other.mjs\n## Dispatch Map"));
  assert.equal(code, 0, out);
});

test("a rule-id override clears that rule for the task", () => {
  const { code, out } = run(CREATES_SCRIPT.replace("## Dispatch Map", "- Gate-rule override: created-script-needs-surface-caller — module only\n## Dispatch Map"));
  assert.equal(code, 0, out);
});

test("another script in Files never satisfies the surface rule; a modified script never triggers it", () => {
  assert.equal(run(planWith("- Create: `scripts/new.mjs`", "- Create: `scripts/b.mjs`")).code, 1);
  assert.equal(run(planWith("- Modify: `scripts/new.mjs`")).code, 0);
});

test("the stop-3 replay: listing the reference that invokes the script then demands both fixtures and the log", () => {
  const { code, out } = run(planWith("- Create: `scripts/move-cycle.mjs`", "- Modify: `scripts/stage-log.mjs`", "- Modify: `references/resume.md`"));
  assert.equal(code, 1, out);
  assert.doesNotMatch(out, /name none of/);
  assert.match(out, /Task 1 edits references\/resume\.md but its Files omit tests\/fixtures\/surface-budget\.json/);
  assert.match(out, /Task 1 edits references\/resume\.md but its Files omit tests\/fixtures\/context-budget\.json/);
  assert.match(out, /Task 1 edits references\/resume\.md but its Files omit docs\/decisions\/README\.md/);
});

// --- the rules file itself ---

test("a repo with no rules file passes the same plan with one note", () => {
  const r = run(PLAYBOOK_ONLY, { rules: null });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.notes, [`no ${GATE_RULES_PATH} in this repo -- no gate rules to check`]);
});

test("a malformed rules file is a finding, never a silent pass", () => {
  assert.match(run(PLAYBOOK_ONLY, { rules: "{ not json" }).out, /tests\/fixtures\/gate-rules\.json is not valid JSON/);
  assert.match(run(PLAYBOOK_ONLY, { rules: '{"version": 2, "rules": []}' }).out, /must be \{"version": 1, "rules": \[\.\.\.\]\}/);
  const noWhy = JSON.stringify({ version: 1, rules: [{ id: "a", when: { touches: ["x/*.md"] }, require: ["y.json"] }] });
  assert.match(run(PLAYBOOK_ONLY, { rules: noWhy }).out, /a: needs a non-empty "why"/);
  const both = JSON.stringify({ version: 1, rules: [{ id: "a", when: { touches: ["x"] }, require: ["y"], requireOneOf: ["z"], why: "w" }] });
  assert.match(run(PLAYBOOK_ONLY, { rules: both }).out, /a: needs exactly one of "require" or "requireOneOf"/);
  const typo = JSON.stringify({ version: 1, rules: [{ id: "a", when: { touches: ["x"] }, requires: ["y"], why: "w" }] });
  assert.match(run(PLAYBOOK_ONLY, { rules: typo }).out, /rules\[0\] has unknown key\(s\) requires/);
  const dup = JSON.stringify({ version: 1, rules: [{ id: "a", when: { touches: ["x"] }, require: ["y"], why: "w" }, { id: "a", when: { creates: ["x"] }, require: ["y"], why: "w" }] });
  assert.match(run(PLAYBOOK_ONLY, { rules: dup }).out, /duplicate rule id "a"/);
  for (const r of [run(PLAYBOOK_ONLY, { rules: "{ not json" })]) assert.equal(r.code, 1);
});

test("loadGateRules returns no rules and no error for a repo without the file", () => {
  assert.deepEqual(loadGateRules(realpathSync(makeTempDir("grc-empty-"))), { rules: null, error: null });
});
