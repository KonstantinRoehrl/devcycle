# writing-issues

The playbook behind the `write-issue` skill: it turns a rough problem, idea or finding into a
complete issue a future agent session can pick up cold. It verifies each claim against the code,
screens the draft for private names, checks for duplicates, and files, edits or comments only
after you confirm the shown draft and its target.

## How it fits

- Up: [the docs hub](../../README.md)
- Entry point: [`skills/write-issue/SKILL.md`](../../../skills/write-issue/SKILL.md) is the skill that loads this playbook.
- Reuse: [`playbooks/profiling-sessions.md`](../../../playbooks/profiling-sessions.md) reuses its context section.
