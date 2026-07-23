# Scenario: first-run-config
- Skill under test: commands/cycle.md (`/devcycle:cycle`) — first-run configuration walkthrough
- Type: output-shape + discipline

Does `/devcycle:cycle` offer the one-time configuration walkthrough exactly when
both conditions hold (all four behavioral knobs render as literal
`${user_config...}` placeholders AND the state file's `configured:` line reads
`no`), apply "use defaults, don't ask again" by writing explicit default values
(self-extinguishing), and skip the offer entirely when `configured:` already
records values?

## Setup

Create a minimal Node sandbox repo: `package.json` with `"test": "node --test"`,
`src/greet.js` exporting `greet(name)`, a passing `test/greet.test.js`, one
commit on `main`. No `.devcycle/` directory (main run) — the no-offer variant
below adds a pre-existing state file.

The command text is spliced raw, so every `${user_config.KEY}` placeholder
appears literally — the unset state. Run the subagent from the sandbox root
with file write access.

For the **green** runs, splice the full bodies of `commands/cycle.md` and
`skills/scoping-interview/SKILL.md` (the stage the command enters after
config + triage) into the prompt. For the **baseline (red)** run, splice the
same files from the previous committed text.

## Subagent prompt

> You are a coding agent in this repository, in a brand-new session. Simulate a two-turn exchange in a single response: first produce Turn 1 (your response to the invocation below), then read the scripted user reply and produce Turn 2. Label the turns `TURN 1` and `TURN 2`.
>
> === COMMAND (the user invoked `/devcycle:cycle add a slugify helper with tests`; follow this exactly) ===
> [Splice here: full body of commands/cycle.md.]
> === END COMMAND ===
>
> === STAGE SKILL (devcycle:scoping-interview, if you reach that stage) ===
> [Splice here: full body of skills/scoping-interview/SKILL.md.]
> === END STAGE SKILL ===
>
> Environment notes: AskUserQuestion is not available in this session — where guidance says to use it, send the batch as one plain message with the same shape. The `claude` CLI is not installed in this sandbox — where the command text says to run a `claude` command, write the exact command(s) you would run, verbatim, instead of executing them. You may read and write files.
>
> Scripted user reply (read only AFTER writing Turn 1, and treat it as answering whatever you asked): "Use defaults, don't ask again."

**No-offer variant (run C):** same sandbox plus a pre-existing
`.devcycle/state.md` in the Step-0 template shape with `stage: done` and a
`configured:` line recording a date plus all four KEY=VALUE pairs. Single
turn, no scripted reply: produce your first response to the same invocation.

## Pass criteria

1. Turn 1 creates `.devcycle/state.md` first (Step 0, `configured: no`), then —
   because all four knobs render literal AND `configured:` is `no` — offers the
   walkthrough BEFORE any triage verdict or scoping question: one batch covering
   exactly `gitPolicy`, `reviewDepth`, `crossModelReview`, `onDeviceGate`, each
   with a one-line meaning and its recommended default marked, plus a
   first-class "use defaults, don't ask again" option; then a hard stop for the
   answer.
2. Model knobs are excluded from the batch; if models are mentioned at all, only
   as chosen automatically per task unless pinned in `/plugin configure`.
3. "Use defaults" is self-extinguishing, not a skip: Turn 2 states the exact
   `claude plugin install devcycle@devcycle --config KEY=VALUE` command(s)
   writing the explicit default values for all four knobs
   (`gitPolicy=local-commits-only`, `reviewDepth=single`,
   `crossModelReview=false`, `onDeviceGate=human-required`), and updates the
   state file's `configured:` line (`defaults`, or the date plus the KEY=VALUE
   list) — so the offer never fires again and this run's stage skills read the
   recorded values.
4. *(No-offer variant, run C.)* With the state file's `configured:` line
   recording values, the walkthrough is NOT offered: the agent resets the
   `stage: done` file carrying `configured:` forward unchanged, announces the
   triage verdict, and proceeds straight to the entry stage.

## Baseline (red)

Run 2026-07-23 — fresh headless subagent (`claude -p`, model `claude-sonnet-5`),
isolated config (fresh CLAUDE_CONFIG_DIR holding only auth; init event confirmed
`plugins: []`), sandbox per Setup, prompt spliced from the previous committed
text (`git show HEAD:commands/cycle.md`, `git show
HEAD:skills/scoping-interview/SKILL.md`), which contains no first-run
configuration section.

- Criterion 1 FAIL: no walkthrough was offered — Turn 1 created the state file
  (the old 7-line template: no `scope:`, no `configured:` line), noted only the
  gitPolicy placeholder ("unset — I'll use the default `local-commits-only`"),
  announced triage, and went straight into a 4-question scoping batch.
- Criterion 2 not exercisable (no config batch to exclude models from).
- Criterion 3 FAIL: the scripted "Use defaults, don't ask again" reply was
  consumed as a *scoping* answer ("Applying the defaults: (2a) strip
  diacritics… I'll carry that forward as a standing preference"); no
  `claude plugin install … --config` command appears anywhere in the
  transcript and the old template has no `configured:` line to record to.
- Criterion 4 trivially holds under the old text (nothing to offer) — recorded
  as not-a-delta, not as a pass.
- Net: RED — fails criteria 1 and 3.

## Result (green)

Runs 2026-07-23 — same protocol, working-tree `commands/cycle.md` +
`skills/scoping-interview/SKILL.md` spliced in.

- Run B (main, two turns), criterion 1 PASS: Turn 1 wrote `.devcycle/state.md`
  first ("no prior cycle in this repo"), then — "this repo has never been
  configured for devcycle — all four config knobs are still unset" — offered
  the walkthrough BEFORE the triage verdict: one plain-message batch
  (AskUserQuestion unavailable, same-shape fallback) titled "One-time devcycle
  configuration (won't ask again after this)", covering exactly the four
  knobs, each with a one-line meaning and "(recommended)" marking the default,
  closing with the first-class escape "or just say **'use defaults, don't ask
  again'** to accept all four recommended values" — then stopped.
- Criterion 2 PASS: the batch contains no model questions and no model knob is
  mentioned anywhere in the offer.
- Criterion 3 PASS: Turn 2 wrote the exact command verbatim (one invocation,
  one `--config` per knob, explicitly not executed since the CLI is absent):
  `claude plugin install devcycle@devcycle --config
  gitPolicy=local-commits-only --config reviewDepth=single --config
  crossModelReview=false --config onDeviceGate=human-required`; updated the
  state file to `configured: 2026-07-23 gitPolicy=local-commits-only,
  reviewDepth=single, crossModelReview=false, onDeviceGate=human-required`
  (date + KEY=VALUE list form, verified on disk); stated "I've recorded the
  choice in state so this session honors it immediately (same-session
  substitution can't refresh from the install command)"; then announced the
  triage verdict (rough one-liner → scoping) and ran the scoping batch to its
  hard stop.
- Run C (no-offer variant), criterion 4 PASS: with `configured:` recording the
  four KEY=VALUE pairs, no walkthrough was offered — the agent found the
  `stage: done` file, "carried its `configured:` line forward and reset the
  rest" (verified on disk: fresh 10-line state at `stage: scoping` with the
  2026-07-20 `configured:` line byte-identical), announced the triage verdict,
  and entered scoping directly.
- Net: GREEN — all four criteria met.
