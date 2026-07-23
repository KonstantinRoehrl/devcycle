---
description: Resume an in-flight devcycle pipeline from .devcycle/state.md after /clear or a new session.
disable-model-invocation: true
---

# /devcycle:continue

Resume a devcycle pipeline in this repo. This session may hold no memory of the
cycle — that is expected and fine: **files are the state; the conversation is a
cache.** Trust the files below over conversation memory and over anyone's
recollection, including the user's.

## Re-derive position from files

1. Read `.devcycle/state.md`. If it does not exist, say so plainly ("no devcycle
   state file found in this repo — there is no in-flight cycle to resume") and offer
   `/devcycle:cycle <description>` to start one. Stop there.
2. Read the ledger it names (`.superpowers/sdd/progress.md`) and the plan/spec/
   checklist paths it records, where present.
3. Cross-check git: current branch vs the recorded branch — on a mismatch, tell
   the user and ask before switching; never switch branches silently. Check
   `git log` for commits the ledger references. During execution, never
   re-dispatch a task the ledger records as committed.

## Announce the derived position

Before doing anything else, tell the user where the cycle stands, from file evidence
only: current stage and branch, artifact paths, and — during execution — per-task
status from the ledger (committed / in review / not yet dispatched) plus the concrete
next action. If the user's recollection contradicts the files, follow the files and
say so.

## Resume

Continue at the recorded stage via its skill:

| stage | resume via |
| --- | --- |
| scoping | `devcycle:scoping-interview` |
| brainstorm | `superpowers:brainstorming` — with devcycle's batching note (restated here because this session may never load `/devcycle:cycle`): where upstream asks questions one at a time, ask via AskUserQuestion in batches of 1–4 with concrete options plus Other |
| planning | `devcycle:planning-waves` |
| execution | `devcycle:executing-waves` (its resume table maps each task's last ledger event to the resume action) |
| branch-review | `devcycle:reviewing-the-branch` |
| on-device | `devcycle:verifying-on-device` |
| finish | see below |

**Finish stage git policy** (read here, because this session may never load
`/devcycle:cycle`): `${user_config.gitPolicy}` — if that value still begins with
the literal text `${user_config`, the option is unset; use the default
`local-commits-only`. If the placeholder is literal but the state file's
`configured:` line records a `gitPolicy=` value, that recorded value governs
this run (same-session substitution cannot refresh). Treat any other value as
invalid and fall back to the default. Call this the **configured policy**.

**Resolve effective policy** before acting. If the configured policy is
`local-commits-only`, it is already the floor — use it as-is, no signal checks needed.
Otherwise (`push-allowed` or `open-pr`), check two signals: (1) a `deny` rule matching
the literal `git push` command (e.g. `Bash(git push:*)`, `Bash(git:*)`, or a bare `Bash`
deny) in any of project `.claude/settings.local.json`, project `.claude/settings.json`,
user `~/.claude/settings.json`, or a managed/enterprise policy file present on this
platform (an `ask`-only rule does not count); (2) the branch recorded in
`.devcycle/state.md` for this cycle IS the repo's release/default branch, resolved via,
in order, `git symbolic-ref refs/remotes/origin/HEAD`, then `gh repo view --json
defaultBranchRef`, then a `main`/`master` fallback if one of those branches exists and neither command is available. If either signal fires, the
**effective policy** is `local-commits-only` regardless of the configured value;
otherwise effective equals configured. This clamp is silent (no pause, no question) but
always narrated in the Handoff block below.

Then, act on the effective policy: `local-commits-only` = hand the branch back (report
branch and commits; no push, no PR); `push-allowed` = push the branch, NEVER merge;
`open-pr` = push and open a PR with a Conventional-Commit title, do not merge. Never
offer the first-run configuration walkthrough here — it belongs to `/devcycle:cycle`
only.

The Handoff block always includes a `Git policy:` line stating the effective policy.
When it was not clamped: `Git policy: <value> (no override)`. When it was clamped:
`Git policy: configured <value> → effective local-commits-only (<reason>)`, where
`<reason>` is `a permission rule denies git push`, `current branch is the repo's default
branch; direct pushes to it are not allowed`, or both joined with `; ` if both signals
fired.

From there the pipeline behaves exactly as under `/devcycle:cycle`: state-file
updates and a handoff block at every stage boundary.
