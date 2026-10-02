---
description: "Mine this repo's sessions and memory for recurring patterns, propose doc and skill edits, and land only what you confirm. Side-effectful — edits docs and deletes promoted memories. Standalone: no cycle is started."
disable-model-invocation: true
---

# /devcycle:learn

Observe → propose → confirm → land. One loop.

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

Follow `${CLAUDE_PLUGIN_ROOT}/playbooks/learning-from-sessions.md`, which owns both invocation
modes — the default and `--preview` — and everything the loop does. It starts no cycle and
writes no state file.

Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.
