# triaging-issues

The playbook behind the `triage-issues` skill: it reads a repo's whole open backlog, verifies the
claims that matter on your branch, and writes a ranked, clustered report with one task text per
cluster and a delta against the last run. It never closes, comments on or labels an issue.

## How it fits

- Up: [the docs hub](../../README.md)
- Entry point: [`skills/triage-issues/SKILL.md`](../../../skills/triage-issues/SKILL.md) is the skill that loads this playbook.
- Shares: [`references/issue-folding.md`](../../../references/issue-folding.md) with `maintaining-the-repo`.
