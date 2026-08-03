---
description: "Profile every devcycle-tagged session under ~/.claude/projects for token cost, context depth, and model routing and rank what to fix — or, given a target file, flag stale devcycle config references against the config changelog. Standalone: no cycle is started."
---

# /devcycle:doctor

Profile token cost, context depth, and model routing, then rank what to fix — or, given
a target file, flag stale devcycle config references against the config changelog. Five
invocations:

- `/devcycle:doctor` — every devcycle-tagged session found under `~/.claude/projects`.
- `/devcycle:doctor --all` — every transcript under `~/.claude/projects`, devcycle-tagged or not.
- `/devcycle:doctor --since <date> --until <date>` — a window.
- `/devcycle:doctor drift <path>` — config-drift mode: flags stale `userConfig`
  references in `<path>` against `references/config-changelog.md`.
- `--json` for machine output; `--depth` for the bare depth probe.

Use the `devcycle:doctor` skill. It starts no cycle and writes no state file.

Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.
