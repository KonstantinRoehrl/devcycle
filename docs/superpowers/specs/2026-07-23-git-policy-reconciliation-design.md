# Git-policy reconciliation at the finish stage — Approved Implementation Spec

**Date:** 2026-07-23 **Status:** Approved, pre-implementation

This spec is a **delta** on `README.md` (Configuration table), `DESIGN.md` §7 (userConfig
Schema), and `commands/cycle.md` / `commands/continue.md` (finish stage), which remain
authoritative for everything not restated here.

## 1. Problem

`userConfig.gitPolicy` (`local-commits-only` / `push-allowed` / `open-pr`) is devcycle's own
blast-radius knob for the finish stage. It is evaluated in isolation: `push-allowed` and
`open-pr` push the branch recorded in `.devcycle/state.md` unconditionally, without checking
whether anything outside devcycle's own config already forbids that push. Two such things
can:

1. **Claude Code permission settings** may deny (or require ask on) `git push` commands,
   independent of what `gitPolicy` says.
2. **The repo's release/default branch** may be the branch the cycle happened to run on — if
   the user started `/devcycle:cycle` while already on `main`, `push-allowed` would push
   straight to it, violating the user's own global git-workflow rule (never push a branch
   wired to release automation directly). Nothing in devcycle creates or requires a topic
   branch today; the state file just records "the current git branch" at Step 0.

The desired behavior: whichever side is more restrictive wins. `local-commits-only` is
already the floor and needs no change (it never pushes regardless of anything else). The gap
is entirely on the `push-allowed` / `open-pr` side.

## 2. Resolved design decisions

1. **Two global signals, both in scope**, checked only when configured `gitPolicy` is
   `push-allowed` or `open-pr`:
   - **Permission-settings signal:** a deny rule matching `git push` in any effective Claude
     Code permission scope (project `.claude/settings.local.json`, project
     `.claude/settings.json`, user `~/.claude/settings.json`, or a managed/enterprise policy
     file where present) clamps the effective policy for this run to `local-commits-only`.
     Matching patterns: `Bash(git push:*)`, `Bash(git:*)`, or a bare `Bash` deny — anything
     that would deny the literal `git push` invocation. An **ask**-only rule (no deny) does
     **not** clamp anything: `gitPolicy` is left as configured, and the normal Claude Code
     permission prompt at push time is the communication.
   - **Protected-branch signal:** resolve the repo's release/default branch (in order: `git
     symbolic-ref refs/remotes/origin/HEAD`, then `gh repo view --json defaultBranchRef`,
     then a `main`/`master` heuristic if neither is available). If the branch recorded in
     `.devcycle/state.md` **is** that branch, clamp the effective policy to
     `local-commits-only` — devcycle never pushes directly to the repo's default branch,
     regardless of configured `gitPolicy`.
2. **Resolution is a clamp, not a blend.** Either signal firing collapses both
   `push-allowed` and `open-pr` to `local-commits-only` for that run — there is no
   intermediate "push but don't open a PR" state produced by these checks. (`open-pr`
   without a push is meaningless; nothing to gate a PR on.)
3. **No new userConfig knob.** This changes how the existing `gitPolicy` value is applied at
   the finish stage; it does not add an escape hatch to bypass the clamp. Out of scope for
   this change.
4. **Silent clamp, narrated, not paused.** The finish stage does not stop for confirmation
   and does not surface this earlier (e.g. at the first-run config walkthrough or scoping
   interview) — it downgrades quietly and states the effective policy plainly in that stage's
   Handoff block. When the effective policy differs from the configured value, the block
   names both and the reason in one line, e.g.:

   ```
   Git policy: configured push-allowed → effective local-commits-only (current branch is
   the repo's default branch; direct pushes to it are not allowed)
   ```

   When there is no clamp, the block still states the effective policy (no reason line
   needed) — so the finish stage's git behavior is never left implicit.
5. **local-commits-only needs no new logic.** It already never pushes, independent of both
   signals above — this is stated explicitly in the finish-stage instructions so the "weaker
   wins" rule reads as satisfied by existing behavior, not silently unhandled.

## 3. Where this plugs in

- `commands/cycle.md` Step 7 (finish) — add the two-signal resolution ahead of the existing
  `local-commits-only` / `push-allowed` / `open-pr` branch, and extend the Handoff block
  content per §2.4.
- `commands/continue.md` "Finish stage git policy" section — same resolution, restated in
  full (matching this file's existing duplication of the `gitPolicy` default-fallback
  explanation, since a resumed session may never load `cycle.md`).
- `README.md` Configuration section — extend the `gitPolicy` row/prose with one or two
  sentences on effective-policy resolution; point to the "why" without duplicating the
  mechanics spelled out here.
- `DESIGN.md` §7 (userConfig Schema) — add a bullet after "The finishing stage branches on
  `gitPolicy`..." documenting the resolution step.
- `docs/DECISIONS.md` — new dated entry (2026-07-23) recording this decision, matching the
  existing entry format (Decision / Why / Supersedes: nothing reversed — adds a resolution
  step in front of the existing `gitPolicy` branch).

## 4. Test coverage

A new scenario file, `tests/scenarios/commands/git-policy-reconciliation.md`, following the
empirical red/green subagent-transcript format used by `tests/scenarios/commands/first-run-config.md`
(setup / subagent prompt / pass criteria / baseline red / result green). Required coverage:

- Permission-deny signal clamps `push-allowed` → effective `local-commits-only`.
- Protected-branch signal clamps `open-pr` → effective `local-commits-only` (cycle ran on the
  repo's default branch).
- No-conflict case: neither signal fires, configured policy is used unchanged (regression
  guard against over-clamping).
- The Handoff block states the effective policy in all three cases, with the configured →
  effective + reason line present only when they differ.

Writing the actual scenario transcripts is implementation work; this section fixes required
coverage, not the transcripts themselves.

## 5. Non-goals

- No proactive warning during the first-run config walkthrough or scoping interview about a
  pre-existing conflict between `gitPolicy` and the environment — the check happens once, at
  the finish stage, per §2.4.
- No new userConfig knob to opt out of the clamp.
- No change to `local-commits-only` behavior.
- No attempt to detect "deployment automation wired to a branch" beyond the default/release
  branch itself — CI-workflow inspection for non-default protected branches is out of scope.
