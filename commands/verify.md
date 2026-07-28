---
description: "Walk an on-device checklist derived from a branch's diff, on the running app. Standalone: no cycle is started."
---

# /devcycle:verify

Verify on-device the branch named in `$ARGUMENTS` via the `devcycle:verifying-on-device`
skill, which owns the checklist-source resolution, the diff-derived generation, the
walkthrough, the gate, and the standalone reporting rules. Do not restate or replace its
process here.

**This run is standalone: no cycle, and this command is not a pipeline stage.** That, plus
**which branch supplies the diff**, are the two facts the skill cannot derive on its own, and
together they select the skill's diff-derived, standalone behavior over its in-cycle behavior.
`$ARGUMENTS` may name a base after the branch; without one the skill derives it.

Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.
