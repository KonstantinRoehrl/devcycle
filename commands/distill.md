---
description: "Review this repo's accumulated auto-memory for a codified promotion session: memory to vetted doc/skill edits, plus a devcycle config-drift check since the last run. Side-effectful — edits docs/skills and deletes promoted memories. Standalone: no cycle is started."
disable-model-invocation: true
---

# /devcycle:distill

Review accumulated memory for this repo and promote what's ready into docs or skills.
Checks for devcycle config drift since the last distill run, using
`${CLAUDE_PLUGIN_ROOT}/playbooks/profiling-sessions.md`'s drift engine. Batches every proposed promotion for confirmation
before applying anything, and deletes each memory once its promotion lands.

Use the `${CLAUDE_PLUGIN_ROOT}/playbooks/distilling-learnings.md` skill. It starts no cycle and writes no
`.devcycle/state.md` (it keeps its own small checkpoint at
`.devcycle/distilling-state.md`).

Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.
