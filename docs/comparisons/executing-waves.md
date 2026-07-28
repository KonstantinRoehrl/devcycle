# Comparison memo: executing-waves vs upstream superpowers

Upstream baseline: superpowers 6.1.1 from the plugin cache —
`skills/subagent-driven-development/SKILL.md` (+ its `implementer-prompt.md`,
`task-reviewer-prompt.md`), read 2026-07-22. Memo refreshed 2026-07-26 for the
profile split. 6.2.0 is now installed alongside 6.1.1 and this memo has not been
re-derived against it. Four 6.2.0 changes are already known, and a re-derive
should start from them:

- Its `subagent-driven-development` no longer mentions
  `superpowers:test-driven-development` at all — see (d)3.
- It moved its own ledger to `<workspace>/progress.md`, treating the flat
  `.superpowers/sdd/progress.md` as another plan's file — see (d)6.
- It added a worktree setup step (setup = worktree, ledger check, read plan,
  pre-flight review), deferring to `superpowers:using-git-worktrees` to create or
  verify one. This memo's (a) does not list it, and devcycle's own pre-flight
  (c)8 does branch discipline instead of worktree setup — so whether the two
  collide is an open question for the re-derive.
- It added a scoped re-review dispatch with its own `re-review-prompt.md`, plus a
  fix-round escalation (rounds ≤3 resume the implementer, ≥4 use a fresh
  implementer on a more capable model). devcycle's per-task loop re-dispatches
  `devcycle:task-reviewer` with no such escalation; this memo does not yet state
  a resolution.

`skills/executing-plans/SKILL.md` is no longer a comparison target: the skill
references it at no profile, so its stop-and-ask discipline is neither borrowed
nor overridden here.

## Engine per profile

| profile | execution engine | upstream loaded? |
| --- | --- | --- |
| `lean` | devcycle-native compact | no |
| `standard` | devcycle-native compact | no |
| `thorough` | upstream overlay | yes — `superpowers:subagent-driven-development` (REQUIRED) |

**One behavioral contract across both engines.** Wave formation, the ledger, the
green gate, the review cycle, evidence, and the handoff are identical at every
profile. Only the *source* of the brief-slicing and review-loop mechanics moves:
borrowed from upstream at `thorough`, stated inline at `lean`/`standard`. So the
delta below is read in two layers — what `thorough` still owes upstream (a), what
`lean`/`standard` carry instead (b), and what is devcycle's regardless (c).

## (a) `thorough` only — upstream's share, referenced and never restated

From **superpowers:subagent-driven-development**:

- Fresh subagent per task with isolated, coordinator-curated context; dispatch
  prompts describe one task, never accumulated session history.
- Brief slicing and file handoffs (`scripts/task-brief`, report files; the
  reviewer gets brief + report + diff as file paths — diff production itself
  differs, see (d)7).
- The per-task review/fix loop and the handling of implementer statuses
  (DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED).
- Reviewer-prompt construction and hygiene: no pre-judging findings, no "do not
  flag" instructions, constraints block copied verbatim from the plan.
- Model selection by task complexity as *background* — the tiering intuition,
  including its warning that "An omitted model inherits your session's model —
  often the most capable and most expensive — which silently defeats this
  section", and turn-count-beats-token-price. The actual choice is made by
  `references/config.md`'s predicates (see (c)5).
- Pre-Flight Plan Review for internal contradictions, and continuous execution
  without between-task check-ins.

Upstream's tail does **not** apply at any profile: its final whole-branch
reviewer dispatch and its `superpowers:finishing-a-development-branch` step are
replaced by devcycle's `reviewing-the-branch` and finish stages (see (d)5).

## (b) `lean` / `standard` — the native engine

Upstream is not loaded, so the whole skill is delta. What the skill states inline
in place of upstream's mechanics:

- **The brief-slicing contract, enumerated.** A brief carries exactly the task's
  `**Files:**`, `**Interfaces:**`, `**Dependencies:**`, `**Evidence:**` class, its
  steps, and the global constraints and pinned interfaces that apply — nothing
  else. Upstream's `scripts/task-brief` extraction is not used.
- **A three-point TDD splice** for `red-green` tasks in place of upstream's
  test-driven-development content: write the failing test first, run it and
  capture the red output before any implementation, then write only enough code
  to pass and capture the green. Nothing beyond those three is spliced.
- **The review cycle stated directly** — reviewer dispatch inputs, the findings
  loop back to the implementer, re-review — rather than inherited from upstream's
  loop.

The behavioral result is the same contract `thorough` reaches by overlay; the
compaction is the point, not a reduction in what the stage does.

## (c) Unconditional delta — every profile, both engines

1. **Waves by readiness.** Upstream executes tasks one at a time in written
   order. devcycle forms waves from the plan's `## Dispatch Map`: a wave = every
   task whose declared dependencies are committed AND whose file set overlaps no
   other candidate or running task. Execution is by readiness, never by written
   order.
2. **Deterministic green gate.** The coordinator re-runs the task's test command
   itself and reads the exit status before accepting. Neither the implementer's
   evidence files nor a reviewer's accept verdict is sufficient — both judge a
   report, not the repo. Upstream has no coordinator-side re-run (see (d)2).
3. **Ledger at `.devcycle/ledger.md`**, one appended line per event with all four
   fields required, over the six-value event enum
   (`dispatched|report-received|review-round|review-verdict|committed|user-decision`).
   Upstream keeps per-task completion lines in its own progress file; devcycle
   writes only its own path (see (d)6).
4. **Handoff blocks and wave-boundary compaction.** Every wave boundary and the
   stage end update `.devcycle/state.md` and emit the block defined by
   `references/handoff.md`, including the context action and the gate that stops
   the run until the user acts. Upstream has no context-lifecycle contract.
5. **Model routing from configuration.** This stage's two knobs —
   `implementerModel` and `taskReviewerModel` — resolve through
   `references/config.md`: an explicit id binds verbatim, otherwise the file's
   dispatch-time predicates pick the session or fast tier, and every dispatch
   logs the decision and its inputs to the ledger. Upstream's complexity tiering
   is background (a); the decision procedure and its auditability are ours.
6. **File-backed evidence with a profile-sized tail.** Every brief at every
   profile carries an `**Evidence tail:** <N>` line, `<N>` from the profile
   (10 / 20 / 50 lines). Evidence paths, the three classes, the implementer
   report shape, and the reviewer's rejection rules are owned by
   `references/evidence.md` and named in the brief rather than restated.
   Evidence itself is never profile-conditional; only `<N>` varies. Upstream's
   file-handoff mechanics know nothing of this, so at `thorough` the line is
   added to the sliced brief.
7. **Requirements-block patching rule.** A plan-top requirements block that no
   task's steps implement will be silently skipped — patch the owning task's
   steps and re-extract its brief before dispatching. Not covered upstream. At
   `thorough` this is an addition to upstream's Pre-Flight Plan Review, not a
   replacement.
8. **Branch discipline before wave 1.** `references/branch.md` governs, and it is
   stricter than upstream's never-start-on-`main`/`master` rule: `dev`,
   `develop`, `integration`, and any branch the user names as an integration
   branch are equally off limits, and the topic branch is recorded in
   `.devcycle/state.md` before anything dispatches.
9. **Coordinator-side commits and diff production.** devcycle implementers never
   commit, stage, or push — dispatch prompts that say so are a red flag to
   delete. The coordinator commits only after review plus the green gate, so the
   task diff comes from the working tree (`git add -N` on new files, then
   `git diff -U10 HEAD -- <files>`) rather than upstream's commit-based
   `scripts/review-package` (see (d)7).
10. **Reviewer hygiene additions**, baked into the `devcycle:task-reviewer` agent
    on top of upstream's no-pre-judging: stale-line-number tolerance, the harness
    `<system-reminder>` false positive, and rejection of a report whose named
    evidence files are missing, empty, or contradict the declared class.
11. **Sweep-executed tasks.** A task marked `**Execution:** sweep` replaces brief
    slicing and implementer dispatch with one run of the mechanical-sweep
    workflow, then rejoins the normal diff → review → gate → commit path. The
    task-level deltas — per-task args and report filenames, the pre-run
    `dispatched outcome=sweep` ledger line, clean-targets handling, the
    applied-none / hard-stop / rejection fallbacks, and the coordinator writing
    the evidence files under the plan's task number — live in this skill; the
    invocation contract belongs to `devcycle:sweeping-mechanical-changes`. No
    upstream counterpart at any profile.
12. **On-device checklist generation** (moved here from
    `devcycle:verifying-on-device` on 2026-07-26): the moment a task produces
    rendered changes, the coordinator generates or updates
    `docs/<feature>/on-device-checklist.md` in that same wave, records it in the
    `checklist:` field of `.devcycle/state.md`, and covers the applicable
    verification dimensions (visual rendering vs intent, layout/alignment/
    spacing, interaction feel, responsive behavior at real breakpoints, theme
    parity, keyboard/accessibility, empty/loading/error states, animation
    timing). The `(auto)` boundary lives here too: a script or screenshot never
    checks off an item, with one exception for DOM/CSS/text assertions a
    structural browser check has actually verified, honestly tagged `(auto)`.
    Everything a structural check cannot see stays unchecked for the human.
    Generation is a mid-wave coordinator duty; the later walkthrough of that
    checklist is `devcycle:verifying-on-device`'s stage. Upstream has no notion
    of a human-only verification residue.
13. **Resume from git evidence.** `references/resume.md` settles the branch and
    re-derives position; the ledger's last event per task then selects the resume
    action from a most-specific-row-wins table, with separate rows for
    sweep-token outcomes. Upstream's recovery guidance stops at "trust the ledger
    and `git log` over conversation memory", which devcycle keeps.

## (d) Conflicts and resolutions

Each conflict names where it is live. A conflict scoped to `thorough` simply has
no counterpart to collide with at `lean`/`standard`, where upstream is not
loaded — but devcycle's side of the resolution is unconditional in every case.

1. **Parallel dispatch.** *Live at `thorough`.* Upstream Red Flags: "Never
   dispatch multiple implementation subagents in parallel (conflicts)."
   devcycle's waves require concurrent implementers. **Resolution:** the wave
   invariant (file-disjoint, dependency-ready) removes the conflict upstream's
   rule guards against; devcycle dispatches wave members concurrently and keeps
   upstream's prohibition for any two tasks sharing a file. The invariant holds
   at every profile.
2. **Who verifies green.** *Live at `thorough`.* Upstream: "Do not ask a reviewer
   to re-run tests the implementer already ran." **Resolution:** both stand. The
   reviewer still is not asked to re-run as a matter of course; the *coordinator*
   deterministically re-runs the task's test command as an acceptance gate — one
   command run, not a second review. The gate is unconditional and explicitly
   never profile-conditional.
3. **TDD content delivery.** *Live at `thorough`.* 6.1.1's
   subagent-driven-development points subagents at
   `superpowers:test-driven-development` themselves. devcycle preloads the
   content into the brief instead. **Resolution:** preloading governs at every
   profile — a dispatch that depends on the subagent fetching a skill can
   silently skip it; injected content cannot. Upstream is never forked: at
   `thorough` the spliced content is read from the live upstream skill at
   dispatch time; at `lean`/`standard` the three-point excerpt in (b) is used.
   *Known shift:* 6.2.0's subagent-driven-development no longer mentions
   test-driven-development at all, so the upstream half of this conflict may have
   dissolved — unverified against the rest of 6.2.0.
4. **Dispatch templates vs agents.** *Live at `thorough`.* Upstream ships prompt
   templates (`implementer-prompt.md`, `task-reviewer-prompt.md`); devcycle ships
   agents (`devcycle:implementer`, `devcycle:task-reviewer`) that already encode
   the report contract, evidence-backed rejection, and reviewer hygiene.
   **Resolution:** devcycle dispatches its own agents at every profile; upstream's
   templates are superseded within this pipeline, their substance living in the
   agents.
5. **What follows the last task.** *Live at `thorough`.* Upstream ends with a
   final whole-branch review dispatch and
   `superpowers:finishing-a-development-branch`. **Resolution:** executing-waves
   ends with a handoff block routing to `devcycle:reviewing-the-branch`, which
   owns the whole-branch gate; it never dispatches upstream's final reviewer or
   the finishing skill. Unconditional.
6. **Ledger location and format.** *Live at `thorough`.* Upstream keeps
   `Task N: complete …` lines in its own progress file. **Resolution, changed
   2026-07-26:** devcycle writes only `.devcycle/ledger.md`, in the event format
   of (c)3, and at `thorough` that path overrides upstream's — never both. This
   supersedes the earlier decision to reuse upstream's path (D2). Upstream's rule
   "tasks listed as complete are DONE, never re-dispatch" applies unchanged to
   `event=committed` entries. *Known shift:* 6.2.0 moved its own ledger to
   `<workspace>/progress.md` and now treats the flat `.superpowers/sdd/progress.md`
   as another plan's file — which makes reusing an upstream path less attractive
   still, and does not change devcycle's side.
7. **Who commits, and how the review diff is made.** *Live at `thorough`.*
   Upstream's implementer "implements, tests, commits, self-reviews", and reviews
   are packaged from those commits via `scripts/review-package`. devcycle's green
   gate must run before anything is committed, so the implementer never commits.
   **Resolution:** devcycle governs at every profile — the coordinator commits
   only after accept plus the gate, and the review diff comes from the working
   tree, since no task commits exist yet to package.

**Verdict:** at `lean`/`standard` the skill is wholly devcycle-native and shares
no text with upstream. At `thorough` it remains an overlay that references
subagent-driven-development for everything in (a). The delta in (c) — waves,
green gate, ledger, context lifecycle, config-driven routing, file-backed
evidence, sweeps, checklist generation — is identical either way.
