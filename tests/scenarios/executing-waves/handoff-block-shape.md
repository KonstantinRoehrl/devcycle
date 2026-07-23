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
   present and non-empty — and at this wave→wave boundary the first field is
   `Wave completed: 1 of 2 (stage: execution)` (`Stage completed:` is reserved
   for true stage ends; these are the only two sanctioned first-field labels) —
   followed by `Artifacts:`, `Carry-overs:`, `Context action:`,
   `Compaction hint:`.
2. `Context action` is a wave→wave action from the pipeline table —
   `Continue` or `Compact with hint` — NOT `Clear + /devcycle:continue` and
   NOT `Fresh session` (the plan still has wave 2 to run in this session).
3. `Compaction hint` has Keep/Drop shape and matches the wave-boundary row:
   Keep names ledger/plan paths, pinned interfaces or dispatch map, and wave
   status; Drop names implementer transcripts and/or resolved findings.
4. `Artifacts` lists concrete paths (one per line) including the ledger
   and/or task 1's report/commit — not prose summaries.
5. *(Tail-of-pipeline variant — setup and prompt in `## Regression (dry-run
   fixes)` below; exercises `commands/cycle.md` stage boundaries plus the
   handoff sections of `reviewing-the-branch` and `verifying-on-device`.)*
   When branch-review, on-device (judged not applicable — no rendered
   surface), and finish all complete in a single session/response, the output
   contains a separate `## Handoff` block for EACH of those stages, in order
   — the on-device block present with the skip recorded as the stage outcome
   — never one merged or final-only block, and never a skip recorded in
   prose or the state file alone.
6. At the wave boundary the agent updates `.devcycle/state.md` with
   `stage: execution` — waves remain, and `stage:` records the stage the
   next session should RESUME at, never the stage just completed.

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

## Regression (dry-run fixes)

Criterion 5 added 2026-07-23 after the v0.2.1 end-to-end dry run's rough edge #4:
the final session collapsed branch-review → on-device-skip → finish into one
response and emitted no `## Handoff` blocks for those stages (dry-run report). All
runs: fresh headless subagents (`claude -p`, model `claude-sonnet-5`), isolated
config (fresh CLAUDE_CONFIG_DIR holding only auth; init event confirmed
`plugins: []`), sandboxes in session-temp directories.

**Criterion 5 variant setup:** a minimal Node sandbox captured with execution
complete — branch `add-slugify-helper` holding spec, plan, an implemented
`src/slugify.js` + passing `node:test` suite, a four-event ledger ending in
`event=committed`, and `.devcycle/state.md` at `stage: execution`. Prompt: full
bodies of `commands/cycle.md`, `skills/reviewing-the-branch/SKILL.md`, and
`skills/verifying-on-device/SKILL.md` spliced in; environment notes (code-review
skill unavailable; no subagent-dispatch tool — perform the reviewer role
directly and disclose; all userConfig placeholders literal); "no human is
available: proceed autonomously through ALL remaining pipeline stages … in this
single session."

- Baseline (red) — scripted run 2026-07-23 against the previous committed text:
  FAIL, reproducing the dry-run failure class. The session ran a substantive
  degraded-and-disclosed branch review (verdict pass), recorded the on-device
  skip in prose and the state file, and finished under `local-commits-only` —
  but emitted exactly ONE `## Handoff` block (`Stage completed: finish`).
  Branch-review and on-device got no blocks; the skip lived in prose, not in a
  handoff.
- Result (green) — run 2026-07-23 against the fixed text (cycle.md
  one-block-per-completed-stage rule; per-stage handoff hardening in both stage
  skills): PASS — three separate `## Handoff` blocks in stage order:
  `Stage completed: branch-review` (engine line disclosing the degraded,
  self-performed review; `Context action: Fresh session`), `Stage completed:
  on-device` with the skip AS the outcome (`Artifacts: none (no rendered
  surface — src/slugify.js is a plain CommonJS function …)`, carry-overs naming
  the skip reason), and `Stage completed: finish` closing the pipeline under the
  default git policy. The state file was updated at each transition; no merged
  or final-only block.

**Criteria 1–4 re-run** 2026-07-23 against the fixed `executing-waves` text
(original Setup and prompt): all PASS, no regression — five-field `## Handoff`
block; `Context action: Continue` (wave 2 remains in-session); Keep/Drop naming
ledger/plan paths, the pinned `greet(name)` interface, wave status / dropped
task-1 transcripts; Artifacts listing concrete paths (ledger, plan, report,
`.devcycle/state.md`, and the committed files with their sha — the same
accepted one-line compression the Task 12 regression recorded).

## Regression (review-fixes)

Criterion 1 updated and criterion 6 added 2026-07-23 after the review-fixes
bundle sanctioned `Wave completed: <n> of <m> (stage: execution)` as the
wave→wave first field (`Stage completed:` reserved for true stage ends; only
two sanctioned labels) and pinned `stage:` = resume-at semantics for the
boundary state write. Both runs: fresh headless subagents (`claude -p`, model
`claude-sonnet-5`), isolated config (fresh CLAUDE_CONFIG_DIR holding only
auth, keychain-refreshed per the runner-protocol addendum; init events
confirmed `plugins: []`), sandbox rebuilt per Setup in session-temp
directories. Red = committed text (`git show
HEAD:skills/executing-waves/SKILL.md`); green = working tree.

- Baseline (red): FAIL criteria 1 and 6. The block's first field was
  `Stage completed: executing-waves (wave 1 of 2)` — the exact pre-fix label
  this scenario's own historical green runs recorded, now non-conformant —
  and the boundary state write was free-form (`Stage: executing-waves`, plus
  invented fields), not the resume-at `stage: execution`. Criteria 2–4 held
  (Context action `Continue`; Keep/Drop conformant; Artifacts concrete with
  the accepted one-line compression).
- Result (green): PASS criteria 1–4 and 6. First field verbatim
  `Wave completed: 1 of 2 (stage: execution)`; all five fields present and
  non-empty; `Context action: Continue` (wave 2 remains); Keep names
  plan/ledger paths, the pinned `greet(name)` interface, and Task 2's brief,
  Drop names task-1 implementer/reviewer transcript detail; Artifacts
  concrete (plan, ledger, `.devcycle/state.md`, committed files + sha, the
  accepted compression); `.devcycle/state.md` written at the boundary with
  `stage: execution`.
- Criterion 5 (tail-of-pipeline variant) not re-run: its
  one-block-per-completed-stage contract is unchanged by this bundle; the
  2026-07-23 dry-run-fixes evidence above stands, and the review-fixes pass
  re-exercised the branch-review block's own shape in
  `reviewing-the-branch/engine-selection.md` run C.
