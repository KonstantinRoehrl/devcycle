# Branch discipline

The rule for every committing path. Skills and commands name this file; none of them
restate it.

Before any stage that commits: if the checkout is on the repo's default branch (resolved
as `finishing-the-cycle` resolves it) or on an integration branch — `dev`, `develop`,
`integration`, or one the user names — create a topic branch and write it to the
`branch:` line of `.devcycle/state.md`. Never commit cycle work directly to either.

**Resolving the default branch.** `skills/finishing-the-cycle/SKILL.md` owns the
resolution and is the authority on it: try, in order, `git symbolic-ref
refs/remotes/origin/HEAD`, then `gh repo view --json defaultBranchRef`, then fall back
to `main` or `master` if one of those branches exists and neither command is available.

**Where this applies.** Every committing path, without exception — the full pipeline's
pre-flight before wave 1, the fast path, the sweep path, and re-entry via
`/devcycle:continue` (which settles the branch off the recorded `branch:` line first,
per `references/resume.md`, and falls back to this rule only when no topic branch was
ever recorded).
