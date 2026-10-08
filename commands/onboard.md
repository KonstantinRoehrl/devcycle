---
description: "Bootstrap tier-2 setup in this repo: detect real build/test/lint commands from manifests and CI config, scaffold CLAUDE.md and per-package rules, propose a permission allowlist, and wire the verification command devcycle's green gate will use. Side-effectful — writes files. Standalone: no cycle is started."
disable-model-invocation: true
---

# /devcycle:onboard

Bootstrap this repo's tier-2 setup. Detects real commands rather than guessing them,
scaffolds `CLAUDE.md` (root and, in a monorepo, per package), and proposes a permission
allowlist for confirmation before writing it.

Re-running on an already-onboarded repo detects the existing scaffold and offers
update/merge — it never silently overwrites.

Resolve knobs first, per `${CLAUDE_PLUGIN_ROOT}/references/config.md` § Knob channel — run this exactly as rendered:

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
  --learnSessionCap '${user_config.learnSessionCap}' \
  --subagentBudget '${user_config.subagentBudget}'
```

Follow `${CLAUDE_PLUGIN_ROOT}/playbooks/onboarding-a-repo.md`. It starts no cycle and writes no state file.

Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.
