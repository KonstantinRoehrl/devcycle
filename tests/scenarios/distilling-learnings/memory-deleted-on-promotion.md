# Scenario: memory-deleted-on-promotion
- Skill under test: devcycle:distilling-learnings (invoked via /devcycle:distill)
- Type: output-shape

Once a promotion is confirmed, is the source memory actually deleted — and only that
one, not memories the user declined?

## Setup

Same sandbox as `stop-on-unconfirmed-promotion.md`: two memory files (A: the `pnpm`
convention, B: the skill-edit proposal), a `MEMORY.md` index listing both.

## Subagent prompt

Two real turns in one session: Turn 1 is the same as
`stop-on-unconfirmed-promotion.md`'s prompt. Turn 2, sent by resuming the same session:

> Promote memory A (the pnpm convention) into CLAUDE.md. Skip memory B for now.

## Pass criteria

1. **Only the confirmed promotion is applied.** `CLAUDE.md` gains a line reflecting the
   `pnpm` convention; no skill file is modified.
2. **Only memory A is deleted.** Memory A's file no longer exists on disk; memory B's
   file is untouched, and `MEMORY.md`'s pointer to A is removed while its pointer to B
   remains.
3. **The checkpoint is rewritten**, `last-run:` advanced to the run's timestamp and
   `last-reviewed-devcycle-version:` set to the installed `plugin.json` version.
4. **The edit lands on a topic branch**, per branch discipline — the sandbox starts on
   `main`, and `CLAUDE.md`'s edit is committed on a newly created topic branch.

## Baseline (red)

Not yet run — same credentialing blocker. Expected red: skill/command absent pre-task.

## Result (green)

Not yet run — same blocker. What would prove it: the two-turn run above, checked
against criteria 1-4, with the sandbox inspected on disk between turns.

## Regression (session-memory dreaming — step 0 and promotion records)

Pass criteria:
1. The run invokes `devcycle:dreaming-across-sessions` before any promotion batching.
2. A promotion record appears under `docs/devcycle/promotions/` with all five fields, and
   the commit sha in it matches the commit that landed the edit.
3. With `dream.mjs` made to exit non-zero, the run reports the failure and still completes
   with raw 1:1 batching — it does not abort.
4. A memory whose promotion was declined is still deleted only on promotion, never on skip
   — the pre-existing behavior is unchanged.

Result: to be recorded when this scenario is run against the committed text.
