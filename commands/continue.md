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

1. Find every resumable cycle: each `.devcycle/state.md` under this repo root, searched with
   gitignore filtering disabled — `.devcycle/` is itself gitignored by convention, so a
   default-gitignore-aware search tool (a shell hook rewriting `find`, `rg` without
   `--no-ignore`) can silently report none found even when a state file exists.
   List them with branch, stage, last ledger event, and age, and **ask which
   one** — never pick. Resuming the wrong cycle silently is the failure this
   enumeration exists to prevent. With exactly one candidate, still name it
   before resuming. If there are none, say so plainly ("no devcycle state file
   found in this repo — there is no in-flight cycle to resume") and offer
   `/devcycle:cycle <description>` to start one. Stop there.
2. Run the ownership check on the chosen file before trusting anything in it, per
   `${CLAUDE_PLUGIN_ROOT}/references/resume.md`. A `root:` mismatch stops the
   resume and goes to the user; it is never resolved silently. Once it passes, append this
   session's line to the run record the state file's `run:` row names — `node
   ${CLAUDE_PLUGIN_ROOT}/scripts/run-record.mjs append --run <that id> --kind session
   --sessionId "$CLAUDE_CODE_SESSION_ID"` — one append per real session, never a merge or
   update of a prior line, since a `/clear` always mints a new `$CLAUDE_CODE_SESSION_ID`.
3. Read the ledger it names (`.devcycle/ledger.md`) and the plan/spec/
   checklist paths it records, where present.
4. Settle the branch and derive position from git evidence per
   `${CLAUDE_PLUGIN_ROOT}/references/resume.md` — falling back to
   `${CLAUDE_PLUGIN_ROOT}/references/branch.md` only when no topic branch was
   ever recorded. **The mismatch rule that file defers to is this command's
   own:** when the current branch differs from the recorded one, tell the user
   and ask before switching; never switch branches silently. During execution,
   never re-dispatch a task the ledger records as committed.

Both asks above are gates — which cycle to resume, and whether to switch
branches — and a resume already carries a run record, so an Other answer at
either appends `user-correction-at-gate` to the run the chosen state file names,
whose rule `${CLAUDE_PLUGIN_ROOT}/references/ledger.md` owns.

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

Continue at the recorded stage via the stage table in
`${CLAUDE_PLUGIN_ROOT}/references/resume.md` § Resuming at the recorded stage, which names each
stage's playbook and its re-entry conditions.

From there the pipeline behaves exactly as under `/devcycle:cycle`: state-file updates and a
handoff block at every stage boundary, per `${CLAUDE_PLUGIN_ROOT}/references/handoff.md` — and,
step 2 having put this session on a live run record, an Other answer at any gate of a resumed
stage appends `user-correction-at-gate`, whose rule `${CLAUDE_PLUGIN_ROOT}/references/ledger.md` owns.
