---
description: Resume an in-flight devcycle pipeline from .devcycle/state.md after /clear or a new session.
disable-model-invocation: true
---

# /devcycle:continue

Resume a devcycle pipeline in this repo. This session may hold no memory of the
cycle — that is expected and fine: **files are the state; the conversation is a
cache.** Trust the files below over conversation memory and over anyone's
recollection, including the user's.

Every ask in this command is a gate on a live run record — the chosen state file's `run:` — and so
is every gate of the stage it resumes: an Other answer at any of them appends
`user-correction-at-gate` to that run; read `${CLAUDE_PLUGIN_ROOT}/references/ledger.md` § The run
record's `event` row for its fields.

## Re-derive position from files

1. Enumerate every resumable cycle by running
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/find-state-files.mjs` — it Node-walks this repo for
   every `.devcycle/state.md` and prints each with its request, branch, stage, last ledger
   event, and age. Use its output as the candidate list; do not hand-roll a `find`/`rg`
   search. `.devcycle/` is gitignored by convention, and a default-gitignore-aware search tool
   (a shell hook rewriting `find`, `rg` without `--no-ignore`) silently drops paths under it —
   the script consults no gitignore, so it cannot be blinded, which is the whole reason this
   step runs it rather than a search. **Ask which one** — never pick. Resuming the wrong cycle
   silently is the failure this enumeration exists to prevent. With exactly one candidate,
   still name it before resuming. If the script reports none, say so plainly ("no devcycle
   state file found in this repo — there is no in-flight cycle to resume") and offer
   `/devcycle:cycle <description>` to start one. Stop there.
2. Run the ownership check on the chosen file before trusting anything in it, per
   `${CLAUDE_PLUGIN_ROOT}/references/resume.md`. A `root:` mismatch stops the
   resume and goes to the user; it is never resolved silently. Once it passes, append this
   session's line to the run record the state file's `run:` row names — `node
   ${CLAUDE_PLUGIN_ROOT}/scripts/run-record.mjs append --run <that id> --kind session
   --sessionId "$CLAUDE_CODE_SESSION_ID"` — one append per real session, never a merge or
   update of a prior line, since a `/clear` always mints a new `$CLAUDE_CODE_SESSION_ID`.
2a. Validate the state file against on-disk reality before trusting it — `node
   ${CLAUDE_PLUGIN_ROOT}/scripts/resume-check.mjs --state <the chosen state file>`. A non-zero exit
   means `state.md` is stale (a recorded spec/plan/checklist artifact is gone, the recorded branch no
   longer exists — a leftover from a completed or abandoned cycle — or the stage is not a real enum
   value): surface the specific finding and ask the user how to proceed rather than
   continuing on the stale record. On success it also prints the stage's `entry:` and `note:`
   lines; when the `note:` names a human-required step, re-walk that step on resume rather than
   assuming a stale `state.md` already cleared it.
2b. Resolve knobs per `${CLAUDE_PLUGIN_ROOT}/references/config.md` § Knob channel — only now,
   once the ownership check and `resume-check` have passed:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-knobs.mjs" \
  --profile '${user_config.profile}' \
  --gitPolicy '${user_config.gitPolicy}' \
  --docTrackingPolicy '${user_config.docTrackingPolicy}' \
  --reviewDepth '${user_config.reviewDepth}' \
  --crossModelReview '${user_config.crossModelReview}' \
  --onDeviceGate '${user_config.onDeviceGate}' \
  --implementerModel '${user_config.implementerModel}' \
  --taskReviewerModel '${user_config.taskReviewerModel}' \
  --branchReviewModel '${user_config.branchReviewModel}' \
  --walkthroughModel '${user_config.walkthroughModel}' \
  --learnStalenessSessions '${user_config.learnStalenessSessions}' \
  --learnStalenessDays '${user_config.learnStalenessDays}' \
  --learnSessionCap '${user_config.learnSessionCap}'
```

   When the state file carries a `- knobs:` line, rerun that command with `--compare '<that
   line>'` appended. No output → proceed. Any output (`key: old → new` lines) → show it and ask
   ONE question, the knob-change question, unless a `- knobs-declined:` row skips it:
   **apply for the rest of this cycle**, rewriting `- knobs:` from the fresh line, or **keep this
   cycle's values**, leaving `- knobs:` as it is. Whatever the comparison printed, update the
   `knobs-declined:`/`knobs-changed:` rows and record an apply as
   `${CLAUDE_PLUGIN_ROOT}/references/resume.md` § The state file specifies. A state
   file with no `- knobs:` line gets one written from the fresh line without asking. Then the
   drift notice, per § Knob channel.
3. Read only what this stage's resume needs: the state file always and, beyond it —
   - `execution`: the ledger it names (`.devcycle/ledger.md`) and the plan's Dispatch Map;
   - `planning` with a plan awaiting approval: the plan;
   - `brainstorm`, or `planning` with a spec under approval: the spec;
   - `on-device`: the checklist;
   - any other stage: nothing further.

   Each is on `references/delegation.md`'s exempt list, which is why it is read directly. The
   entered stage's playbook still reads whatever its own steps require.
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
node "${CLAUDE_PLUGIN_ROOT}/scripts/depth-probe.mjs"
```

If it reports `over-budget` or `hard-stop`, say so and STOP: report the depth and the band,
and tell the user this session is already too deep to resume into — `/clear` first, then
`/devcycle:continue` again. Resuming anyway is the user's explicit call, not yours. If the
probe exits non-zero, say the depth could not be measured, name its one-line reason, and
proceed — an unmeasurable depth is not a deep one.

Continue at the recorded stage by following the `entry:` and `note:` lines step 2a's
`resume-check.mjs` printed. If it printed `no entry line`, report its reason, then read
`${CLAUDE_PLUGIN_ROOT}/references/resume.md` § Resuming at the recorded stage, which names the
file that owns the dispatch. If it printed `closed:`, the cycle is done — say so and stop.

From there the pipeline behaves exactly as under `/devcycle:cycle`: state-file updates, and at
every stage boundary read `${CLAUDE_PLUGIN_ROOT}/references/handoff.md` and emit its block.

Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.
