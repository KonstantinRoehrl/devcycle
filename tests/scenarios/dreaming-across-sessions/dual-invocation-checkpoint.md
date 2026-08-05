# Scenario: dual-invocation-checkpoint
- Skill under test: devcycle:dreaming-across-sessions (via `/devcycle:dream`), then
  devcycle:distilling-learnings (via `/devcycle:distill`)
- Type: discipline

Does a standalone dream followed immediately by a distill mine the corpus exactly once —
the second run reusing the first run's artifact rather than re-mining, with no candidate
lost between the preview and the distill batch?

## Setup

A sandboxed `$HOME` for the whole subagent process, credentials placed under its
`.claude` (which is also the run's isolated config directory), matching the sibling
`doctor` scenario's protocol — `dream.mjs` still resolves the memory store the same
`os.homedir()`-dependent way `doctor.mjs` does, so the fresh `$HOME` is still what
isolates that half. The transcript corpus, though, comes from a directory of the
scenario's own making — say `<sandbox>/dream-corpus/` — exported to the same process as
`CLAUDE_DREAM_PROJECTS`. That variable overrides the transcript root (mirroring
`doctor.mjs`'s `CLAUDE_DOCTOR_PROJECTS`), so exporting it is the whole mechanism: the
spliced skill text is unchanged and every `dream.mjs` call it makes inherits the root.

**A scenario fixture must not live in the directory the harness writes its own session
transcript into** — which is why the corpus moved out of `$HOME/.claude/projects/`. The
headless run writes its own transcript into its config directory's
`projects/<escaped repo root>/` as it goes, i.e. `$HOME/.claude/projects/<escaped repo
root>/` here. A fixture placed there is graded together with the harness's own growing
transcript, and criteria 2 and 4 below cannot go green even against a correct
implementation. Keep the two apart; do not move the fixture back.

Inside the scenario-owned root, the two synthetic session transcripts go under
`<escaped repo root>/`, where `<escaped repo root>` is whatever `dream.mjs`'s current
escaping rule derives from the sandbox repo checkout's absolute path — every
non-alphanumeric character becomes its own `-`, the same rule `memoryDir` below is keyed
by; do not hardcode a slug, since the rule replaces more than `/` and changes
independently of this scenario. Placing the fixture anywhere else fails silently: the
repo-scoped lookup finds zero sessions rather than erroring, so confirm on disk before
running that `node scripts/dream.mjs --plan`, run from the sandbox repo root with the
same environment, reports at least the two fixture sessions under `sessions`. Both
transcripts mention the same recurring friction ("forgot to pin the dispatch's model
tier, caught in review, twice") so mining has one real pattern to cluster into a
candidate. A fake memory directory with one unrelated entry and its `MEMORY.md` index,
still under the sandbox `$HOME` at `.claude/projects/<escaped repo root>/memory/` — the
same escaped repo root as above, since the manifest reports `memoryDir` from `$HOME`
whatever the transcript root is. No `.devcycle/dreaming/state.md` or
`.devcycle/distilling-state.md` exists yet (first run of both), and no
`docs/devcycle/promotions/` records exist yet either, so turn 1's recurrence-check step is
expected to run and return an empty result — nothing to check on a repo with no landed
promotions, not a failure.

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
   artifact rather than re-dispatching mining subagents over the same corpus. The corpus
   it checks is the scenario-owned fixture root, whose newest session predates turn 1's
   artifact, so a re-mine here means the freshness check called a corpus with nothing
   newer stale — the direction this criterion catches.
3. **No candidate is lost.** Every candidate listed in turn 1's dream artifact appears
   in turn 2's confirmation batch.
4. **The checkpoint advances exactly once.** `.devcycle/dreaming/state.md`'s
   `last-dreamed-through:` is identical at the end of turn 2 to what it was at the end
   of turn 1 — turn 2's reuse path does not re-advance it. Paired with criterion 1,
   which requires turn 1 to move it off `never`, this pins the checkpoint in both
   directions: it must move exactly once, and must not move again.

The other direction of the self-exclusion rule — a *non-self* session newer than the
artifact does make it stale, so the next run re-mines — is not gradeable from a single
two-turn run, since a corpus cannot be both stale and fresh for turn 2.
`tests/unit/dream.test.mjs` asserts both directions of it directly against `planCorpus`
and `artifactFresh`; this scenario asserts the reuse side end to end.

## Baseline (red)

Not yet run — requires a credentialed isolated session per `CONTRIBUTING.md`'s
protocol. Expected red: skill/command absent pre-task (confirm via
`git show <pre-task-commit>:commands/dream.md` failing), so no dreaming behavior exists
to exhibit at all.

## Result (green)

Not yet run — same blocker. What would prove it: the two-turn run above, checked
against criteria 1-4, with `.devcycle/dreaming/state.md` and the dream artifact
inspected on disk between turns.
