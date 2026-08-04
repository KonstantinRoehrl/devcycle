# Scenario: dual-invocation-checkpoint
- Skill under test: devcycle:dreaming-across-sessions (via `/devcycle:dream`), then
  devcycle:distilling-learnings (via `/devcycle:distill`)
- Type: dual-invocation

Does a standalone dream followed immediately by a distill mine the corpus exactly once —
the second run reusing the first run's artifact rather than re-mining, with no candidate
lost between the preview and the distill batch?

## Setup

A sandboxed `$HOME` (`dream.mjs` resolves `~/.claude/projects` the same
`os.homedir()`-dependent way `doctor.mjs` does, so the isolation is a fresh `$HOME` for
the whole subagent process, credentials placed under its `.claude`, matching the sibling
`doctor` scenario's protocol) containing two synthetic session transcripts under
`$HOME/.claude/projects/-fixture-project/`, both mentioning the same recurring friction
("forgot to pin the dispatch's model tier, caught in review, twice") so mining has one
real pattern to cluster into a candidate. A fake memory directory (path substituted for
`~/.claude/projects/<escaped-cwd>/memory/`) with one unrelated entry and its
`MEMORY.md` index. No `.devcycle/dreaming/state.md` or `.devcycle/distilling-state.md`
exists yet (first run of both).

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

Turn 2, resuming the same session:

> The user now invokes `/devcycle:distill`. Follow the spliced COMMAND and SKILL text
> exactly, then STOP and wait for the user as usual.
>
> === COMMAND ===
> [Splice: full body of commands/distill.md]
> === END COMMAND ===
> === SKILL ===
> [Splice: full body of skills/distilling-learnings/SKILL.md]
> === END SKILL ===
>
> AskUserQuestion is unavailable — send any batch as a plain message with the same
> shape, then stop for the answer.

## Pass criteria

1. **Turn 1 writes the artifact and advances the checkpoint.**
   `.devcycle/dreaming/<today>-dream.md` exists, and
   `.devcycle/dreaming/state.md`'s `last-dreamed-through:` is a real timestamp (not
   `never`). Turn 1 reports and stops, promoting nothing.
2. **Turn 2 reuses turn 1's artifact.** Its report states it read the existing dream
   artifact rather than re-dispatching mining subagents over the same corpus.
3. **No candidate is lost.** Every candidate listed in turn 1's dream artifact appears
   in turn 2's confirmation batch.
4. **The checkpoint advances exactly once.** `.devcycle/dreaming/state.md`'s
   `last-dreamed-through:` is identical at the end of turn 2 to what it was at the end
   of turn 1 — turn 2's reuse path does not re-advance it.

## Baseline (red)

Not yet run — requires a credentialed isolated session per `CONTRIBUTING.md`'s
protocol. Expected red: skill/command absent pre-task (confirm via
`git show <pre-task-commit>:commands/dream.md` failing), so no dreaming behavior exists
to exhibit at all.

## Result (green)

Not yet run — same blocker. What would prove it: the two-turn run above, checked
against criteria 1-4, with `.devcycle/dreaming/state.md` and the dream artifact
inspected on disk between turns.
