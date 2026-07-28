---
description: "Audit this repo — or one branch, via a branch:<name> argument — against criteria you confirm, and write a ranked findings document. Standalone: no cycle is started."
---

# /devcycle:audit

Audit this repo — or one branch of it — per `$ARGUMENTS` (grammar below) via the
`devcycle:auditing-a-repo` skill, which owns the criteria interview, the sweep, the findings document at
`docs/audits/YYYY-MM-DD-<topic>.md`, and — in its steps 5 and 6 — the branch,
state-file, and stop-at-the-document rules. Do not restate or replace its process
here.

**This run is standalone: no cycle, and this command is not a pipeline stage.** That is the
one fact the skill cannot derive on its own, and it is what selects the skill's standalone
behavior over its in-cycle behavior.

**`$ARGUMENTS` grammar — explicit tokens, never inference. This command owns it; the skill
consumes the branch it is handed and does not re-derive the syntax.** A `branch:<name>` token
anywhere in the string selects the skill's branch-scoped mode, optionally with a
`base:<name>` token naming the base to diff against. Everything else in the string is the
concern to audit. So `/devcycle:audit branch:feat/csv-export security` audits that branch
for security, and `/devcycle:audit branch:feat/csv-export base:dev` audits it against `dev`.

A bare argument is **always** the concern and is never guessed to be a branch, even in a repo
that happens to have a branch by that name: `/devcycle:audit security` audits the whole repo
for security. No `branch:` token means the whole repo or a named subsystem, settled at the
skill's interview as before. A `branch:` token naming a ref that does not resolve
(`git rev-parse --verify <name>`) stops the run with that error rather than falling back to
treating it as a concern.

Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.
