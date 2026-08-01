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

1. Read the state file at exactly `<repo root>/.devcycle/state.md`, where repo
   root is `git rev-parse --show-toplevel` of the current working directory —
   never a state file found anywhere else (a parent directory, a sibling
   checkout, a search hit). If it does not exist, say so plainly ("no devcycle
   state file found in this repo — there is no in-flight cycle to resume") and offer
   `/devcycle:cycle <description>` to start one. Stop there.
2. **Ownership check before trusting anything in it:** if the file's `root:`
   line differs from the current repo root, it belongs to another checkout or
   leaked from another project — STOP. Report what its `root:` and `request:`
   say versus where you are, and do not resume; the user chooses between
   adopting it (the repo genuinely moved — rewrite `root:`, then proceed) and
   leaving it alone. A file with no `root:` line predates this format: adopt it
   by writing `root:` and `request:` at the next rewrite.
3. Read the ledger it names (`.devcycle/ledger.md`) and the plan/spec/
   checklist paths it records, where present.
4. Settle the branch and derive position from git evidence per
   `${CLAUDE_PLUGIN_ROOT}/references/resume.md` — falling back to
   `${CLAUDE_PLUGIN_ROOT}/references/branch.md` only when no topic branch was
   ever recorded. **The mismatch rule that file defers to is this command's
   own:** when the current branch differs from the recorded one, tell the user
   and ask before switching; never switch branches silently. During execution,
   never re-dispatch a task the ledger records as committed.

## Announce the derived position

Before doing anything else, tell the user where the cycle stands, from file evidence
only: the recorded `request:` (so a wrong-project state is spotted instantly), current
stage and branch, artifact paths, and — during execution — per-task status from the
ledger (committed / in review / not yet dispatched) plus the concrete next action. If
the user's recollection contradicts the files, follow the files and say so.

## Resume

**Depth check first.** Before resuming any stage, run

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --depth
```

If it reports `over-budget` or `hard-stop`, say so and STOP: report the depth and the band,
and tell the user this session is already too deep to resume into — `/clear` first, then
`/devcycle:continue` again. Resuming anyway is the user's explicit call, not yours. If the
probe exits non-zero, say the depth could not be measured, name its one-line reason, and
proceed — an unmeasurable depth is not a deep one.

Continue at the recorded stage via its skill:

| stage | resume via |
| --- | --- |
| scoping | `devcycle:scoping-interview` |
| audit | `devcycle:auditing-a-repo` — re-reads the confirmed criteria from the state file's `audit:` artifact if one was written, otherwise re-runs the criteria interview; never assumes criteria a previous session did not record |
| diagnosis | `superpowers:systematic-debugging` — bugs only (restated here because this session may never load `/devcycle:cycle`): reproduce first, isolate the root cause, and end the stage by writing the root-cause report (reproduction steps, established cause with evidence, surfaces involved) to `.devcycle/diagnosis.md`, recording it in the state file's `diagnosis:` line; the fix's design belongs to brainstorm, which takes that report as explored context |
| brainstorm | `superpowers:brainstorming` — with devcycle's batching note (restated here because this session may never load `/devcycle:cycle`): where upstream asks questions one at a time, ask via AskUserQuestion in batches of 1–4 with concrete options plus Other |
| planning | `devcycle:planning-waves` |
| execution | `devcycle:executing-waves` (its resume table maps each task's last ledger event to the resume action) |
| branch-review | `devcycle:reviewing-the-branch` |
| on-device | `devcycle:verifying-on-device` |
| fast-path | `devcycle:fast-path` (its Resume section, which follows `${CLAUDE_PLUGIN_ROOT}/references/resume.md`) |
| sweep | `devcycle:sweeping-mechanical-changes` (its Resume section, which follows `${CLAUDE_PLUGIN_ROOT}/references/resume.md`) |
| finish | `devcycle:finishing-the-cycle` — it owns the whole stage: gitPolicy resolution, the external-push-signal clamp, acting on the effective policy, the `Git policy:` handoff line, and the `stage: done` close |

From there the pipeline behaves exactly as under `/devcycle:cycle`: state-file
updates and a handoff block at every stage boundary, per
`${CLAUDE_PLUGIN_ROOT}/references/handoff.md`.
