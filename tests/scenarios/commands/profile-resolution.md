# Scenario: profile-resolution
- Skill under test: `references/config.md` (knob and profile resolution), consumed by
  `devcycle:reviewing-the-branch`; plus `commands/cycle.md`'s first-run walkthrough
- Type: output-shape + discipline

Does an unset knob take its value from the profile's column, does an explicitly
configured knob still beat the profile, does the first-run walkthrough write
**only** `profile=<value>` rather than freezing the individual knobs, and does an
upgrader whose pre-existing knobs shadow the profile get told so and offered a way out?

## Setup

Four runs, each its own freshly built sandbox.

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

**Run D** is the upgrader: the same minimal Node sandbox, plus a `.devcycle/state.md`
in the Step-0 template shape at `stage: done` whose `configured:` line is what the
pre-0.8.0 walkthrough wrote — `configured: 2026-07-20 gitPolicy=local-commits-only,
reviewDepth=single, crossModelReview=false, onDeviceGate=human-required`, with no
`· profile-asked` marker. Run D's splice carries the substitution that makes it an
upgrader: in the spliced command body, `${user_config.gitPolicy}`,
`${user_config.reviewDepth}`, `${user_config.crossModelReview}` and
`${user_config.onDeviceGate}` are replaced by `local-commits-only`, `single`, `false`
and `human-required` respectively, while `${user_config.profile}` is left literal —
the platform's real behavior for four options set before `profile` existed (see
`docs/platform-notes.md` §(a): an unset option stays a literal placeholder even when
the manifest declares a `default`).

**Run C-second-cycle variant:** the state the C-customize variant leaves behind, one
cycle later. Same minimal Node sandbox, plus a `.devcycle/state.md` at `stage: done`
whose `configured:` line reads `configured: 2026-07-27 reviewDepth=panel ·
profile-asked` — a first-run customize pass on THIS release that moved one
profile-covered knob. Its splice substitutes `${user_config.reviewDepth}` to `panel`
and leaves the other four literal, `${user_config.profile}` included, because
customize writes no profile. That is the upgrade signature rendered by a user who is
not an upgrader, which is the whole point of the run. For the **baseline (red)** the
same sandbox drops the `· profile-asked` marker from the `configured:` line, since the
pre-change customize path did not write one.

**Run D-gitpolicy variant:** identical to Run D except that only
`${user_config.gitPolicy}` is substituted (the other three stay literal) and the
`configured:` line reads `configured: 2026-07-20 gitPolicy=push-allowed`. The
shadowing set is empty here — `gitPolicy` is outside the profile matrix — so this
variant grades the fall-through branch, not the migration.

Splices. Runs A and B: the full bodies of `references/config.md` and
`skills/reviewing-the-branch/SKILL.md`, with every `${CLAUDE_PLUGIN_ROOT}` occurrence
replaced by the sandbox's `plugin` directory path (the platform's substitution,
simulated), and `references/config.md` also written into `plugin/references/config.md`
so the skill's own pointer resolves. Runs C and D and their variants: the full bodies
of `commands/cycle.md` and `references/config.md`, each with that run's own
substitutions applied to the command body. For the **baseline (red)** runs, splice the same files
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

**Run D** uses Run C's prompt verbatim — same two-turn shape, same environment notes,
same invocation — with the Run D splice and this scripted reply: `"adopt a profile and
let it govern — thorough"`. The **D-gitpolicy variant** uses the same prompt with its
own splice and the reply `"standard"`.

**Run C-second-cycle** uses Run C's prompt with its own splice and no scripted reply at
all: Turn 1 is the whole run, and it is graded on what it does *not* ask. Keep the
two-turn instruction out of this one so that stopping for an answer is not the expected
shape — a run told to expect a reply may invent a question to justify it.

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
10. **Run D — the upgrade signature is detected, and the question comes before any
    stage.** Turn 1 names the situation in its own words — `profile` never set while
    `reviewDepth` and `onDeviceGate` carry explicit values, which will override any
    profile picked — and asks about exactly that, then stops. It must stop *there*: the
    turn contains no triage verdict, no entry-stage confirmation, and no stage skill
    invocation, so a turn that asks the upgrade question and the triage question
    together fails, as does one that runs scoping first and raises configuration after.
11. **Run D — adopting writes `auto` for the shadowing knobs only.** Turn 2 states
    exactly `claude plugin install devcycle@devcycle --config profile=thorough
    --config reviewDepth=auto --config onDeviceGate=auto` (the two `--config
    <knob>=auto` pairs in either order), and the strings `--config gitPolicy=` and
    `--config crossModelReview=` appear nowhere in the turn — those two are outside the
    profile matrix, so rewriting them would discard a user choice that shadows nothing.
    Writing `reviewDepth=single`, `onDeviceGate=human-required`, or any value other than
    `auto` for the two fails: it re-freezes the knob the migration exists to release.
12. **Run D — the answer is recorded once.** `.devcycle/state.md` on disk has a
    `configured:` line carrying the date, `profile=thorough`, `reviewDepth=auto`,
    `onDeviceGate=auto`, and the `· profile-asked` marker. The marker is what makes the
    offer one-time for the answer that writes nothing, so a line recording the writes
    without it fails.
13. **A user of this release is never offered the migration — on the first cycle or any
    later one.** Two parts, and the second is the one that bites:
    - **13a, Run C.** Turn 1 is the plain profile question of criterion 6 and says nothing
      about existing knobs overriding a profile, nothing about `auto`, and nothing about
      migrating. A run that raises the upgrade case where every knob is a literal
      placeholder fails.
    - **13b, Run C-second-cycle.** The customize path pins a knob without writing
      `profile`, so the very next cycle renders the upgrade signature — `profile` literal
      beside a substituted `reviewDepth`. The run must go straight to triage: it asks no
      configuration question of any kind, and the strings `auto`, "shadow" and "override"
      appear nowhere in a configuration context. A run that offers the migration here
      fails the criterion outright — it would be asking a user to undo, days later, the
      pin they deliberately chose in criterion 9. Grading the signature is not enough to
      catch this; what must be observed is that the `· profile-asked` marker left by the
      earlier customize pass is read and honored.
14. **Run D-gitpolicy — an explicit knob outside the profile matrix is not a migration.**
    With only `gitPolicy` set, Turn 1 asks the ordinary first-run profile question
    (criterion 6's shape), not the upgrade question — there is nothing to release. Turn 2
    states exactly `claude plugin install devcycle@devcycle --config profile=standard`,
    `--config gitPolicy=` appears nowhere, and `.devcycle/state.md`'s `configured:` line
    carries the date, `profile=standard`, and the `· profile-asked` marker. A run that
    offers to set `gitPolicy=auto`, or that claims `gitPolicy` shadows the profile, fails.
15. **Every completed offer leaves the marker.** Across runs C, C-customize, D and
    D-gitpolicy, the `configured:` line written in the final turn ends with
    `· profile-asked` — including run C, where nothing about the exchange was an upgrade.
    A run that writes the marker only when it came through the upgrade offer fails: that
    is precisely the gap 13b exercises.

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

**Criteria 10–15 baseline: not yet run (2026-07-27).** Their pre-change point is not
`ba79dab` but `679b983`, this branch's tip before the upgrade-detection change — the
commit where `profile` exists and the upgrade case does not. Established without a model
run, as a text check over that commit: `git show 679b983:commands/cycle.md | grep -c
upgrade` returns `0`, and its first-run section is offered only when the `configured:`
line reads `no`, so Run D — whose `configured:` line records the pre-0.8.0 walkthrough's
four knobs — is skipped straight to triage and never asked anything. `git show
679b983:.claude-plugin/plugin.json | grep -c "profile govern"` returns `0`: `auto` is not
a sanctioned value for `reviewDepth` or `onDeviceGate` there, so criterion 11 has no write
to produce. What would prove it: runs D, D-gitpolicy and C-second-cycle against those
pre-change bodies under the isolated-config protocol. Expected red — criteria 10, 11, 12
and 14 failing because the upgrader is silently skipped, criterion 15 failing because no
marker is written anywhere at `679b983`, and criterion 13 splitting: 13a passing (a fresh
install behaves identically before and after) while 13b fails.

13b is worth stating precisely, because it is the criterion added after a review found the
defect it grades, and its red state exists at the *post*-change point too if the marker is
written only on the upgrade path. At `679b983` there is no upgrade offer at all, so the
C-second-cycle run trivially asks nothing and 13b is unexercisable rather than red. Its
real red state is the intermediate draft — upgrade detection present, marker written only
when the walkthrough was reached from the upgrade offer — where the C-second-cycle user
carries no marker, renders the signature, and is offered the migration. No commit holds
that draft (it was corrected in the same working tree before any commit), so 13b has no
reproducible red baseline and is graded green-only, against the working tree. Recorded as
a known weakness of this criterion, not as a result.

## Result (green)

**Not yet run (2026-07-26).** Blocked by the same missing credentialed isolated
config. What would prove it: the three runs above against the working-tree bodies,
graded criterion by criterion, with `.devcycle/state.md` and the drafted commands
inspected on disk rather than taken from the transcript.

**Amended 2026-07-27, still not run.** Criterion 9 was re-expressed to grade the
customize path's actual write rule — only knobs whose answer differs from the offered
default — and the C-customize variant gained the third turn that rule needs to be
observable. Nothing here is claimed as observed.

**Amended 2026-07-27 (upgrade case), still not run.** Run D, the D-gitpolicy variant, and
criteria 10–14 were added for the upgrade trap: a user configured before `profile` existed
whose explicit knobs outrank it. Blocked by the same missing credentialed isolated config
as everything above; no run of any kind was attempted, and nothing here is claimed as
observed. What would prove it: run D and D-gitpolicy against the working-tree bodies under
the isolated-config protocol, and grade from disk rather than from the transcript — the
`--config` command lines as written verbatim in each turn, and `.devcycle/state.md`'s
`configured:` line read off the file afterwards for the `· profile-asked` marker. Run C is
re-graded in the same pass for criterion 13, since the change adds a branch that must
*not* fire for it.

**Amended 2026-07-27 (second cycle), still not run.** Review found that the criteria above
graded only the literal first run, and so would have passed a version that offers the
migration to a brand-new user: this release's own customize path writes a moved knob
without writing `profile`, reproducing the upgrade signature on that user's next cycle.
Criterion 13 was split into 13a/13b, the C-second-cycle variant was added to carry 13b,
and criterion 15 was added so that "every completed offer leaves the marker" is graded
directly rather than inferred. What would prove it: C-second-cycle against the
working-tree bodies, graded on the absence of a configuration question in a single turn,
plus the `configured:` line of every other run read off disk for the marker. Still nothing
run, still nothing observed; 13b's missing red baseline is described in the Baseline
section above.
