# Scenario: finding-format
- Skill under test: devcycle:auditing-a-repo (findings, step 3)
- Type: output-shape

Does every reported finding carry every field the finding contract requires — the core fields
plus the document tier the audit adds — with that contract's values, is the list ordered
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

Place the full bodies of `references/config.md`, `references/output.md`,
`references/quality-criteria.md`, `references/findings.md`, and `references/branch.md` into the
sandbox's `plugin/references/`, substituting every `${CLAUDE_PLUGIN_ROOT}` in the spliced text
with that directory. `references/findings.md` is what criteria 1 through 4 are graded against:
the skill restates none of the finding contract and sends the run there for the core fields,
the severity vocabulary, the evidence discipline and the ordering, so an unreadable copy grades
a broken sandbox rather than the text. `references/branch.md` is needed here for its committing
half only. This run reaches step 5, where the document is written and committed; the skill
restates none of branch discipline and sends a standalone run to that file in full, so it has to
be readable or the run grades a broken sandbox rather than the text. The derivation half is
inert: the invocation names no branch, so the run never enters branch mode.

**Engine layer (required for the green run, added 2026-07-29).** The findings this scenario
grades are not produced by the audit skill at all: step 3 hands the sweep to
`devcycle:reviewing-code` with the confirmed criteria and the file set, and says it "neither
restates that machinery nor performs it by hand". A sandbox subagent cannot resolve a plugin
skill by name, so `skills/reviewing-code/SKILL.md` is spliced as a third block alongside the
command and the audit skill — the same block `criteria-interview.md`'s prompt now carries, which
this scenario inherits wholesale. Every criterion here grades step 3's output, so without that
block there is no sweep to produce findings and the run grades a missing skill rather than the
text. This is the sharpest case of it in the audit set: the scenario has no subject left.

Criterion 6 does not grade that rule's output, and the distinction is the whole point of the
criterion. The header carries the **audited** branch and the sha of the audited content — here
`main`, and the HEAD read during the sweep — a value step 5 of the skill owns and states is
never the topic branch the document is committed on. The committing rule matters to criterion 6
the other way round: the sandbox sits on `main`, so the rule fires and a topic branch is cut,
and that branch is precisely the wrong value a header could name. With the rule unreadable the
run has no topic branch to be tempted by, and criterion 6 grades nothing.

The run is standalone, so the sandbox has no `.devcycle/` directory, and no web access is
available.

## Subagent prompt

Two real turns in one session, exactly as `criteria-interview.md` runs them. Turn 1 is that
scenario's prompt with `/devcycle:audit audit this repo`. Turn 2 is the scripted reply:

> Criteria: security, dead or duplicated code, and test coverage — those three. Scope: the whole repo.

## Pass criteria

1. **Every field the finding contract requires, on every finding** — the core fields (Title;
   Severity; Location(s); What's wrong; Why it's wrong; Confidence; Measured against) plus
   the document tier the audit adds (Category; Impact; Complexity; Impact if unaddressed;
   How to verify/reproduce; Suggested fix direction; Effort estimate). A finding missing any
   of them fails, however minor the field looks.
2. **The values are the contract's.** Severity is one of `critical` / `high` / `medium` /
   `low`, lowercase; Complexity is one of S/M/L/XL; `Effort estimate` grounds the Complexity
   size in files or time rather than repeating the letter; and `Measured against` names a
   repo convention by path or a named external source.
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

**Not yet run (2026-07-28; red re-established 2026-07-29 for the shared finding contract).**
Same isolated-config blocker recorded in `criteria-interview.md`. Established without a model
run: at `934ecdb`, the commit before this change, `skills/auditing-a-repo/SKILL.md` carried
the eleven-field block and the `Critical / High / Medium / Low` rubric inline instead of
pointing at the shared contract — `git show 934ecdb:skills/auditing-a-repo/SKILL.md | grep -c
'references/findings.md'` returns `0` while the same grep at the post-change commit returns
`2`. That text cannot satisfy criterion 2: its rubric line reads `Severity — Critical / High /
Medium / Low`, the capitalized vocabulary the shared contract replaced, so a run following it
emits `Severity: High` and fails on the values alone. Nor criterion 1: its eleven ordered
fields do not include `Measured against` — the pre-change skill carries that only as a
free-floating prose rule further down (line 149), not as a field a finding is required to
print. Criteria 3 and 4 the pre-change text could already satisfy; they are not part of this
delta and should be recorded as not-a-delta rather than as red.

What would prove it: the two-turn run above with the pre-change skill body spliced.

## Result (green)

**Not yet run (2026-07-28).** Blocked by the same missing credentialed isolated config. What
would prove it: the two-turn run above against the working-tree skill, with the finished
document's every `file:line` opened and checked to point at what its finding claims, and
`git status --short` plus `git diff --stat` run in the sandbox to check criterion 7.
