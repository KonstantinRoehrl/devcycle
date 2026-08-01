# Scenario: model-routing
- Skill under test: devcycle:executing-waves — the implementer model derivation in
  `${CLAUDE_PLUGIN_ROOT}/references/config.md` § Model tiers
- Type: discipline

Does a coordinator with `implementerModel` unset send implementer dispatches to the fast
tier by default — escalating to the session tier only when one of the four named
dispatch-time signals actually fires, never on a first attempt that merely looks risky —
and does the ledger record which signal fired rather than only the tier it landed on?

## Setup

One throwaway sandbox repo, built in a session-temp directory, plus a second run over the
same sandbox with one line of configuration changed.

**Run A sandbox — `waveproj-routing` (`implementerModel` unset):**

```bash
mkdir -p waveproj-routing && cd waveproj-routing && git init -b main
mkdir -p docs .superpowers/sdd .devcycle/evidence src
git commit --allow-empty -m "chore: sandbox baseline"
git checkout -b feat/routing
cat > docs/plan.md <<'EOF'
# Plan: stats toolkit

## Task 1: implement variance
**Files:** Create: src/variance.js, src/variance.test.js, docs/variance.md
**Interfaces:** Produces: `variance(xs)` — sample variance of a number array
**Dependencies:** none
**Evidence:** red-green
- [ ] Write a failing test in src/variance.test.js asserting `variance([1,2,3,4]) === 5/3`
      (command: `node --test src/variance.test.js`)
- [ ] Implement `variance` in src/variance.js so that command passes
- [ ] Document the n-1 denominator in docs/variance.md

## Task 2: split the stats module
**Files:** Create: src/mean.js, src/median.js, src/mode.js, src/stddev.js, src/range.js,
src/index.js  Modify: src/stats.js  Test: src/stats.test.js, src/index.test.js
**Interfaces:** Produces: one named export per file, re-exported from src/index.js
**Dependencies:** none
**Evidence:** green-green (behavior-preserving)
- [ ] Move each helper into its own file, re-export from src/index.js, keep
      `node --test src/*.test.js` green
- [ ] Reduce src/stats.js to a re-export of src/index.js

## Task 3: wire the CLI to the split module
**Files:** Modify: src/cli.js  Test: src/cli.test.js
**Interfaces:** Consumes: `src/index.js`'s named exports from Task 2
**Dependencies:** Task 2 (committed at 4d78b2e)
**Evidence:** red-green
- [ ] Write a failing test in src/cli.test.js asserting `cli(["mean","1","2","3"])`
      prints `2`
- [ ] Rewrite src/cli.js's imports to src/index.js so that test passes

## Task 4: tidy the error paths
**Files:** Modify: src/errors.js  Test: src/errors.test.js
**Interfaces:** Produces: unchanged public surface
**Dependencies:** none
**Evidence:** red-green
- [ ] Polish the error handling
- [ ] Make sure the tests still look right

## Task 5: implement percentile
**Files:** Create: src/percentile.js, src/percentile.test.js, docs/percentile.md
**Interfaces:** Produces: `percentile(xs, p)` — linear-interpolated percentile
**Dependencies:** none
**Evidence:** red-green
- [ ] Write a failing test in src/percentile.test.js asserting
      `percentile([1,2,3,4], 50) === 2.5` (command: `node --test src/percentile.test.js`)
- [ ] Implement `percentile` in src/percentile.js so that command passes
- [ ] Document the interpolation rule in docs/percentile.md

## Task 6: implement quantile
**Files:** Create: src/quantile.js, src/quantile.test.js, docs/quantile.md
**Interfaces:** Produces: `quantile(xs, q)` — the q-quantile of a number array
**Dependencies:** none
**Evidence:** red-green
- [ ] Write a failing test in src/quantile.test.js asserting
      `quantile([1,2,3,4], 0.5) === 2.5` (command: `node --test src/quantile.test.js`)
- [ ] Implement `quantile` in src/quantile.js so that command passes
- [ ] Document the quantile definition in docs/quantile.md

## Dispatch Map
- Wave 1: Task 1, Task 2, Task 4, Task 5, Task 6
- Wave 2: Task 3
EOF
cat > .devcycle/ledger.md <<'EOF'
- [2026-08-01T09:00:00Z] task=5 event=dispatched outcome=model fast:<id> (auto: files=3, deps=none, steps=specified) ref=.superpowers/sdd/task-5-dispatch.md
- [2026-08-01T09:20:00Z] task=5 event=report-received outcome=claims green ref=.devcycle/reports/5.md
- [2026-08-01T09:25:00Z] task=5 event=review-round outcome=round 1 dispatched ref=none
- [2026-08-01T09:31:00Z] task=5 event=review-verdict outcome=rejected (blocking: percentile([1,2,3,4], 0) throws instead of returning 1) ref=.superpowers/sdd/task-5-review-1.md
EOF
cat > .devcycle/state.md <<'EOF'
# devcycle state
- stage: execution
- root: <absolute path of the sandbox>
- branch: feat/routing
- request: build out the stats toolkit
- scope: none
- audit: none
- diagnosis: none
- spec: docs/spec.md
- plan: docs/plan.md
- ledger: .devcycle/ledger.md
- checklist: none
- configured: 2026-08-01 profile=standard
- updated: 2026-08-01T09:31:00Z
EOF
git add -A && git commit -m "chore: seed cycle state"
```

Tasks 5 and 6 are deliberately the same shape — three files, `Dependencies: none`,
every step naming its file and expected behavior — and differ only in what the ledger
already holds about them: Task 5 has a review round that returned blocking findings,
Task 6 has no history at all. That pair is what criterion 3 grades; a coordinator that
escalates both has escalated on "this looks risky", not on the named trigger.

**Run B — same sandbox, `implementerModel` pinned.** Rebuild Run A's sandbox and change
the state file's configuration line to
`- configured: 2026-08-01 profile=standard implementerModel=claude-haiku-4-5`. Task 2
is the one to watch: its nine files would derive session tier, so a pinned id that is
*weaker* than the derivation would pick is the sharp test of "binding, never overridden
or downshifted".

**Reference layer (required for every green run).** `skills/executing-waves/SKILL.md`
carries no model rule of its own — it points at
`${CLAUDE_PLUGIN_ROOT}/references/config.md`. Check out (or copy) the devcycle plugin
whole somewhere readable from the sandbox, not just the one reference, and give the
agent the substitution in the prompt's environment note; with a dangling pointer the run
grades a broken setup rather than the text.

## Subagent prompt

Given verbatim to a fresh subagent, working directory the sandbox for that run. For the
green runs the block marked SKILL CONTENT holds the full text of
`skills/executing-waves/SKILL.md`; the baseline runs splice
`git show 0ef37c5:skills/executing-waves/SKILL.md` and point the environment note at a
checkout of `0ef37c5`, so the pre-inversion `references/config.md` is what the run reads.

```
[SKILL CONTENT: full text of skills/executing-waves/SKILL.md]

You are the coordinator executing the wave-based plan in docs/plan.md (state file:
.devcycle/state.md, ledger: .devcycle/ledger.md). Wave 1 is Tasks 1, 2, 4, 5 and 6;
Task 5 is a retry after its review round returned blocking findings.

You have no subagent-dispatch tool, so instead of dispatching: for EACH wave-1 task,
write the EXACT dispatch prompt you would send to devcycle:implementer to
.superpowers/sdd/task-<n>-dispatch.md, state at the top of each file which model that
dispatch would use and why, append the ledger entry for it, and stop. Summarize the
per-task model decisions in your final message.

Environment notes: the devcycle plugin's files are checked out at <absolute path of
the devcycle checkout>; where guidance references ${CLAUDE_PLUGIN_ROOT}, substitute
that path. Every ${user_config...} placeholder above still renders literally; the
recorded configuration for this run is the `configured:` line of .devcycle/state.md.
```

## Pass criteria

1. **A 3-file, dependency-free task with fully specified steps routes to the fast
   tier.** Task 1 dispatches fast, and its ledger entry reads
   `outcome=model fast:<resolved id> (auto: files=3, deps=none, steps=specified)` with
   a real resolved id in place of the placeholder. Three files is past the old ≤2-file
   predicate, which would have sent this to the session tier; a run that routes Task 1
   to session tier fails, whatever reason it gives.
2. **Each escalation trigger fires on its own.** Four sub-cases, graded independently —
   any one of them alone must produce session tier: (a) Task 2, more than five files in
   the `**Files:**` block; (b) Task 3, `**Dependencies:** Task 2 (committed at 4d78b2e)`
   rather than `none` — graded from the dispatch prompt the coordinator would write for
   wave 2 if it drafts one, otherwise from its stated wave-2 plan; (c) Task 4, whose
   steps ("Polish the error handling", "Make sure the tests still look right") name no
   file and no expected behavior; (d) Task 5, a retry whose prior review round returned
   blocking findings per the seeded ledger. A sub-case that lands on session tier for a
   reason other than its own signal (e.g. Task 4 escalated for its file count) is a
   fail for that sub-case.
3. **First attempts never escalate on review history.** Task 6 routes fast even though
   it is shape-identical to Task 5, which escalates. The trigger is "a prior review
   round on this task returned blocking findings", not "a task of this kind tends to
   need a second round" — a run that escalates Task 6 has substituted its own risk
   judgment for the named signal, and a run that escalates *both* 5 and 6 fails this
   criterion even though Task 5 alone would have passed 2(d).
4. **The ledger records the trigger, not just the tier.** Every session-tier entry names
   the signal that fired, in the audit shape `outcome=model session (auto: escalated on
   files=9)` for Task 2 and the equivalent for the other escalations
   (`escalated on deps=Task 2`, `escalated on steps=unspecified`,
   `escalated on prior review round returned blocking findings`). `outcome=model
   session` with no parenthetical, or one that restates the tier instead of the input,
   is a partial: the tier was right and the audit trail was not.
5. **An explicitly configured `implementerModel` still wins verbatim.** In Run B every
   wave-1 dispatch uses `claude-haiku-4-5` and logs `outcome=model claude-haiku-4-5
   (pinned)` — Task 2 included, whose nine files would otherwise escalate. The inversion
   changed the derivation only; a pinned id is binding in both directions, never
   overridden upward by an escalation trigger nor downshifted. A run that derives a tier
   anywhere in Run B fails, as does one that logs a pinned dispatch in the `(auto: …)`
   shape.

## Baseline (red)

**Not yet run (2026-08-01).** No model run was made for this scenario, in either
direction; the harness constraint recorded in
`tests/scenarios/executing-waves/branch-discipline-preflight.md` § Baseline (red) — no
credentialed isolated `CLAUDE_CONFIG_DIR` on this machine, and the machine's real config
directory loads the installed devcycle plugin, the contamination
`references/engine-selection.md`'s baseline-hygiene note excludes — has not been lifted.

Established without a model run — a text check over the two committed revisions of the
reference the criteria grade, not a behavioral result:

- `git show 0ef37c5:references/config.md` states the implementer predicate as "fast tier
  iff the task's `**Files:**` block lists ≤2 files AND `**Dependencies:** none` AND every
  step names its file and expected behavior; else session tier". Under that text Task 1
  (3 files) and Tasks 5 and 6 (3 files each) all fall to the session tier, so criteria 1
  and 3 have no text to pass on: fast-by-default did not exist.
- The same revision has no escalation vocabulary at all — grepping it for `escalat`
  returns nothing — and no review-history input, so criterion 2(d) has nothing to grade
  against. Sub-cases 2(a)–(c) are expected to hold in red for the wrong reason: the old
  predicate sends *everything* past two files to session tier, so Tasks 2, 3 and 4 land
  on the right tier by accident, and should be recorded as not-a-delta rather than as
  passes.
- The old audit example reads `outcome=model session (auto: files=4)` — inputs, but no
  named trigger, and nothing to name one *of*, since the old rule has a single
  conjunctive condition rather than four separable signals. Criterion 4 is a partial by
  construction on that text.
- The pinned-id rule ("any other value → binding: use it verbatim for every dispatch,
  never override or downshift it") is byte-identical across the two revisions, so
  criterion 5 is not-a-delta: it grades that the inversion did not break something that
  already worked.

What would prove it: Run A and Run B against `0ef37c5`'s skill and reference text under
the isolated-config protocol, with the sandbox's ledger and dispatch files inspected on
disk afterwards rather than graded from the response's own claims. Expected red on
criteria 1, 3 and 4; 2(a)–(c) and 5 expected to hold as not-a-delta.

## Result (green)

**Not yet run (2026-08-01).** Blocked by the same missing credentialed isolated config.
What would prove it: Run A and Run B against the working-tree
`skills/executing-waves/SKILL.md` and `references/config.md`, graded per task from disk —
the six `.superpowers/sdd/task-<n>-dispatch.md` files and the appended `.devcycle/ledger.md`
lines — with criterion 3 read as the Task 5 / Task 6 pair rather than either task alone.

Net: no RED/GREEN claimed on criteria 1–5 — nothing was run. The deltas recorded under
Baseline are text checks over `0ef37c5` versus the working tree, and criterion 5 is
not-a-delta in both directions.
