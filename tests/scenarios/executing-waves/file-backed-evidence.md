# Scenario: file-backed-evidence
- Skill under test: `agents/implementer.md` + `references/evidence.md` (the
  file-backed contract), and `devcycle:executing-waves` brief slicing
- Type: output-shape

Does an implementer capture its run output into
`.devcycle/evidence/<task-id>-{before,after}.txt`, name those files with their exit
statuses in its report, and tail exactly the brief's `**Evidence tail:** <N>` lines
instead of inlining a whole suite's output? And does the coordinator's sliced brief
carry that `<N>`, sourced from the profile?

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
carrying Task 3 in the same shape (minus the `**Evidence tail:**` line — that line is
what the coordinator must add), an empty `.devcycle/ledger.md`, and a
`.devcycle/state.md` whose `configured:` line reads `2026-07-26 profile=lean`.

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

What would prove it: runs A and B against those pre-change bodies under the
isolated-config protocol. Expected red — criteria 1–4 unexercisable or failing for
run A (no evidence paths exist to write, and the report format asks for the verbatim
output inline), criterion 7 failing for run B (no tail line to add).

## Result (green)

**Not yet run (2026-07-26).** Blocked by the same missing credentialed isolated
config. What would prove it: runs A and B against the working-tree bodies, graded
with the evidence files read from disk (`wc -l`, `head`, exit statuses re-derived by
re-running `npm test` at the before and after commits) rather than from the report's
own claims — the report is the artifact under test, so it cannot also be the source
of truth.
