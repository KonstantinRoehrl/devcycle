---
description: "Review a branch, a repository, or a file set against criteria you confirm, and produce a ranked findings document — the produce arm of the review write-back path, with an opt-in file step on an open PR. Standalone: no cycle is started."
---

# /devcycle:review

Review code against criteria, ranked by severity, impact and fix complexity, each finding with
file-referenced evidence and a concrete fix. Three scopes:

- `/devcycle:review branch:<name> [base:<name>]` — the diff of that branch, against the named
  base when one is given.
- `/devcycle:review` — this repository.
- `/devcycle:review <path> [<path>…]` — a file set.

Invoked standalone, every scope confirms its criteria at an interview first and produces a ranked
findings document; `branch` scope against an open PR can then opt in to filing those findings back
as PR review comments, the file arm of the review write-back path
(`${CLAUDE_PLUGIN_ROOT}/playbooks/reviewing-code.md` §5). Only the in-cycle branch-review stage
skips the interview and returns its findings inline.

**`$ARGUMENTS` grammar — explicit tokens, never inference. This command owns it; the playbook
consumes the branch it is handed and does not re-derive the syntax.** A `branch:<name>` token
anywhere in the string selects the branch scope, optionally with a `base:<name>` token naming
the base to diff against. Everything else is the file set when the arguments are paths in this
repo, and otherwise the concern to review: a bare argument is **always** the concern and is
never guessed to be a branch, even in a repo that happens to have a branch by that name —
`/devcycle:review security` reviews the whole repo for security. A `branch:` or `base:` value
that fails the validate-then-quote rule in `${CLAUDE_PLUGIN_ROOT}/references/branch.md`, or that
resolves to no ref once spelled as that reference spells it, stops the run with that error
rather than falling back to treating it as a concern.

Follow `${CLAUDE_PLUGIN_ROOT}/playbooks/reviewing-code.md`. It starts no cycle and writes no
state file.

Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.
