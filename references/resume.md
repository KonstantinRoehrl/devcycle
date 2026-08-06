# Resuming a run (`/devcycle:continue`)

How any stage re-enters itself after an interruption. Skills name this file; none of
them restate it.

## The state file

A cycle's file lives at `<repo root>/.devcycle/state.md`, where repo root is
`git rev-parse --show-toplevel` of the working directory, and nowhere else: never adopt
one found in a parent directory or another project's checkout. `/devcycle:cycle` writes
it as its first action and every stage rewrites it at every transition, in this shape:

```markdown
# devcycle state
- stage: <the stage to RESUME at; the enum lives in commands/cycle.md>
- root: <absolute repo toplevel this cycle belongs to>
- branch: <git branch>
- request: <one line: what this cycle is building/fixing>
- scope: <path or none>
- audit: <path or none>
- diagnosis: <path or none>
- spec: <path or none>
- plan: <path or none>
- ledger: .devcycle/ledger.md
- checklist: <path or none>
- configured: <no | defaults | date + KEY=VALUE list (possibly empty)>[ · profile-asked]
- updated: <ISO-8601 UTC>
```

`stage:` names the stage the NEXT session resumes at, never the one just completed.
`configured:` records what configuration was written for this repo and is carried
forward unchanged when a new cycle reuses the file; `references/config.md` owns what
its values mean.

**The ownership check, run before trusting anything else in the file.** `root:` and
`request:` pin it to one project and one goal, so every reader verifies `root:` against
its own `git rev-parse --show-toplevel` first. A differing `root:` means the file
belongs to another checkout or leaked from another project: never resume it and never
silently reset it — report what its `root:` and `request:` say versus where you are,
and let the user choose between adopting it (the repo genuinely moved: rewrite `root:`,
keep everything else) and leaving it alone. A file with no `root:` line predates this
format and is not foreign: adopt it by writing `root:` and `request:` at the next
rewrite.

## Settle the branch first, before reading anything else

On re-entry, settle the branch before any edit, any git-evidence check, and any
dispatch — keyed off the `branch:` line RECORDED in `.devcycle/state.md`, not off
whatever the checkout currently happens to be on (parallel sessions share the
checkout and may have switched it back to the integration branch):

- If the state file records a topic branch, resume means getting the checkout onto
  that branch — `commands/continue.md`'s recorded-vs-current mismatch rule already
  covers asking the user before switching; never switch silently. Never create a
  fresh topic branch when one is recorded: the recorded branch is where any
  committed work lives.
- Only if the recorded branch is still the default or an integration branch does
  branch discipline (`references/branch.md`) apply — an interrupted run may have
  stopped before the topic branch was ever created. Create it and record it on the
  `branch:` line as branch discipline requires.

## Then derive position from git evidence

Only once the checkout is on the recorded branch, re-derive position from git
evidence on that branch rather than trusting conversation memory:

| git evidence | resume action |
| --- | --- |
| change absent, or present but uncommitted | (re)implement |
| change committed | dispatch the task reviewer |

A stage that records its own commit marker in `.devcycle/state.md` (e.g. a
`sweepCommit:` line) checks that marker FIRST and treats the commit as present when
`git merge-base --is-ancestor <sha> <branch>` exits 0 — never guessed from the log.
A stage may add evidence rows of its own for states this table does not name; it may
never weaken the two rows above.

## Review acceptance is never inferable from git

A reviewed commit and an unreviewed one look identical. Acceptance is recorded only
by the stage advancing `stage:` in `.devcycle/state.md`, at which point
`/devcycle:continue` routes onward and never re-enters that stage. So on resume, an
existing commit with no recorded verdict is always treated as committed but not yet
accepted: dispatch the reviewer. A redundant re-review after an interruption is the
safe failure mode; skipping the reviewer because a commit exists is not.
