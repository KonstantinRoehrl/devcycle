# End-to-end dry run: devcycle v0.2.1

A full pipeline run — rough idea to reviewed, locally-committed implementation — performed
against the **published** devcycle v0.2.1 (installed from GitHub, not the working tree) in a
throwaway sandbox repo, driven entirely through headless `claude -p` sessions using an
isolated Claude config directory containing nothing but credentials. No pre-existing plugins,
no global user instructions, and none of the 8 `userConfig` options set — the run exercises
the documented-defaults path end to end.

**What was simulated:** headless sessions have no human, so every interview answer was
supplied by a scripted persona (a pragmatic maintainer picking defaults); all such answers
are marked below. The on-device stage had no UI to verify and was skipped by the pipeline
itself; no human walked anything. Everything else — file artifacts, git commits, test runs,
subagent dispatches — is real.

## What a fresh user has to run

The README's two install commands are not quite enough. The working sequence:

```
claude plugin marketplace add KonstantinRoehrl/devcycle
claude plugin install devcycle@devcycle
claude plugin marketplace add obra/superpowers-marketplace
```

After step 2, `claude plugin list` shows devcycle as **failed to load** with:

> Dependency "superpowers@superpowers-marketplace" is not installed — run `claude plugin
> install superpowers@superpowers-marketplace`, or check that its marketplace is added

Running that suggested install command directly fails ("Plugin not found in marketplace"),
because the superpowers *marketplace* is not added yet. Adding the marketplace (step 3)
auto-installs superpowers as devcycle's declared dependency, after which both plugins load:

```
❯ devcycle@devcycle        Version: 0.2.1   Status: ✔ enabled
❯ superpowers@…            Version: 6.1.1   Status: ✔ enabled
```

Rough edge #1: the README should carry step 3 (or the dependency chain should surface it
more directly).

## The cycle

Sandbox: a minimal Node repo (`package.json` with `"test": "node --test"`, one `src/greet.js`
helper, one passing test, single commit on `main`). Request given to the pipeline:

```
/devcycle:cycle add a slugify helper with tests
```

Plugin slash commands work as headless prompts; the interview loop was driven by resuming the
same session (`claude -p --resume <session-id>`) with the persona's answers.

### Stage 1 — scoping (`devcycle:scoping-interview`)

The session read the repo first (never asked what the repo answers), triaged the input as a
rough idea, detected that `AskUserQuestion` is unavailable headless, and engaged the skill's
fallback: one plain-message batch with the summary confirmation in slot 1 and every question
carrying concrete options plus an Other escape — then hard-stopped. Verbatim (abridged):

> **My reading:** Add a `slugify(str)` helper to `src/slugify.js` (mirroring the existing
> `src/greet.js` — CommonJS, `module.exports`) … Let me know if that's off.
>
> **1. What transformation rules should `slugify` apply?** A) Standard slug rules … B)
> Standard + transliteration … C) Minimal … Other
>
> **2. How should edge cases behave — empty string, or all special characters?** A) Return
> `""` … B) Throw an error … Other

Simulated persona answer: *"Your reading is correct … 1. A) … 2. A) Return ""."*

On resume the stage produced the scope summary, wrote `.devcycle/state.md`, named
`superpowers:brainstorming` as the next stage, and emitted its handoff block:

```markdown
## Handoff
- Stage completed: scoping
- Artifacts: none (scope summary above); `.devcycle/state.md` updated
- Carry-overs: confirmed scope — `slugify(str)` in `src/slugify.js` … No open `<tbd>` items.
- Context action: Continue
- Compaction hint: Keep everything. Drop nothing.
```

Rough edge #2: `.devcycle/state.md` was **not** created when the pipeline started — it first
appeared at the scoping→brainstorm transition. `/devcycle:cycle` says "Create it when the
pipeline starts"; a session interrupted mid-scoping would leave no state file to resume from.

### Stage 2 — brainstorm (`superpowers:brainstorming`, upstream)

One follow-up design question (non-string input handling — persona picked "assume string,
match `greet.js`"), three candidate approaches with a recommendation (regex chain — persona
accepted), a design confirmation, then the spec was written and committed on a new branch
`add-slugify-helper` (the pipeline never worked on `main`):

- `docs/superpowers/specs/2026-07-22-slugify-helper-design.md`

State file after the spec:

```markdown
# devcycle state
- stage: brainstorm
- branch: add-slugify-helper
- spec: docs/superpowers/specs/2026-07-22-slugify-helper-design.md
- plan: none
- ledger: .superpowers/sdd/progress.md
- checklist: none
```

### Stage 3 — planning (`devcycle:planning-waves`)

Announced itself, ran the feasibility gate (verdict GO — Node built-ins only), and produced
`docs/superpowers/plans/2026-07-22-slugify-helper.md`. The first draft was a single-task
plan; the persona then asked for a README documenting both helpers as a second parallel
task, and the plan was revised to a two-task, one-wave shape with explicit dependency
declarations:

```
### Task 1: Slugify helper + tests
**Dependencies:** none (completely independent)

### Task 2: Project README
**Dependencies:** none (completely independent — file-disjoint from Task 1; runs in the same wave)

## Dispatch Map
- Wave 1: Task 1, Task 2 (file-disjoint, no dependencies — Task 1 touches `src/slugify.js`
  + `test/slugify.test.js`, Task 2 touches only `README.md`)
```

The plan even pinned the parallel-safety caveat for Task 2 (do not treat Task 1's
not-yet-existing module as a bug). Planning's handoff recommended `Clear +
/devcycle:continue`, which the harness honored: execution ran as a **fresh session** with no
memory of planning.

### Stage 4 — execution (`devcycle:executing-waves`)

`/devcycle:continue` in a fresh session re-derived the position purely from files (state
file, ledger absent, plan, `git log`), then dispatched **both implementers in parallel**
(file-disjoint per the dispatch map), routed to a cheaper model with an announced
justification (the plan carries complete literal code), wrote briefs to
`.superpowers/sdd/task-{1,2}-brief.md`, and ran the TDD loop. Red→green, from the transcript:

```
# Step 2 (red, before implementation):
Exit code 1 — Error: Cannot find module '../src/slugify'

# Step 4 (green): tests 5 / pass 5 / fail 0
# Step 5 (full suite): tests 6 / pass 6 / fail 0

# Coordinator's deterministic green gate before acceptance:
=== GREEN GATE: npm test === … tests 6 / pass 6 / fail 0 / EXIT CODE: 0
```

Per-task reviewers were dispatched read-only with brief + report + diff; both accepted. The
ledger at `.superpowers/sdd/progress.md` (verbatim):

```
- [<ts>] task=1 event=dispatched outcome=implementer:claude-sonnet-5,base:184ab62… ref=none
- [<ts>] task=2 event=dispatched outcome=implementer:claude-sonnet-5,base:184ab62… ref=none
- [<ts>] task=1 event=report-received outcome=DONE,commit:4d78b2e ref=4d78b2e
- [<ts>] task=2 event=report-received outcome=DONE,commit:4ed744e ref=4ed744e
- [<ts>] task=1 event=review-verdict outcome=accepted,spec:pass,quality:approved ref=.superpowers/sdd/task-1-diff.patch
- [<ts>] task=1 event=committed outcome=green-gate:pass,review:accepted ref=4d78b2e
- [<ts>] task=2 event=review-verdict outcome=accepted,spec:pass,quality:approved ref=.superpowers/sdd/task-2-diff.patch
- [<ts>] task=2 event=committed outcome=green-gate:pass,review:accepted ref=4ed744e
```

Rough edge #3 (the run's most instructive finding): the coordinator's dispatch prompts told
the implementers to commit their own work, and they did (`4d78b2e`, `4ed744e`) — devcycle's
discipline is that implementers never commit; the coordinator commits after review + green
gate. The coordinator *caught its own mistake mid-run* ("I notice I mistakenly told both
implementers to commit…"), then compensated: diffs were produced from the commits for
review, the green gate ran deterministically, and the ledger recorded acceptance before the
`committed` events. Outcome intact, ownership inverted — the skill text survives contact
with a coordinator that half-remembers upstream's convention, but the guardrail lives only
in prose.

Execution's handoff recommended `Clear + /devcycle:continue`; honored again.

### Stage 5 — branch review (`devcycle:reviewing-the-branch`)

Fresh session, position re-derived from files. A fresh reviewer subagent was dispatched with
only branch + spec + ledger (bias control held — it never saw implementation context). The
reviewer attempted the built-in `code-review` skill, found it unavailable for programmatic
invocation, and **the graceful-degradation path engaged exactly as designed**, disclosed in
the report's engine line:

```markdown
## Branch review report
- Engine: single (degraded — `code-review` skill disabled for programmatic invocation in the
  reviewer's environment; ran a manual review per `superpowers:requesting-code-review` instead)
- Branch: `662eea3..4ed744e` (add-slugify-helper)
- Spec: `docs/superpowers/specs/2026-07-22-slugify-helper-design.md`
- Findings: 1 [low, informational] — README not mentioned by the spec's scope (plan-authorized,
  test-verified; traceability noise, not a defect)
- Verdict: pass
```

The spec-compliance layer also cross-checked the ledger against the branch (every committed
task present, nothing unaccounted).

### Stage 6 — on-device (`devcycle:verifying-on-device`)

The skill was loaded and judged **not applicable**: a pure Node helper with no rendered
surface, fully covered by `node:test`. No checklist was generated (correct per the skill —
its trigger is "the moment a task produces rendered changes", which never fired), and the
skip was recorded in the state file's `checklist:` line. To be explicit: **this stage was
not walked by a human, and there was nothing to walk.**

### Stage 7 — finish

`gitPolicy` was unset; the pipeline read the literal `${user_config…}` placeholder, fell
back to the documented default `local-commits-only`, and handed the branch back — 5 commits
ahead of `main`, no push, no PR. Final state file:

```markdown
# devcycle state
- stage: finish
- branch: add-slugify-helper
- spec: docs/superpowers/specs/2026-07-22-slugify-helper-design.md
- plan: docs/superpowers/plans/2026-07-22-slugify-helper.md
- ledger: .superpowers/sdd/progress.md
- checklist: none (no rendered/on-device surface — pure Node helper + tests)
```

Final sandbox history (all commits Conventional):

```
4ed744e docs: add project README documenting greet and slugify helpers
4d78b2e feat(slugify): add slugify helper with test coverage
184ab62 docs: add parallel README task to slugify helper plan
34b6245 docs: add implementation plan for slugify helper
333f5c3 docs: add design spec for slugify helper
662eea3 chore: initial sandbox project
```

## Rough edges found

1. **README install gap** — the superpowers marketplace add is a required third command; the
   intermediate error message's first suggestion doesn't work verbatim (see above).
2. **State file not created at pipeline start** — first written at the scoping→brainstorm
   transition; a cycle interrupted during scoping leaves nothing for `/devcycle:continue`.
3. **Commit ownership inverted under a forgetful coordinator** — implementers committed
   because the coordinator's dispatch prompts said to; self-detected but not undone. The
   review cycle, green gate, and ledger shape all still held.
4. **Missing handoff blocks at the tail of the pipeline** — the final session collapsed
   branch-review → on-device-skip → finish into one response and emitted none of the
   required `## Handoff` blocks for those stages (scoping, brainstorm, planning, and
   execution all emitted theirs correctly). The on-device skip was therefore recorded in
   prose and the state file rather than "in the handoff" as `/devcycle:cycle` specifies.
5. **Transient API drop mid-execution** — one session died with "Connection closed
   mid-response"; because files are the state, `--resume` continued cleanly with zero loss.
   Not a plugin bug; worth knowing that the files-are-state design absorbed it.

## Verdict

Every stage of the pipeline ran headless against the published plugin with defaults only:
batched scoping with the documented fallback shape, spec, feasibility-gated two-task
one-wave plan with explicit dependencies, parallel TDD execution with a deterministic green
gate and event-shaped ledger, a bias-controlled branch review that degraded gracefully and
said so, a correctly-skipped on-device stage, and a finish that honored the default git
policy. The rough edges above are real but none blocked the pipeline or corrupted its
artifacts.
