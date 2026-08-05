# Commit convention — deriving and recording this repo's own commit-message rules

The single owner of how a devcycle-driven commit's subject matches the target repo's own
conventions. `devcycle:executing-waves` runs the derivation once, before wave 1's first
commit; `devcycle:finishing-the-cycle` names this file when a PR title needs the same
match. Neither restates the derivation here.

## Deriving the convention

Before wave 1's first commit, alongside the branch check `references/branch.md` owns:

1. Read the repo's own convention docs. The list of what to check is owned by
   `skills/auditing-a-repo/SKILL.md`'s "Inventory the repo's own conventions before
   reaching for generic advice" bullet (step 0, Discovery) — read it there and follow
   it; it is not restated here, so a change to that list never has to be echoed here
   too.
2. Run `git log --oneline -15` on the target repo.
3. From both, derive: the allowed commit types, scope casing (lowercase, kebab-case, or
   none), subject phrasing (imperative vs. descriptive), ticket-ID encoding (if any), and
   any type the team demonstrably avoids (e.g. a repo whose last 15 commits contain no
   `feat` despite feature-sized changes is avoiding it deliberately, not by accident).
4. When no convention doc exists and history is uninformative (a fresh repo, fewer than 3
   commits), fall back to plain Conventional Commits with no repo-specific restriction.

## Recording the derivation

Record it once, at the top of `.devcycle/ledger.md`, as a `Commit-convention:` preamble
line alongside the existing `Plan:` / `Branch:` / `Profile:` lines — never in
`.devcycle/state.md`, which is cycle-shaped, not commit-shaped, and does not survive
across the multiple commits one cycle makes. Example:

```
Commit-convention: types fix/feat/chore/docs/refactor/perf/test/build/ci; no scope; imperative subject; no feat avoided (derived from CONTRIBUTING.md + git log)
```

Every commit for the rest of the run's execution and finish stages matches this line; a
task whose natural type conflicts with it (e.g. the repo avoids `feat` and the change is
feature-sized) uses the nearest allowed type and never invents one outside the derived
set.

## Scoping the commit

The single owner of how any devcycle-driven commit is scoped, cited rather than restated
by every skill that commits: `skills/executing-waves/SKILL.md`, `skills/fast-path/SKILL.md`,
`skills/sweeping-mechanical-changes/SKILL.md`, `skills/distilling-learnings/SKILL.md`,
`skills/onboarding-a-repo/SKILL.md`, and `skills/auditing-a-repo/SKILL.md`.

Every commit is scoped by an explicit pathspec naming exactly the files this run authored
— `git commit -- <the file list>` — never `git add -A` and never a bare `git commit`,
which ships whatever else the checkout happened to have staged. Concurrent implementers
have in-flight edits elsewhere in the tree, and the index picks up entries from their
`git add -N` calls, so an unscoped commit sweeps another task's work into this one's.

The pathspec names source files and nothing else: evidence files under
`.devcycle/evidence/` stay out of it. Target repos are told to gitignore `.devcycle/`
(README), so naming an ignored, untracked evidence path in a pathspec aborts the whole
commit with "pathspec did not match any file known to git". Evidence files are
working-tree artifacts a reviewer reads from the checkout, not history.
