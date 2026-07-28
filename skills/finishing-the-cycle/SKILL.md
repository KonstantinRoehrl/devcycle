---
name: finishing-the-cycle
description: Use when a devcycle cycle's gates have all passed and the branch must be handed back, pushed, or turned into a PR per the resolved git policy — the pipeline's finish stage.
---

# Finishing the Cycle

The pipeline's last stage: resolve the effective git policy, act on it, close the
state file. Both `/devcycle:cycle` and `/devcycle:continue` run the finish stage
through this skill — the policy logic lives here and only here. It reports per
`${CLAUDE_PLUGIN_ROOT}/references/output.md`.

## Configured policy

Resolve `${user_config.gitPolicy}` per `${CLAUDE_PLUGIN_ROOT}/references/config.md`:
its allowed values are `local-commits-only` | `push-allowed` | `open-pr`, and its
default is `local-commits-only`. Call the result the **configured policy**. Never
offer the first-run configuration walkthrough here — it belongs to `/devcycle:cycle`
only.

## Resolve the effective policy

If the configured policy is `local-commits-only`, it is already the floor —
effective equals configured, no signal checks needed. Otherwise (`push-allowed` or
`open-pr`), check two signals before pushing anything:

- **Permission-settings signal:** read the effective Claude Code permission
  settings — project `.claude/settings.local.json`, project
  `.claude/settings.json`, user `~/.claude/settings.json`, and any
  managed/enterprise policy file present on this platform (read whichever exist; a
  missing file has no rules). The signal fires if any of them contains a `deny`
  rule whose pattern would match the literal `git push` command — e.g.
  `Bash(git push:*)`, `Bash(git:*)`, or a bare `Bash` deny. An `ask`-only rule
  (no matching `deny`) does NOT fire it — leave the configured policy alone; the
  normal permission prompt at push time communicates the restriction.
- **Protected-branch signal:** resolve the repo's release/default branch exactly as
  `${CLAUDE_PLUGIN_ROOT}/references/branch.md` resolves it — that file owns the
  resolution chain and this stage runs no other. The signal fires if the branch recorded
  in `.devcycle/state.md` (this cycle's branch) IS that default branch — devcycle
  never pushes directly to the repo's default branch.

If either signal fires, the **effective policy** for this run is
`local-commits-only` regardless of the configured value; otherwise effective equals
configured. The clamp is silent (no pause, no question) but always narrated in the
handoff block below.

## Act on the effective policy

- `local-commits-only`: hand the branch back — report branch name and commits; do
  not push, do not open a PR.
- `push-allowed`: push the branch; NEVER merge it.
- `open-pr`: push the branch and open a PR whose title parses as a Conventional
  Commit; do not merge it.

As this stage's final state-file write, set `stage: done` and a fresh `updated:`
timestamp — nothing remains to resume.

## Handoff — the pipeline's final block

Emit the block per `${CLAUDE_PLUGIN_ROOT}/references/handoff.md`, with:

- `Stage completed:` finish.
- `Artifacts:` the branch, plus the PR URL if one was opened.
- `Git policy:` the one line no other stage's block carries, directly after
  `Artifacts:` — the resolved git policy. Not clamped: `Git policy: <value> (no
  override)`. Clamped: `Git policy: configured <value> → effective
  local-commits-only (<reason>)`, where `<reason>` is `a permission rule denies git
  push`, `current branch is the repo's default branch — direct pushes to it are not
  allowed`, or both joined with `; ` if both signals fired.
- `Carry-overs:` whatever is genuinely left open, or `none`.
- `Context action:` Continue — the cycle is over, nothing follows.
- `Compaction hint:` Keep nothing. The cycle is done.
