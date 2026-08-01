---
description: "Profile this session's or the whole transcript history's token cost, context depth, and model routing, and rank what to fix. Standalone: no cycle is started."
---

# /devcycle:doctor

Profile token cost, context depth, and model routing, then rank what to fix. Four
invocations:

- `/devcycle:doctor` — this session.
- `/devcycle:doctor --all` — every transcript under `~/.claude/projects`.
- `/devcycle:doctor --since <date> --until <date>` — a window.
- `--json` for machine output; `--depth` for the bare depth probe.

Use the `devcycle:doctor` skill. It starts no cycle and writes no state file.

Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.
