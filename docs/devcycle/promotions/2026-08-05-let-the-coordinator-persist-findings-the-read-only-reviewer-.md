# Let the coordinator persist findings the read-only reviewer returns
- promotion-type: enforcement-gap
- cluster-signature: reviewer instructed to write a findings file without a write tool
- files-touched: agents/task-reviewer.md, skills/executing-waves/SKILL.md
- landed: 2026-08-05
- commit: a0a2cf1 + 03199cf
- superseded-by: cycle 9d661cd3e5a9bfe3 (2026-08-28), issue #107 — reviewer given a scoped write tool
- note: the coordinator-persists resolution did not hold — the reviewer now writes its own findings file.
