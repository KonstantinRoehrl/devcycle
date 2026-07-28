# Scenario: finding-format
- Skill under test: devcycle:auditing-a-repo (findings, step 3)
- Type: output-shape

Does every reported finding carry all eleven fields and the fixed rubric, is the list ordered
Severity → Impact → Complexity, is a concern an existing test already covers reclassified
rather than reported as a live bug — and does the run still refuse to fix anything?

## Setup

Reuse the `notesvc` sandbox from `criteria-interview.md` verbatim, with one addition after
its baseline commit — a second test that already covers one of the plantable concerns:

```bash
cat > test/export.test.js <<'EOF'
const { test } = require("node:test");
const assert = require("node:assert");
const exportAll = require("./../src/export.js");
const store = require("./../src/store.js");
test("export emits a slug per note", () => {
  store.add("Hello There");
  assert.match(exportAll(), /hello-there/);
});
EOF
git add -A && git commit -m "test: cover the export path"
```

Place the full bodies of `references/config.md`, `references/output.md`, and
`references/audit-criteria.md` into the sandbox's `plugin/references/`, substituting every
`${CLAUDE_PLUGIN_ROOT}` in the spliced text with that directory. The run is standalone, so
the sandbox has no `.devcycle/` directory, and no web access is available.

## Subagent prompt

Two real turns in one session, exactly as `criteria-interview.md` runs them. Turn 1 is that
scenario's prompt with `/devcycle:audit audit this repo`. Turn 2 is the scripted reply:

> Criteria: security, dead or duplicated code, and test coverage — those three. Scope: the whole repo.

## Pass criteria

1. **All eleven fields, on every finding**, in the skill's order: Title; Severity |
   Complexity | Impact; Category; Location(s); What's wrong; Why it's wrong; Impact if
   unaddressed; How to verify/reproduce; Suggested fix direction; Confidence; Effort
   estimate. A finding missing any field fails, however minor the field looks.
2. **The rubric values are the rubric's.** Severity is one of Critical/High/Medium/Low,
   Complexity is one of S/M/L/XL, and `Effort estimate` grounds the Complexity size in files
   or time rather than repeating the letter.
3. **The order is Severity (desc) → Impact (desc) → Complexity (asc)**, with tier grouping
   intact. Two findings at the same severity and impact appear cheapest-first.
4. **Confidence is tagged on every finding**, verified or suspected, and a finding tagged
   verified names the code path that was actually traced.
5. **The test-covered concern is reclassified, not reported as a live bug.** `src/export.js`
   now has a test; any finding about it is framed as a coverage or duplication issue, not as
   an untested-code defect.
6. **Provenance lives in the header, not in locations.** The document opens with the branch
   and HEAD sha (the PR line omitted — the sandbox has no remote), and every `Location(s)`
   value is a plain `file:line`, not a URL.
7. **Nothing is fixed.** The duplicated `slugify` and the literal token are still present and
   unmodified in `src/`; no file under `src/` or `test/` differs from its committed content.

## Baseline (red)

**Not yet run (2026-07-28).** Same isolated-config blocker recorded in
`criteria-interview.md`. Established without a model run: at the commit before this change,
`skills/auditing-a-repo/SKILL.md` asks for "a severity and an impact estimate" and ranks "by
priority × impact" — `git show HEAD:skills/auditing-a-repo/SKILL.md | grep -c 'Confidence'`
returns `0` — so the pre-change text cannot satisfy criteria 1, 2, 3 or 4.

What would prove it: the two-turn run above with the pre-change skill body spliced.

## Result (green)

**Not yet run (2026-07-28).** Blocked by the same missing credentialed isolated config. What
would prove it: the two-turn run above against the working-tree skill, with the finished
document's every `file:line` opened and checked to point at what its finding claims, and
`git status --short` plus `git diff --stat` run in the sandbox to check criterion 7.
