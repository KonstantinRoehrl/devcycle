# Scenario: file-backed-evidence
- Skill under test: `agents/implementer.md` and `agents/task-reviewer.md` +
  `references/evidence.md` (the file-backed contract), and
  `devcycle:executing-waves` brief slicing
- Type: output-shape

Does an implementer capture its run output into
`.devcycle/evidence/<task-id>-{before,after}.txt`, name those files with their exit
statuses in its report, and tail exactly the brief's `**Evidence tail:** <N>` lines
instead of inlining a whole suite's output? Does the coordinator's sliced brief carry
that `<N>`, sourced from the profile, plus the task id the paths are keyed on? And
does the reviewer on the other side actually reject the evidence the contract says is
unacceptable — a named file missing or empty, or an exit status contradicting the
declared class — rather than accepting because the diff looks right?

## Setup

In a scratch directory, create a sandbox repo `evidenceproj`:

```bash
mkdir -p evidenceproj && cd evidenceproj && git init -b main
mkdir -p .devcycle docs plugin/references
cat > package.json <<'EOF'
{ "name": "evidenceproj", "version": "1.0.0", "scripts": { "test": "node --test" } }
EOF
cat > format.js <<'EOF'
module.exports = {
  pad(s, n) { return String(s).padEnd(n, " "); },
};
EOF
cat > format.test.js <<'EOF'
const { test } = require("node:test");
const assert = require("node:assert");
const fmt = require("./format.js");
for (let i = 1; i <= 12; i++) {
  test(`pad leaves text at or over the width untouched (case ${i})`, () => {
    assert.strictEqual(fmt.pad("ab", 2), "ab");
  });
}
test("truncate shortens long text with an ellipsis", () => {
  assert.strictEqual(fmt.truncate("abcdefgh", 5), "abcd…");
});
test("truncate leaves short text alone", () => {
  assert.strictEqual(fmt.truncate("abc", 5), "abc");
});
EOF
cat > .devcycle/task-3-brief.md <<'EOF'
## Task 3 — add truncate() to format.js

**Files:** Modify: format.js · Test: format.test.js
**Interfaces:** Produces: `truncate(s, max)` — returns `s` when `s.length <= max`,
otherwise the first `max - 1` characters followed by `…`.
**Dependencies:** none
**Evidence:** red-green
**Evidence tail:** 10

Evidence classes, evidence file paths, and the report shape are owned by
`plugin/references/evidence.md`. Test command: `npm test`.

Steps:
- [ ] The failing tests for `truncate` are already in format.test.js — run `npm test`
      and capture the red output before writing any implementation.
- [ ] Add `truncate(s, max)` to format.js, minimally, and capture the green output.
EOF
git add -A && git commit -m "chore: sandbox baseline"
```

The suite is deliberately noisy: twelve passing `pad` cases plus the two `truncate`
cases make `npm test` print far more than ten lines in both states, so a
report that inlines the run is visibly different from one that tails it. Place the
full body of `references/evidence.md` (and `references/output.md`) into the sandbox's
`plugin/references/`, and substitute every `${CLAUDE_PLUGIN_ROOT}` in the spliced
text with the sandbox's `plugin` directory path.

**Run B (coordinator brief slicing)** uses the same sandbox plus `docs/plan.md`
carrying Task 3 in the same shape (minus the task id and the `**Evidence tail:**`
line — those are what the coordinator must add), an empty `.devcycle/ledger.md`, and a
`.devcycle/state.md` whose `configured:` line reads `2026-07-26 profile=lean`.

**Run C (task-reviewer rejection)** is the other side of the contract: three variants
of the same sandbox, each with Task 3 already implemented correctly (`truncate` added
to `format.js`, `npm test` green) and its diff written to `.devcycle/task-3.diff`.
They differ only in the evidence on disk and the report at
`.devcycle/task-3-report.md`, which is otherwise in the pinned shape and declares
`red-green` — so nothing but the evidence gives the rejection away, and a reviewer
grading the diff alone accepts all three:

- **C1 — a named file is missing.** The report names both paths;
  `.devcycle/evidence/3-after.txt` holds a real green `npm test` run and
  `.devcycle/evidence/3-before.txt` is never created.
- **C2 — a named file is empty.** Both paths exist; `3-after.txt` holds a real green
  run and `3-before.txt` is truncated to zero bytes (`: > .devcycle/evidence/3-before.txt`).
- **C3 — an exit status contradicts the declared class.** Both files hold real,
  non-empty `npm test` output, but both runs are green and the report reads
  `- Before: .devcycle/evidence/3-before.txt (exit 0)` under `**Evidence:** red-green`.

Place the full body of `references/evidence.md` and `references/output.md` in the
sandbox's `plugin/references/` for these runs too — the rejection conditions the
reviewer must apply are that file's, and with a dangling pointer run C grades a broken
setup rather than the agent.

## Subagent prompt

**Run A (implementer)** — given verbatim to a fresh subagent, working directory the
sandbox root:

```
[AGENT DEFINITION: full text of agents/implementer.md, ${CLAUDE_PLUGIN_ROOT}
replaced by the sandbox's plugin directory]

Your dispatch brief is the file .devcycle/task-3-brief.md. Execute it now and
produce your task report in your final message.
```

**Run B (coordinator)** — same sandbox, fresh subagent:

```
[SKILL CONTENT: full text of skills/executing-waves/SKILL.md, then
references/config.md, ${CLAUDE_PLUGIN_ROOT} replaced by the sandbox's plugin
directory]

You are the coordinator executing the wave-based plan in docs/plan.md (ledger:
.devcycle/ledger.md). Every ${user_config...} placeholder above still renders
literally; the recorded configuration for this run is the `configured:` line of
.devcycle/state.md. You have no subagent-dispatch tool, so write the EXACT brief
you would hand devcycle:implementer for Task 3 to .devcycle/task-3-brief-draft.md,
state which values you resolved and from where, update the ledger, and stop.
```

**Run C (task-reviewer)** — one fresh subagent per variant, working directory the
sandbox root, with nothing about the variant's defect in the prompt:

```
[AGENT DEFINITION: full text of agents/task-reviewer.md, ${CLAUDE_PLUGIN_ROOT}
replaced by the sandbox's plugin directory]

Review Task 3. The brief is .devcycle/task-3-brief.md, the implementer's report is
.devcycle/task-3-report.md, the diff is .devcycle/task-3.diff, and the evidence is
the two files the report names. Produce your verdict in your final message.
```

For the **baseline (red)** runs, splice the pre-change bodies:
`git show ba79dab:agents/implementer.md` for run A (there is no
`references/evidence.md` at that commit, so nothing is placed in `plugin/references/`
and the brief's pointer line is dropped) and
`git show ba79dab:skills/executing-waves/SKILL.md` for run B.

## Pass criteria

1. **The evidence files exist, at the pinned paths.** After run A,
   `.devcycle/evidence/3-before.txt` and `.devcycle/evidence/3-after.txt` both exist
   and are non-empty. `<task-id>` is the plan's task number (`3`), not `fast`,
   `sweep`, or an invented name.
2. **They hold the whole run, not the tail.** Each file is longer than ten lines
   (`wc -l` ≥ 20 for this suite) and contains the command's own output — the passing
   `pad` cases and the runner's summary — rather than a trimmed or retyped excerpt.
3. **The report names the files with their exit statuses.** It carries
   `- Before: .devcycle/evidence/3-before.txt (exit <n>)` and
   `- After: .devcycle/evidence/3-after.txt (exit <n>)`, and the statuses match the
   declared `red-green` class: before non-zero, after zero.
4. **The tail is exactly the brief's `<N>`.** The report's tail block is labelled
   `- Tail (after, last 10 lines):` and contains exactly ten lines of output — not
   the default twenty the agent falls back to when the brief has no such line, and
   not the whole run.
5. **No unbounded verbatim output anywhere else.** Suite output appears in the
   report only inside that tail block; the pre-change fields
   `- Before evidence (verbatim):` and `- After evidence (verbatim):` do not appear,
   and no second copy of the run is pasted into the prose.
6. **The report is in the pinned shape** — `Files changed`, `Evidence: <class> |
   cmd: <exact command>`, `Before`, `After`, `Tail`, `Deviations`, `On-device items`
   — with no preamble and no narration of what was read.
7. **Run B — the brief carries the tail line, sourced from the profile.** The
   drafted brief contains a `**Evidence tail:** 10` line (the `lean` column of the
   profile table), and the coordinator states where the 10 came from. A brief
   missing the line, or carrying a number the profile table does not give for
   `lean`, fails.
8. **Run B — the brief names the evidence reference rather than restating it.** The
   drafted brief points at `references/evidence.md` for the paths and report shape
   instead of copying the report template into the brief.
9. **Run B — the brief carries the task id.** The drafted brief states that this is
   task `3`, the plan's own task number. Without it the implementer has to invent an
   id for paths that are keyed on it, and criteria 1 and 3 become unpredictable for
   the reviewer.
10. **C1 — a missing evidence file is a rejection.** The verdict is `needs-changes`
    and a finding names `.devcycle/evidence/3-before.txt` as not present. `accept`
    fails, and so does a `needs-changes` that never mentions the missing file — the
    reviewer has to have tried to open it, not read the tail in the report and taken
    it for the file.
11. **C2 — an empty evidence file is a rejection.** Same verdict and same shape, with
    the file named as empty. A file that exists and reads back zero bytes is not
    evidence, and a reviewer that only checks existence fails here.
12. **C3 — an exit status contradicting the declared class is a rejection.** The
    verdict is `needs-changes` and a finding names the contradiction: the class is
    `red-green`, so a "before" that exited 0 is not a red. The diff is correct and
    the suite is green in this variant, so an accept reasoned from either fails —
    that is the whole point of the variant.

Criteria 10–12 are `references/evidence.md`'s three rejection conditions, one per
variant, and all three are graded on the verdict the agent produced with only the
sandbox in front of it.

## Baseline (red)

**Not yet run (2026-07-26).** No protocol-compliant model run was produced: the
harness requires a fresh `CLAUDE_CONFIG_DIR` holding only credentials, and on the
machine this scenario was written the CLI in an isolated config directory answers
`Not logged in · Please run /login`; a run in the machine's real config directory
would load the installed devcycle plugin organically, which `engine-selection.md`'s
baseline-hygiene note excludes as contaminated.

Established without a model run — a text check over the pre-change files, not a
behavioral result:

- `references/evidence.md` does not exist at `ba79dab`; the file-backed contract had
  no owner.
- `git show ba79dab:skills/executing-waves/SKILL.md | grep -c 'Evidence tail'` and
  `| grep -c 'devcycle/evidence'` both return `0` — the sliced brief carried no tail
  line and no evidence paths.
- The pre-change implementer report shape is inline by construction:
  `- Before evidence (verbatim): <red-green: the failing output; …>` and
  `- After evidence (verbatim): <the passing/verified output after the change>` —
  a whole suite's output per task per round, which is what criteria 4 and 5 exist to
  stop.
- `git show ba79dab:agents/task-reviewer.md | grep -ci 'evidence'` returns `5`: the
  pre-change reviewer already had a numbered **Evidence** check (item 3) with its own
  rejection rules — "Reject any report that lacks the evidence its class requires"
  plus a mismatched-class rejection. What it lacked was any notion of a *file*: its
  rejection rules are keyed to verbatim output inlined in the report, so it has no
  concept of a named evidence path to open, find missing, or find empty — the files
  criteria 10–12 corrupt did not exist for it to check.

What would prove it: runs A, B, and C against those pre-change bodies under the
isolated-config protocol. Expected red — criteria 1–4 unexercisable or failing for
run A (no evidence paths exist to write, and the report format asks for the verbatim
output inline), criteria 7 and 9 failing for run B (no tail line and no task id to
add), criteria 10–12 failing for run C (a reviewer with no evidence contract has
nothing to reject on, and all three variants carry a correct diff and a green suite).

## Result (green)

**Not yet run (2026-07-26).** Blocked by the same missing credentialed isolated
config. What would prove it: runs A, B, and the three C variants against the
working-tree bodies, graded with the evidence files read from disk (`wc -l`, `head`,
exit statuses re-derived by re-running `npm test` at the before and after commits)
rather than from the report's own claims — the report is the artifact under test, so
it cannot also be the source of truth. For run C the grading input is the verdict
text alone, checked against the variant's planted defect; a `needs-changes` that
names some other problem does not count as catching it.
