# Branch discipline

Two rules live here: the rule every committing path follows, and the derivation every
branch-scoped stage runs to turn a branch into a file set. Skills and commands name this
file; none of them restate either rule.

## Committing

Before any stage that commits: if the checkout is on the repo's default branch (resolved
as `finishing-the-cycle` resolves it) or on an integration branch — `dev`, `develop`,
`development`, `integration`, or one the user names — create a topic branch and write it
to the `branch:` line of `.devcycle/state.md`. Never commit cycle work directly to either.

**Resolving the default branch.** `skills/finishing-the-cycle/SKILL.md` owns the
resolution and is the authority on it: try, in order, `git symbolic-ref
refs/remotes/origin/HEAD`, then `gh repo view --json defaultBranchRef`, then fall back
to `main` or `master` if one of those branches exists and neither command is available.

**Where this applies.** Every committing path, without exception — the full pipeline's
pre-flight before wave 1, the fast path, the sweep path, and re-entry via
`/devcycle:continue` (which settles the branch off the recorded `branch:` line first,
per `references/resume.md`, and falls back to this rule only when no topic branch was
ever recorded).

## Deriving a branch's file set

Which files a branch-scoped stage reads, and where it reads them from.
`devcycle:auditing-a-repo` and `devcycle:verifying-on-device` both run this derivation.
What a stage then *does* with the file set is that stage's own — the audit expands it to a
feature dependency graph, the verify stage traces it to routes and screens — and is
described there, not here.

**Base**, in order: an explicitly supplied base; the repo's integration branch, spelled
exactly as above (`dev`, `develop`, `integration`, or one the user names), when one exists
locally or on the remote; else the default branch, resolved exactly as above.

**Changed files.** Resolve the merge base as its own step, check it, and only then diff:

```
base_sha=$(git merge-base <base> <branch>) || stop
git diff --name-only "$base_sha" <branch>
```

An empty or failed merge base means the two refs do not share history — an unknown ref,
unrelated histories, a shallow clone — and the run **stops and says so**. It never falls
through to `git diff --name-only <branch>`, which diffs the *working tree* against the
branch and yields a plausible-looking file set that is not the branch's. When `<branch>` is
the checked-out branch and the worktree is dirty, the uncommitted files are excluded from
the derived set and named wherever the stage reports what it covered.

**Content source.** A branch-scoped stage reads committed branch content, and the branch it
reads is usually not the one checked out. Read through the ref (`git show <branch>:<path>`),
or, when something needs real files on disk, from a throwaway worktree
(`git worktree add <path> <branch>`) — offered, never created unasked, with
`git worktree remove <path>` offered when the stage ends. **A stage never checks out the
branch it is reading**: the branch a session sits on is not a reading stage's to change, and
another session may be mid-cycle on it. Cutting a *new* topic branch for a stage's own
output is the committing rule above, a different act, and stays allowed.
