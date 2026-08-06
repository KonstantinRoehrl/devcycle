---
description: "Mine this repo's sessions and memory for recurring patterns, propose doc and skill edits, and land only what you confirm. Side-effectful — edits docs and deletes promoted memories. Standalone: no cycle is started."
disable-model-invocation: true
---

# /devcycle:learn

Observe → propose → confirm → land. One loop.

- `/devcycle:learn` — the whole loop. Every promotion is batched for confirmation before it
  lands; each memory is deleted only once its promotion has landed.
- `/devcycle:learn --preview` — mine and propose, write the dated artifact, land nothing,
  delete no memory.

Follow `${CLAUDE_PLUGIN_ROOT}/playbooks/learning-from-sessions.md`. It starts no cycle and
writes no state file.

Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.
