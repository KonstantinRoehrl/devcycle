# Branch discipline

Two rules live here: the rule every committing path follows, and the derivation every
branch-scoped stage runs to turn a branch into a file set. Skills and commands name this
file; none of them restate either rule.

## Committing

Before any stage that commits: if the checkout is on the repo's default branch (resolved
as below) or on an integration branch — `dev`, `develop`, `development`, `integration`,
or one the user names — create a topic branch and write it to the `branch:` line of
`.devcycle/state.md`. Never commit cycle work directly to either.

**Resolving the default branch.** Try, in order, `git symbolic-ref
refs/remotes/origin/HEAD`, then `gh repo view --json defaultBranchRef`, then fall back
to `main` or `master` if one of those branches exists and neither command is available.

**Where this applies.** Every committing path, without exception — the full pipeline's
pre-flight before wave 1, the fast path, the sweep path, re-entry via
`/devcycle:continue` (which settles the branch off the recorded `branch:` line first,
per `${CLAUDE_PLUGIN_ROOT}/references/resume.md`, and falls back to this rule only when
no topic branch was ever recorded), and every standalone, side-effectful skill that
writes and commits outside any cycle — `onboarding-a-repo` (the scaffold write) and
`distilling-learnings` (promotion edits) among them. A standalone skill owns no
`.devcycle/state.md`, so it follows the rule above minus the `branch:`-line write: check
the branch, create a topic branch off the default or an integration branch when needed,
and commit there.

**Per-commit re-check.** Within a stage that commits more than once — `executing-waves`'
per-task commits, the sweep path's per-file commits — re-run the branch check
immediately before *every individual commit*, not only once at stage entry: one `git
rev-parse --abbrev-ref HEAD` compared against the recorded `branch:` line. A mismatch
stops the run and surfaces the discrepancy rather than committing to the wrong branch —
guarding against a concurrent session or worktree switching branches mid-cycle.

## Deriving a branch's file set

Which files a branch-scoped stage reads, and where it reads them from.
`devcycle:auditing-a-repo` and `devcycle:verifying-on-device` both run this derivation.
What a stage then *does* with the file set is that stage's own — the audit expands it to a
feature dependency graph, the verify stage traces it to routes and screens — and is
described there, not here.

**Names first: validate, then quote.** The branch and the base arrive as free-form
arguments and are the only untrusted text in this derivation. Before either reaches any
command, run `git check-ref-format --allow-onelevel "<name>"` and stop the run, naming the
rejected value, if it fails — that is also what rejects a name beginning with `-`, which
git would otherwise read as an option. Then reject any name containing `$`, a backtick, a
quote, `;`, `&`, `|`, `<`, `>`, or a newline: git accepts those in a ref name, the shell
does not, and no `git rev-parse` check helps because the shell expands them before git is
reached. Then spell each validated name the way this clone can resolve it: when `git
rev-parse --verify --quiet "<name>"` finds nothing and `"origin/<name>"` resolves, use
`origin/<name>`; when neither resolves, stop the run naming the unresolvable value. That
holds for the branch exactly as it does for the base — a fetched PR branch nobody has
checked out, and an integration branch on an ordinary clone, each exists only as
`origin/<name>`, and passing either one bare to `git merge-base` fails and trips the stop
below with a wrong diagnosis. Bind the two resolved names to shell variables and reference
them quoted — `"$branch"`, `"$base"` — in every command below and in every other command a
stage builds from them. Never splice a raw name into a command line.

**Base**, in order: an explicitly supplied base; the repo's integration branch — the
committing rule above holds that list — when one exists locally or on the remote; else the
default branch, resolved as above.

**Changed files.** Resolve the merge base as its own step, check it, and only then diff:

```
base_sha=$(git merge-base "$base" "$branch") || stop
git diff --name-only "$base_sha" "$branch"
```

An empty or failed merge base means the two refs do not share history — an unknown ref,
unrelated histories, a shallow clone — and the run **stops and says so**. It never falls
through to `git diff --name-only "$branch"`, which diffs the *working tree* against the
branch and yields a plausible-looking file set that is not the branch's. When the branch
being derived is the checked-out branch and the worktree is dirty, the uncommitted files
are excluded from the derived set and named wherever the stage reports what it covered.

**Content source.** A branch-scoped stage reads committed branch content, and the branch it
reads is usually not the one checked out. Read through the ref (`git show "$branch:<path>"`),
or, when something needs real files on disk, from a throwaway worktree
(`git worktree add <path> "$branch"`) — offered, never created unasked, with
`git worktree remove <path>` offered when the stage ends. **A stage never checks out the
branch it is reading**: the branch a session sits on is not a reading stage's to change, and
another session may be mid-cycle on it. Cutting a *new* topic branch for a stage's own
output is the committing rule above, a different act, and stays allowed.
