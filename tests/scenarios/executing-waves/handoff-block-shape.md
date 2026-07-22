# Scenario: handoff-block-shape
- Skill under test: devcycle:executing-waves
- Type: output-shape

Does a coordinator following the skill close a completed wave with a
conformant five-field handoff block carrying the wave-boundary context action
from the pipeline table?

## Setup

In a scratch directory, create a sandbox repo `handoffproj`:

```bash
mkdir -p handoffproj && cd handoffproj && git init -b main
mkdir -p docs .superpowers/sdd
cat > docs/plan.md <<'EOF'
# Plan: greeting module
## Task 1: greet function
**Files:** Create: greet.js, greet.test.js
**Interfaces:** Produces: `greet(name)` returning `"Hello, <name>!"`
**Dependencies:** none
- [ ] Failing test in greet.test.js (command: `node greet.test.js`)
- [ ] Implement greet.js to green
## Task 2: CLI wrapper
**Files:** Create: cli.js
**Interfaces:** Consumes: `greet(name)` from Task 1
**Dependencies:** Task 1 (consumes its greet interface)
- [ ] Failing test, then cli.js printing greet(argv[2])
## Dispatch Map
- Wave 1: Task 1
- Wave 2: Task 2
EOF
cat > greet.js <<'EOF'
module.exports = (name) => `Hello, ${name}!`;
EOF
cat > greet.test.js <<'EOF'
const greet = require("./greet.js");
if (greet("Ada") !== "Hello, Ada!") { console.error("FAIL"); process.exit(1); }
console.log("PASS");
EOF
cat > .superpowers/sdd/task-1-report.md <<'EOF'
## Task report
- Files changed: greet.js, greet.test.js
- Test command: node greet.test.js
- Red evidence (verbatim): FAIL
- Green evidence (verbatim): PASS
- Deviations from brief: none
- Items for the on-device checklist: none
EOF
git add -A && git commit -m "chore: sandbox baseline"
git add -A && git commit -m "feat: add greet function (task 1)" --allow-empty
cat > .superpowers/sdd/progress.md <<'EOF'
- [2026-07-22T09:00:00Z] task=1 event=dispatched outcome=implementer sent ref=none
- [2026-07-22T09:05:00Z] task=1 event=report-received outcome=red-green evidence present ref=.superpowers/sdd/task-1-report.md
- [2026-07-22T09:08:00Z] task=1 event=review-verdict outcome=accept ref=none
- [2026-07-22T09:10:00Z] task=1 event=committed outcome=task 1 committed ref=HEAD
EOF
```

Wave 1 (single task) is fully done: implemented, reviewed, green-gated,
committed, ledgered. Wave 2 has not started.

## Subagent prompt

Given verbatim to a fresh subagent (working directory: the `handoffproj`
sandbox). For the green run, the block marked SKILL CONTENT contains the full
text of `skills/executing-waves/SKILL.md`; the baseline run omits that block.

```
[SKILL CONTENT: full text of skills/executing-waves/SKILL.md]

You are the coordinator executing the wave-based plan in docs/plan.md
(ledger: .superpowers/sdd/progress.md). Wave 1 is complete: task 1 was
implemented, reviewed, green-gated, and committed — the ledger records it.
Close out wave 1 now and produce your wave-boundary output for this point in
the pipeline. Do NOT dispatch or start wave 2.
```

## Pass criteria

1. The final output contains a `## Handoff` block with all five fields, each
   present and non-empty: `Stage completed:`, `Artifacts:`, `Carry-overs:`,
   `Context action:`, `Compaction hint:`.
2. `Context action` is a wave→wave action from the pipeline table —
   `Continue` or `Compact with hint` — NOT `Clear + /devcycle:continue` and
   NOT `Fresh session` (the plan still has wave 2 to run in this session).
3. `Compaction hint` has Keep/Drop shape and matches the wave-boundary row:
   Keep names ledger/plan paths, pinned interfaces or dispatch map, and wave
   status; Drop names implementer transcripts and/or resolved findings.
4. `Artifacts` lists concrete paths (one per line) including the ledger
   and/or task 1's report/commit — not prose summaries.

## Baseline (red)

Run 2026-07-22: fresh subagent (claude-sonnet-5 via `claude -p`, isolated
settings, no skill content). FAILED criteria 1–4: the final output was a
prose wave summary with no `## Handoff` block, none of the five fields, no
context action, and no Keep/Drop compaction hint. Verbatim excerpt of the
final output's opening:

> **Wave 1 — closed.**
>
> - **Task 1 (greet function):** implemented, red→green verified
>   (`node greet.test.js`: FAIL → PASS), reviewed (verdict: accept),
>   committed at `a36c42c`. No deviations from brief, no open checklist
>   items.

It also invented a non-P3 ledger event (`wave=1 event=wave-closed`).

## Result (green)

Run 2026-07-22: fresh subagent (claude-sonnet-5 via `claude -p`, isolated
settings), same prompt WITH the skill content. PASSED criteria 1–4. The
final output ended with a conformant block (verbatim):

> ## Handoff
> - Stage completed: executing-waves (wave 1 of 2)
> - Artifacts:
>   docs/plan.md
>   .superpowers/sdd/progress.md
>   .devcycle/state.md
>   greet.js
>   greet.test.js
> - Carry-overs: Task 2 (CLI wrapper) depends on Task 1's `greet(name)`
>   interface, which is now committed and available; Task 2 creates cli.js
>   only, no file overlap with Task 1.
> - Context action: Continue
> - Compaction hint: Keep ledger path, plan path, Dispatch Map (Wave 2:
>   Task 2), and the `greet(name)` interface signature. Drop task 1
>   implementer/reviewer transcripts — resolved and committed.

All five fields present; `Continue` is the correct wave→wave action (wave 2
remains); Keep/Drop matches the wave-boundary row. The agent additionally
re-verified the green gate itself (`node greet.test.js` → PASS) and wrote
`.devcycle/state.md` with stage/branch/plan/ledger and wave status, as the
skill's wave-boundary section requires.

Re-run 2026-07-22 against the final skill text (after fresh-eyes review
edits): PASSED all criteria again — five-field `## Handoff` block, `Context
action: Continue`, Keep/Drop naming ledger/plan paths, pinned `greet`
interface, dispatch map / dropped transcripts and resolved findings, plus a
`.devcycle/state.md` with stage, branch, plan, ledger, and wave status.

## Regression (Task 12)

Run 2026-07-22 — full-pass regression against the committed text: fresh headless subagent (`claude -p`, model `claude-sonnet-5`), isolated config per the baseline-hygiene protocol (fresh CLAUDE_CONFIG_DIR holding only auth — no installed plugins, no machine-global instructions; the init event confirmed `plugins: []`), sandbox rebuilt per Setup in a session-temp directory.

- Criterion 1 PASS: five-field `## Handoff` block, all fields present and non-empty.
- Criterion 2 PASS: `Context action: Continue` — the correct wave→wave action with wave 2 remaining in-session.
- Criterion 3 PASS: Keep names ledger/plan paths, the Dispatch Map, and Task 1's committed `greet(name)` interface; Drop names task-1 implementer/reviewer transcripts ("resolved and committed").
- Criterion 4 PASS (minor variance): Artifacts lists concrete paths including the ledger, `.devcycle/state.md`, and the task-1 commit; `greet.js, greet.test.js` share one line with the commit sha rather than strictly one path per line — an accepted compression, not prose.
- Beyond the criteria, the agent wrote `.devcycle/state.md` at the boundary, as the skill's wave-boundary section requires.
- Net: GREEN — no regression.
