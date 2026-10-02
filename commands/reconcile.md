---
description: "Respond to a PR's review comments — the respond arm of the review write-back path, triaging them into fixes and consented replies. Confirm-first: makes no commit and posts nothing before your first confirmation."
---

# /devcycle:reconcile

Reconcile the pull-request review named in `$ARGUMENTS`. Grammar:
`/devcycle:reconcile branch:<n> [base:<n>] [pr:<n>] [from:paste]`. Follow
`${CLAUDE_PLUGIN_ROOT}/playbooks/receiving-review.md`, which owns the comment intake, the
comment→finding classification, the fix loop, the reply and consent gates, and finish. Do not
restate or replace its process here.

Resolve knobs first — run this exactly as rendered; `${CLAUDE_PLUGIN_ROOT}/references/config.md` § Knob channel owns what follows:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-knobs.mjs" \
  --profile '${user_config.profile}' \
  --gitPolicy '${user_config.gitPolicy}' \
  --docTrackingPolicy '${user_config.docTrackingPolicy}' \
  --reviewDepth '${user_config.reviewDepth}' \
  --crossModelReview '${user_config.crossModelReview}' \
  --onDeviceGate '${user_config.onDeviceGate}' \
  --implementerModel '${user_config.implementerModel}' \
  --taskReviewerModel '${user_config.taskReviewerModel}' \
  --branchReviewModel '${user_config.branchReviewModel}' \
  --walkthroughModel '${user_config.walkthroughModel}' \
  --learnStalenessSessions '${user_config.learnStalenessSessions}' \
  --learnStalenessDays '${user_config.learnStalenessDays}' \
  --learnSessionCap '${user_config.learnSessionCap}'
```

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
