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
this run (same-session substitution cannot refresh). Then: `local-commits-only`
= hand the branch back (report branch and commits; no push, no PR);
`push-allowed` = push the branch, NEVER merge; `open-pr` = push and open a PR
with a Conventional-Commit title, do not merge. Treat any other value as
invalid and fall back to the default. Never offer the first-run configuration
walkthrough here — it belongs to `/devcycle:cycle` only.

From there the pipeline behaves exactly as under `/devcycle:cycle`: state-file
updates and a handoff block at every stage boundary.
