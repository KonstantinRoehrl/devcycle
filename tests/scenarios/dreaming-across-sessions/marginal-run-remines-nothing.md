# Scenario: marginal-run-remines-nothing
- Skill under test: devcycle:dreaming-across-sessions (via `/devcycle:dream`), invoked
  twice in the same session
- Type: discipline

A first dream that resumes after an earlier interrupted pass mines only what that pass
left undone — not the slices already on disk. A second dream, immediately after, over the
*same, unchanged* corpus, reuses the artifact rather than re-mining anything. Both turns
together are what makes "the observation store's dedup, not some other mechanism, is what
keeps a marginal run cheap" an assertion this scenario can actually fail.

**Why this shape, not two from-scratch dreams.** Once a first dream commits its
checkpoint, that checkpoint is `now` at commit time — always later than any static,
historical fixture timestamp a scenario can author. A literal *second*, fully separate
`/devcycle:dream` call over the same fixed-past corpus therefore always finds every
fixture session outside the checkpoint window (`inWindow`, `scripts/dream.mjs:419`,
`scripts/doctor.mjs:609-616`) — `unmined` comes back empty because there is nothing left
in scope to mine at all, not because the observation store deduped anything. That shape
cannot discriminate a broken observation store from a correct one, which is the earlier
draft's blocking defect. To make the "nothing gets re-mined" question actually
discriminating, turn 1 here is written as **resuming a first dream that got partway
through Map before this session began** — the observation store already carries some, but
not all, of the slices a complete first pass would produce, and `since` is still `null`
(the checkpoint was never reached). That is a real, ordinary state a first dream can be in
(a prior process died mid-Map), and it is the one shape where `unmined` differing between
two `--plan` reads is genuinely caused by `hasObservations`, not by the window.

## Setup

Same isolation as `dual-invocation-checkpoint.md`: a sandboxed `$HOME` for the whole
subagent process (credentials under its `.claude`, also the run's isolated config
directory), and a transcript corpus under a directory of the scenario's own making,
`<sandbox>/dream-corpus/`, exported as `CLAUDE_DREAM_PROJECTS` — never the directory the
harness writes its own session transcript into
(`$HOME/.claude/projects/<escaped repo root>/`). Keeping the two apart means the running
session's own growing transcript is never itself part of the corpus either `--plan` call
scans, so it structurally cannot be what makes either call see anything as stale.

**Profile, pinned explicitly, to `thorough`.** Write `.devcycle/state.md`:
```markdown
# devcycle pipeline state
- stage: none
- configured: 2026-07-01 profile=thorough
```
and splice the full body of `references/config.md` into both turns' prompts (below).
`thorough` is required, not incidental: `unmined` (`--plan`'s own field) is defined as
`kept.filter((s) => !hasObservations(repoRoot, s.id))` (`scripts/dream.mjs:440`), keyed on
the **bare** session id — the raw-transcript slice's id (`skills/dreaming-across-sessions/SKILL.md`'s
slice table), admitted only at `thorough`. At `standard`, that slice is never mined, so no
`<session-id>.json` file is ever written and `unmined` would carry both session ids
forever regardless of dedup — the same false-attribution failure mode this scenario now
exists to avoid.

Inside `<sandbox>/dream-corpus/<escaped repo root>/`, two real session transcripts with
genuine narrative content — a real recurring friction for Map to extract:

- `c3d4e5f6.jsonl`, `2026-07-14T10:15:00Z` — a user turn: "you opened the PR without
  running `node scripts/validate.mjs` locally first — CI caught it, but that's the second
  time this week." An assistant turn acknowledging and fixing it.
- `d4e5f6a7.jsonl`, `2026-07-21T13:40:00Z` — same friction recurring: a user turn, "same
  thing again — you skipped the local validator run before opening the PR."

A fake memory directory with one unrelated entry and its `MEMORY.md` index, under
`$HOME/.claude/projects/<escaped repo root>/memory/`.

**Simulating the earlier, interrupted pass** (this is what turn 1 resumes — pre-seed
these before turn 1 runs, representing a prior process that mined `c3d4e5f6` and the
memory slice, then died before reaching `d4e5f6a7` or the checkpoint-commit step):

- `.devcycle/dreaming/observations/memory.json` — `[]`.
- `.devcycle/dreaming/observations/c3d4e5f6-corrections.json`:
  ```json
  [
    {
      "session": "c3d4e5f6",
      "ts": "2026-07-14T10:15:00Z",
      "kind": "correction",
      "subject": "PRs opened without running scripts/validate.mjs locally first",
      "target": "CONTRIBUTING.md",
      "quote": "you opened the PR without running node scripts/validate.mjs locally first — CI caught it, but that's the second time this week",
      "confidence": "high"
    }
  ]
  ```
- `.devcycle/dreaming/observations/c3d4e5f6.json` (the bare-id, raw-transcript slice):
  ```json
  [
    {
      "session": "c3d4e5f6",
      "ts": "2026-07-14T10:15:00Z",
      "kind": "friction",
      "subject": "PRs opened without running scripts/validate.mjs locally first",
      "target": null,
      "quote": "CI caught it, but that's the second time this week",
      "confidence": "high"
    }
  ]
  ```
- **No** file for `d4e5f6a7-corrections` or `d4e5f6a7` — that session's slices are
  genuinely unmined.
- **No** `.devcycle/dreaming/state.md` and **no** dream artifact — the interrupted pass
  never reached "Write and checkpoint," so `since` is still `null` for turn 1: both
  sessions are equally in window, and only the observation store (not the window)
  distinguishes "already covered" from "still to do."

**Confirm on disk before running:** `node scripts/dream.mjs --plan` (same env) reports
`observations` containing exactly `memory`, `c3d4e5f6-corrections`, `c3d4e5f6` — and
`unmined` containing **only** `["d4e5f6a7"]`, not `c3d4e5f6`. That asymmetry, with `since`
still `null` for both sessions, is the on-disk fact this scenario turns on.

**Sandbox mutation.** Turn 1 writes new files under `.devcycle/dreaming/observations/`,
writes `.devcycle/dreaming/state.md` for the first time, and writes a dated artifact.
Snapshot the clean sandbox state (as pre-seeded above) after Setup and before the red run;
restore it before the green run.

## Subagent prompt

Two real turns, same session. Turn 1:

> You are a coding agent in this repository, in a brand-new session. The user invoked
> `/devcycle:dream`. Follow the spliced COMMAND and SKILL text exactly.
>
> === COMMAND ===
> [Splice: full body of commands/dream.md]
> === END COMMAND ===
> === SKILL ===
> [Splice: full body of skills/dreaming-across-sessions/SKILL.md]
> === END SKILL ===
> === REFERENCE (referenced by the skill as references/config.md) ===
> [Splice: full body of references/config.md]
> === END REFERENCE ===

Turn 2, resuming the same session, corpus on disk untouched since turn 1:

> The user invokes `/devcycle:dream` again. Nothing in the repo or the corpus has changed
> since your last run. Follow the spliced COMMAND and SKILL text exactly.
>
> === COMMAND ===
> [Splice: full body of commands/dream.md]
> === END COMMAND ===
> === SKILL ===
> [Splice: full body of skills/dreaming-across-sessions/SKILL.md]
> === END SKILL ===
> === REFERENCE (referenced by the skill as references/config.md) ===
> [Splice: full body of references/config.md]
> === END REFERENCE ===

## Pass criteria

1. **The Setup's on-disk fact holds, and is the discriminating signal.** Before turn 1
   runs, `--plan` reports `unmined: ["d4e5f6a7"]` — never `["c3d4e5f6","d4e5f6a7"]`. An
   engine whose observation-store dedup was removed would report both ids here even
   though nothing has been checkpointed yet; this is the property criterion 2 exercises.
2. **Turn 1 mines only what was missing.** Its Map dispatches cover exactly
   `d4e5f6a7-corrections` and `d4e5f6a7` (the raw slice) — never `memory` or
   `c3d4e5f6-corrections` or `c3d4e5f6` again. Confirm on disk afterward:
   `.devcycle/dreaming/observations/memory.json`,
   `.devcycle/dreaming/observations/c3d4e5f6-corrections.json`, and
   `.devcycle/dreaming/observations/c3d4e5f6.json` are byte-identical, with unchanged
   mtimes, to what Setup pre-seeded.
3. **Turn 1 completes for real.** `.devcycle/dreaming/<date>-dream.md` exists afterward,
   and `.devcycle/dreaming/state.md`'s `last-dreamed-through:` is a real timestamp, not
   `never`.
4. **Turn 2 takes the reuse path.** `--plan` reports `artifactFresh: true` (the checkpoint
   turn 1 just committed is `now`, later than both fixture sessions' historical
   timestamps, so nothing outranks it either by freshness or by window); turn 2's own
   report states it read the existing artifact rather than dispatching anything. Zero map
   agents are dispatched either way — matching the brief's "artifactFresh fast path, or
   mines nothing" as the same outcome here, since there is nothing left in window to mine
   regardless of which branch is taken.
5. **The checkpoint does not move again.** `.devcycle/dreaming/state.md`'s
   `last-dreamed-through:` is identical at the end of turn 2 to what it was at the end of
   turn 1.

**Not asserted here, by design.** "The running session's own transcript never makes the
artifact stale" (brief Step 3) is not exercised end to end: this scenario's harness splices
skill text into a prompt rather than installing devcycle as a real plugin, so no transcript
this harness produces ever carries a genuine `Skill` tool-use record or `attributionSkill`
tag (`scripts/dream.mjs:268-283`, `isSelfRecord`) — there is no way to make a session
*genuinely* self-flagged inside this harness without fabricating that record directly, and
even then the corpus root here is scoped away from the harness's own transcript directory
by construction (per the fixture-placement rule above), so the running session's transcript
is never scanned by either `--plan` call regardless. The general self-exclusion guarantee —
a session that *is* in the corpus and *is* flagged `self` never counts toward staleness — is
asserted directly against `planCorpus`/`artifactFresh` by `tests/unit/dream.test.mjs`
(`:365-386`, `:411-422`), the same deferral `dual-invocation-checkpoint.md`'s own last
paragraph makes for the mirror-image direction of the same rule.

## Baseline (red)

Not yet run — requires a credentialed isolated session per `CONTRIBUTING.md`'s protocol.
Expected red: before the observation store existed (Task 2) there was no per-slice mined
marker at all — every dream re-walked the full raw-transcript corpus regardless of what a
prior run had already covered, so "resume mines only what's left" had no mechanism to
express, let alone assert.

## Result (green)

Not yet run — same blocker. What would prove it: the two-turn run above, checked against
criteria 1-5, with the observation store and `.devcycle/dreaming/state.md` inspected on
disk between turns.
