---
description: "Triage a PR's review comments into fixes and consented replies. Confirm-first: makes no commit and posts nothing before your first confirmation."
---

# /devcycle:reconcile

Reconcile the pull-request review named in `$ARGUMENTS`. Grammar:
`/devcycle:reconcile branch:<n> [base:<n>] [pr:<n>] [from:paste]`. Follow
`${CLAUDE_PLUGIN_ROOT}/playbooks/receiving-review.md`, which owns the comment intake, the
comment→finding classification, the fix loop, the reply and consent gates, and finish. Do not
restate or replace its process here.

`branch:` is the fact the playbook cannot infer for itself. Given none, the command halts and
requests one instead of assuming whatever happens to be checked out. The optional `base:`,
`pr:`, and `from:paste` tokens are each derived by the playbook when omitted — it resolves the
base and locates the PR itself.

Any `branch:` or `base:` that does not survive the validate-then-quote check in
`${CLAUDE_PLUGIN_ROOT}/references/branch.md` — or that names no live ref once quoted the way
that reference prescribes — aborts the run with the resulting error.

**This run makes no commit and posts no reply before your first confirmation** — it surfaces
conflicting state rather than overwriting it. That confirm-first stance is why the command is
model-invocable, so a wrapper can call it programmatically.

Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.
