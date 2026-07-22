# Comparison memo: executing-waves vs upstream superpowers

Upstream read live from the plugin cache, superpowers 6.1.1:
`skills/subagent-driven-development/SKILL.md` (+ its `implementer-prompt.md`,
`task-reviewer-prompt.md`) and `skills/executing-plans/SKILL.md`.

## (a) What upstream already covers — referenced, not restated

From **superpowers:subagent-driven-development**:

- Fresh subagent per task with isolated, coordinator-curated context; dispatch
  prompts describe one task, never accumulated session history.
- Brief slicing and file handoffs (`scripts/task-brief`, report files;
  reviewer gets brief + report + diff as file paths — diff production
  itself differs, see conflict 7).
- Per-task review loop: task reviewer (spec compliance + code quality),
  fix subagents for Critical/Important findings, mandatory re-review, and
  handling of implementer statuses (DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT
  / BLOCKED).
- Model selection by task complexity, including "always specify the model
  explicitly — an omitted model inherits the session's most expensive model"
  and turn-count-beats-token-price guidance.
- Durable progress ledger at `.superpowers/sdd/progress.md`: check it at
  start, never re-dispatch a task recorded complete, trust ledger + `git log`
  over conversation memory after compaction.
- Reviewer-prompt hygiene: no pre-judging findings, no "do not flag"
  instructions, constraints block copied verbatim from the plan.
- Pre-flight plan review for internal contradictions; continuous execution
  without between-task check-ins; never start on main/master without consent.

From **superpowers:executing-plans**: stop-and-ask discipline when blocked
(missing dependency, unclear instruction, repeatedly failing verification) —
never force through blockers. The rest of that skill is the no-subagents
fallback path, which devcycle does not take.

## (b) Our delta — the content of devcycle:executing-waves

1. **Waves by readiness.** Upstream executes tasks one at a time in written
   order. devcycle forms waves from the plan's dispatch map: a wave = every
   task whose declared dependencies are committed AND whose file set overlaps
   no other candidate or running task; execution is by readiness, never by
   written order.
2. **Deterministic green gate.** The coordinator re-runs the task's test
   command itself and blocks acceptance until it actually passes — the
   implementer's claimed output is never sufficient. Upstream has no
   coordinator-side re-run (see conflict 2).
3. **Ledger event format (P3).** Same upstream path, richer entries: one
   timestamped line per event (dispatched, report-received, review-verdict,
   committed, user-decision), not only a per-task completion line.
4. **Handoff block (P2) + wave-boundary compaction.** Every wave boundary and
   the stage end emit the five-field handoff block with the context action
   from the pipeline table; upstream has no context-lifecycle contract.
5. **Model routing from userConfig.** Model names come from the four flat
   userConfig keys (`implementerModel`, `taskReviewerModel`,
   `walkthroughModel`, `branchReviewModel`) with documented defaults for
   unset placeholders, plus "the lineup is provisional — reassess at
   execution start". Upstream's complexity-based tiering still applies for
   choosing when to downshift; the names themselves are config, not prose.
6. **TDD preloading into briefs.** Relevant test-driven-development content is
   injected into the brief at dispatch; upstream instead tells subagents to
   use the skill themselves (see conflict 3).
7. **Requirements-block patching rule.** A plan-top requirements block no
   task's steps implement will be silently skipped — patch the owning task
   and re-extract its brief. Not covered upstream.
8. **Backups.** Byte-identical copies of every file a sub-project modifies,
   taken outside the repo before its first task. Not covered upstream.
9. **UI outcomes referral.** Rendered/on-device outcomes are never claimed
   from scripts — they go to the on-device checklist via
   devcycle:verifying-on-device. Not covered upstream.
10. **Reviewer hygiene additions.** On top of upstream's no-pre-judging:
    stale-line-number tolerance, the harness `<system-reminder>` false
    positive, and rejection of reports lacking red→green (or
    convention-equivalent) evidence — all baked into the devcycle
    task-reviewer agent.
11. **Coordinator-side commits and diff production.** devcycle implementers
    do not commit; the coordinator commits only after review plus the green
    gate. The task diff is therefore produced from the working tree
    (`git add -N` on new files, `git diff -U10 HEAD -- <files>`), replacing
    upstream's commit-based `scripts/review-package` (see conflict 7).

## (c) Conflicts and resolutions

1. **Parallel dispatch.** Upstream Red Flags: "Never dispatch multiple
   implementation subagents in parallel (conflicts)." devcycle's waves
   require concurrent implementers. **Resolution:** the wave invariant
   (file-disjoint, dependency-ready) removes the conflict upstream's rule
   guards against; devcycle dispatches wave members concurrently and keeps
   upstream's prohibition for any two tasks sharing a file.
2. **Who verifies green.** Upstream: "Do not ask a reviewer to re-run tests
   the implementer already ran — the implementer's report carries the test
   evidence." devcycle requires independent verification. **Resolution:**
   both stand. The reviewer still isn't asked to re-run as a matter of
   course; the *coordinator* deterministically re-runs the task's test
   command as an acceptance gate. One command run, not a second review.
3. **TDD skill delivery.** Upstream: "Subagents should use
   superpowers:test-driven-development." devcycle preloads that content into
   the brief. **Resolution:** preloading governs — a dispatch that depends on
   the subagent fetching a skill can silently skip it; injected content
   cannot be skipped. Upstream is never forked: the preloaded content is
   read from the live upstream skill at dispatch time.
4. **Dispatch templates and agents.** Upstream ships prompt templates
   (`implementer-prompt.md`, `task-reviewer-prompt.md`). devcycle ships
   agents (`devcycle:implementer`, `devcycle:task-reviewer`) that already
   encode the report contract, red→green rejection, and reviewer hygiene.
   **Resolution:** devcycle dispatches its own agents; upstream's templates
   are superseded within this pipeline (their substance lives in the agents).
5. **What follows the last task.** Upstream ends with a final whole-branch
   review dispatch and superpowers:finishing-a-development-branch. devcycle's
   pipeline hands off to its own branch-review stage. **Resolution:**
   executing-waves ends with a handoff block routing to
   devcycle:reviewing-the-branch (which owns the whole-branch gate); it never
   dispatches upstream's final reviewer or the finishing skill itself.
6. **Ledger location and format.** Upstream keeps `Task N: complete …` lines
   at `.superpowers/sdd/progress.md`. devcycle wants per-event entries.
   **Resolution:** reuse the upstream path (decision D2 — one ledger, no
   relocation), write P3-format entries there. Upstream's rule "tasks listed
   as complete are DONE, never re-dispatch" applies unchanged to
   `event=committed` entries.
7. **Who commits, and how the review diff is made.** Upstream's implementer
   "implements, tests, commits, self-reviews", and reviews are packaged from
   those commits via `scripts/review-package`. devcycle's green gate must
   run before anything is committed, so the implementer never commits.
   **Resolution:** devcycle governs — the coordinator commits only after
   accept + green gate, and the review diff comes from the working tree
   (`git add -N` new files, then `git diff -U10 HEAD -- <files>`) since no
   task commits exist yet to package.

**Verdict:** the delta is substantial (waves, green gate, context lifecycle,
config-driven routing); the skill is built as an overlay that references
upstream subagent-driven-development for everything in section (a).
