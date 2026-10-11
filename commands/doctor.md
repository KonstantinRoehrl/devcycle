---
description: "Profile every devcycle-tagged session under ~/.claude/projects for token cost, context depth, and model routing and rank what to fix — or, given a target file, flag stale devcycle config references against the config changelog. Standalone: no cycle is started."
---

# /devcycle:doctor

Profile token cost, context depth, and model routing, then rank what to fix — or, given
a target file, flag stale devcycle config references against the config changelog. Five
invocations:

- `/devcycle:doctor` — every devcycle-tagged session found under `~/.claude/projects` (`$CLAUDE_CONFIG_DIR/projects` when set).
- `/devcycle:doctor --all` — every transcript under `~/.claude/projects` (`$CLAUDE_CONFIG_DIR/projects` when set), devcycle-tagged or not.
- `/devcycle:doctor --since <date> --until <date>` — a window.
- `/devcycle:doctor drift <path>` — config-drift mode: flags stale `userConfig`
  references in `<path>` against `docs/configuration/config-changelog.md`.
- `--json` for machine output; `--depth` for the bare depth probe.

Every cost-analysis reply carries the per-version and per-stage overview and a closing trend
summary (`--depth` and `drift` print neither); the playbook owns what they contain.

Follow `${CLAUDE_PLUGIN_ROOT}/playbooks/profiling-sessions.md`. It starts no cycle and writes no state file.

Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.
