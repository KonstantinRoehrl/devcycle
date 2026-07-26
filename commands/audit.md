---
description: "Audit this repo against criteria you confirm, and write a ranked findings document. Standalone: no cycle is started."
---

# /devcycle:audit

Audit this repo for the concern in `$ARGUMENTS` via the `devcycle:auditing-a-repo`
skill, which owns the criteria interview, the sweep, and the findings document at
`docs/audits/YYYY-MM-DD-<topic>.md`. Do not restate or replace its process here.

**Standalone, outside any cycle.** This command is not a pipeline stage:

- It neither creates nor requires `.devcycle/state.md`. If one exists it belongs to
  an unrelated in-flight cycle — leave it untouched, and do not write a `stage:` or
  an `audit:` line for this run. (Inside a cycle the audit stage is entered by
  `/devcycle:cycle`'s triage and resumed by `/devcycle:continue`, which is where
  state-file bookkeeping and handoff blocks belong.)
- It ends at the findings document. Report where the document was written and what
  it ranks highest — then stop. Turning a finding into work is the user's separate,
  explicit call, via `/devcycle:cycle <request>`; never chain into a cycle, a
  brainstorm, or a fix from here.

The only repo change this command makes is its own findings document — but that
document gets committed, and a commit is a commit: if the checkout sits on the default
or an integration branch, the skill cuts a topic branch for it per
`${CLAUDE_PLUGIN_ROOT}/references/branch.md`. What it does not do is record that branch
anywhere: with no cycle and no state file of its own, there is nothing to write to.
Any repo change proposed out of an audit belongs to the cycle the user starts
afterwards, under the same rule.

Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.
