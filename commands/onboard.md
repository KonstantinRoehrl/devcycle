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

Use the `devcycle:onboarding-a-repo` skill. It starts no cycle and writes no state file.

Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.
