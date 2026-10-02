---
description: "Walk an on-device checklist derived from a branch's diff, on the running app. Standalone: no cycle is started."
---

# /devcycle:verify

Verify on-device the branch named in `$ARGUMENTS`. Follow
`${CLAUDE_PLUGIN_ROOT}/playbooks/verifying-on-device.md`, which owns the checklist-source
resolution, the diff-derived generation, the walkthrough, the gate, and the standalone
reporting rules. Do not restate or replace its process here.

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

**This run is standalone: no cycle, and this command is not a pipeline stage.** That, plus
**which branch supplies the diff**, are the two facts the playbook cannot derive on its own, and
together they select its diff-derived, standalone behavior over its in-cycle behavior.
`$ARGUMENTS` may name a base after the branch; without one the playbook derives it.

An empty `$ARGUMENTS` names no branch, so there is nothing to verify: the run stops and asks
for one rather than guessing the checked-out branch. A branch or base that fails the
validate-then-quote rule in `${CLAUDE_PLUGIN_ROOT}/references/branch.md`, or that resolves to
no ref once spelled as that reference spells it, stops the run with that error.

Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.
