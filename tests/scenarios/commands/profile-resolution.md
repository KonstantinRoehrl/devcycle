# Scenario: profile-resolution
- Skill under test: `references/config.md` (knob and profile resolution), consumed by
  `devcycle:reviewing-the-branch`; plus `commands/cycle.md`'s first-run walkthrough
- Type: output-shape + discipline

Does an unset knob take its value from the profile's column, does an explicitly
configured knob still beat the profile, and does the first-run walkthrough write
**only** `profile=<value>` rather than freezing the individual knobs?

## Setup

Three runs, each its own freshly built sandbox.

**Runs A and B** reuse the `reviewproj` sandbox from
`tests/scenarios/reviewing-the-branch/engine-selection.md` (spec at `docs/spec.md`,
branch `feature/slugify` whose implementation misses spec R3, and the real mini
`plugin/workflows/review-panel.js` stand-in). That stage is the observation point
because its report states two profile-sized values at once: the review engine
(`reviewDepth`) and the round cap. Add a `.devcycle/state.md` in the Step-0 template
shape at `stage: branch-review`, whose `configured:` line differs per run:

- **Run A** — `configured: 2026-07-26 profile=thorough`. Every knob placeholder is
  literal, so `reviewDepth` is unset and must come from the profile's column.
- **Run B** — `configured: 2026-07-26 profile=thorough, reviewDepth=single`. Same
  profile, one knob explicitly configured.

**Run C** uses the minimal Node sandbox from `first-run-config.md` (`package.json`
with `"test": "node --test"`, `src/greet.js`, a passing `test/greet.test.js`, one
commit on `main`) with **no** `.devcycle/` directory, so both offer conditions for
the first-run walkthrough hold.

Splices. Runs A and B: the full bodies of `references/config.md` and
`skills/reviewing-the-branch/SKILL.md`, with every `${CLAUDE_PLUGIN_ROOT}` occurrence
replaced by the sandbox's `plugin` directory path (the platform's substitution,
simulated), and `references/config.md` also written into `plugin/references/config.md`
so the skill's own pointer resolves. Run C: the full bodies of `commands/cycle.md`
and `references/config.md`. For the **baseline (red)** runs, splice the same files
from the pre-change commit (`git show ba79dab:<path>`) — `references/config.md` does
not exist there, so the red prompt carries only the pre-change skill or command body.

## Subagent prompt

**Runs A and B** (working directory: the `reviewproj` sandbox, `feature/slugify`
checked out):

```
[SKILL CONTENT: full text of references/config.md, then
skills/reviewing-the-branch/SKILL.md, ${CLAUDE_PLUGIN_ROOT} replaced by the
sandbox's plugin directory]

You are at the branch-review stage of a devcycle pipeline in this repo. The
implementation branch feature/slugify is complete and committed (base: main).
The spec is docs/spec.md. Configuration: every ${user_config...} placeholder in
the text above still renders literally; the recorded configuration for this run
is the `configured:` line of .devcycle/state.md. Resolve the configuration
yourself, state what each value resolved to and why, run the branch review now,
and include the full review report in your final message.
```

**Run C** (working directory: the minimal Node sandbox):

> You are a coding agent in this repository, in a brand-new session. Simulate a two-turn exchange in a single response: first produce Turn 1 (your response to the invocation below), then read the scripted user reply and produce Turn 2. Label the turns `TURN 1` and `TURN 2`.
>
> === COMMAND (the user invoked `/devcycle:cycle add a slugify helper with tests`; follow this exactly) ===
> [Splice here: full body of commands/cycle.md.]
> === END COMMAND ===
>
> === REFERENCE (referenced by the command as references/config.md) ===
> [Splice here: full body of references/config.md.]
> === END REFERENCE ===
>
> Environment notes: AskUserQuestion is not available in this session — where guidance says to use it, send the batch as one plain message with the same shape, then stop for the answer. The `claude` CLI is not installed in this sandbox — where the text says to run a `claude` command, write the exact command(s) you would run, verbatim, instead of executing them. You may read and write files.
>
> Scripted user reply (read only AFTER writing Turn 1, and treat it as answering whatever you asked): "standard"

**Run C-customize variant:** identical but three turns (`TURN 1`, `TURN 2`,
`TURN 3`). The first scripted reply is `"customize individual knobs"`; a second,
read only after Turn 2 is written, answers that batch — "gitPolicy: recommended.
reviewDepth: recommended. crossModelReview: yes, turn it on. onDeviceGate:
recommended." — one knob moved off its default, three accepted at it. Without that
extra turn the run never reaches a write, and criterion 9 has nothing to grade.

## Pass criteria

1. **Run A — an unset knob takes the profile's column value.** With `reviewDepth`
   a literal placeholder and `profile=thorough` recorded, the engine resolves to
   `panel`: the transcript shows the `node <plugin dir>/workflows/review-panel.js
   '<json>'` invocation, and the report's engine line reads `panel` (or
   `panel→single (panel unavailable: <reason>)` if the stand-in genuinely fails —
   an unnamed or implied engine fails this criterion).
2. **Run A — the cap comes from the same column.** The report's `Rounds: <n> of
   <cap>` line carries cap `5` (`thorough`), not `3` and not an invented number.
3. **Run A — no invented values.** Knobs the profile table does not cover keep
   their documented defaults: the panel argv shows `"crossModel":false`
   (`crossModelReview` unset → `false`).
4. **Run B — an explicit knob beats the profile.** With `reviewDepth=single`
   recorded under the same `profile=thorough`, the engine is `single`: the string
   `review-panel.js` appears nowhere in the transcript as an executed command, and
   the report's engine line reads `single` (or `single + user-run code-review` if
   the user had run that pass). `single` is a complete engine, so an engine line
   calling it degraded fails — `panel→single (panel unavailable: <reason>)` is the
   only sanctioned degradation, and no panel was attempted here.
5. **Run B — one explicit knob does not drag the rest.** The still-unset cap
   continues to come from the profile: `Rounds: <n> of 5`. A response that reads
   the explicit knob as "so the profile is `standard`" prints `of 3` and fails.
6. **Run C — the walkthrough is one question over `profile`.** Turn 1 creates
   `.devcycle/state.md` first, then offers exactly one batch whose subject is
   `profile`, listing `lean` / `standard` (marked recommended) / `thorough` plus a
   "customize individual knobs" escape — and then stops. A batch that asks the four
   behavioral knobs by default fails.
7. **Run C — only the profile is written.** Turn 2 states exactly
   `claude plugin install devcycle@devcycle --config profile=standard`, and the
   strings `--config gitPolicy=`, `--config reviewDepth=`, `--config
   crossModelReview=`, and `--config onDeviceGate=` appear nowhere in the turn.
8. **Run C — the state file records the same.** `.devcycle/state.md` on disk has a
   `configured:` line carrying the date plus `profile=standard` and no other
   KEY=VALUE pair.
9. **Run C-customize — the four-knob path writes only what changed.** Answering
   "customize individual knobs" asks the four behavioral knobs in one batch (models
   excluded), then writes a `--config` only for the knob whose answer differs from
   the offered default: the command stated is exactly `claude plugin install
   devcycle@devcycle --config crossModelReview=true`, and `--config gitPolicy=`,
   `--config reviewDepth=` and `--config onDeviceGate=` appear nowhere in the turn.
   A knob accepted at its recommended value stays unwritten — writing it would make
   it explicitly configured, which by rule 1 of the resolution order this scenario
   exists to test outranks the profile verbatim and forever, exactly as criterion 7
   forbids for the profile answer. (The all-defaults case — every answer matching,
   so nothing is written and `configured:` reads `defaults` — is graded by
   `first-run-config.md`'s run E.)

## Baseline (red)

**Not yet run (2026-07-26).** No protocol-compliant model run was produced. The
harness requires a fresh `CLAUDE_CONFIG_DIR` holding only credentials; on the
machine this scenario was written, the CLI launched with an isolated config
directory answers `Not logged in · Please run /login`, and a run in the machine's
real config directory would load the installed devcycle plugin organically — the
contamination `engine-selection.md`'s baseline-hygiene note excludes.

Established without a model run — a text check over the pre-change files, not a
behavioral result:

- `references/config.md` does not exist at `ba79dab`, so no profile table, no
  resolution order, and no round-cap row existed to resolve against.
- `git show ba79dab:commands/cycle.md | grep -ci profile` returns `0`: the word
  does not occur in the pre-change command at all.
- The pre-change first-run walkthrough asks the four behavioral knobs and applies
  the answers as "one `--config` per knob … including on 'use defaults': write the
  explicit default values" — the exact write pattern criteria 7 and 9 now forbid, on
  the profile answer and on the customize path alike.
- `git show ba79dab:skills/reviewing-the-branch/SKILL.md | grep -ci cap` returns
  `0`: no round cap exists to source from a profile.

What would prove it: run A, B, and C against those pre-change bodies under the
isolated-config protocol. Expected red — criteria 1, 2 and 5 unexercisable (no
profile, no cap), criterion 7 failing because the walkthrough writes four
`--config` pairs.

## Result (green)

**Not yet run (2026-07-26).** Blocked by the same missing credentialed isolated
config. What would prove it: the three runs above against the working-tree bodies,
graded criterion by criterion, with `.devcycle/state.md` and the drafted commands
inspected on disk rather than taken from the transcript.

**Amended 2026-07-27, still not run.** Criterion 9 was re-expressed to grade the
customize path's actual write rule — only knobs whose answer differs from the offered
default — and the C-customize variant gained the third turn that rule needs to be
observable. Nothing here is claimed as observed.
