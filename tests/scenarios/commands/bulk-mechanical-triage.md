# Scenario: bulk-mechanical-triage
- Skill under test: commands/cycle.md (`/devcycle:cycle`) — triage size axis,
  bulk-mechanical verdict and the sweep confirm gate
- Type: output-shape + discipline

Does `/devcycle:cycle` judge a genuinely bulk-mechanical request against the
four-point checklist and announce that verdict, hold the sweep path behind
gate 1 asked BEFORE any sweep work happens, route a confirmed answer to
`stage: sweep` + `devcycle:sweeping-mechanical-changes`, prefer trivial for the
same uniform edit limited to two files, and drop the verdict entirely on a
declined answer?

## Setup

Create a minimal Node sandbox repo: `package.json` with `"test": "node --test"`;
`lib/format.js` exporting `newFormat(value)` plus its deprecated alias
`oldFormat` (the same function object, so calls through either name behave
identically); six consumer modules — `lib/badge.js`, `lib/banner.js`,
`lib/greet.js`, `lib/label.js`, `lib/report.js`, `lib/title.js` — each calling
`oldFormat(...)` exactly once; a passing `test/format.test.js` exercising every
consumer (green before the rename and still green after, since the alias
preserves behavior); and a one-line `README.md` documenting the repo's verify
convention: `npm test`. All on `main`.

The build plants the bulk-mechanical pattern deliberately: one uniform edit
rule ("replace every `oldFormat(` call with `newFormat(`") applies identically
to six files with no per-file judgment, the affected files are discoverable by
search (`grep -rl 'oldFormat(' lib/`), and success is checkable by the one
documented command. Six consumers puts the blast radius beyond fast-path scale
(roughly more than three files) without ambiguity.

The sandbox also carries a `.devcycle/state.md` from a *completed* prior cycle,
in the Step-0 template shape: `stage: done`, `root:` = the sandbox toplevel,
`branch: main`, `request: add the format helpers with tests`, `none` on every
artifact line, and a `configured:` line recording a date plus all four
KEY=VALUE pairs. This is deliberate: without a recorded `configured:` line the
first-run configuration walkthrough fires and stops the run before triage is
ever reached, so triage could not be observed at all. Everything is committed
(two commits), so any file the run touches is visible as a diff.

The command text is spliced raw. For the **green** runs, splice the committed
post-Task-1 `commands/cycle.md` (`git show HEAD:commands/cycle.md`, the text
carrying the bulk-mechanical verdict block). For a **baseline (red)** run,
splice `git show e0c762f:commands/cycle.md` — dev HEAD before this feature,
which carries the trivial checklist but no bulk-mechanical verdict and no
occurrence of the string `sweep` (verified: `grep -c` over that revision
returns 0 for both `bulk-mechanical` and `sweep`).
`skills/scoping-interview/SKILL.md` is spliced in every run as the stage the
full pipeline enters. **`skills/sweeping-mechanical-changes/SKILL.md` is
deliberately NOT spliced**: this scenario tests the routing decision, not the
sweep itself, so criterion 3's pass signal is the agent *stating* the handoff
to `devcycle:sweeping-mechanical-changes` by name. `skills/fast-path/SKILL.md`
is not spliced either — variant (b) probes only the Turn-1 verdict.

Three variants, each against its own freshly built sandbox:

- **Variant (a) — confirm:** invoke `/devcycle:cycle replace every oldFormat(
  call with newFormat( across the repo — same arguments, npm test must stay
  green`. Expect the bulk-mechanical verdict plus gate 1; Turn 2's scripted
  reply is `Yes — take the sweep path.`
- **Variant (b) — trivial precedence:** invoke `/devcycle:cycle replace the
  oldFormat( calls in lib/badge.js and lib/banner.js with newFormat( — npm
  test must stay green`. Expect a trivial verdict, not bulk-mechanical; a
  single turn suffices, since the probe is the announced verdict.
- **Variant (c) — decline:** variant (a)'s invocation verbatim; Turn 2's
  scripted reply is `No — run the full pipeline.`

Each two-turn variant is two real turns in one session (`claude -p …` then
`claude -p --resume <session-id> "<scripted reply>"`), not two turns simulated
in one response — the turn boundary is what makes criterion 2 checkable: after
Turn 1 the sandbox is inspected on disk (`git status`, the state file,
`lib/*.js`) before the reply is sent. Run the subagent from the sandbox root
with file write access.

## Subagent prompt

> You are a coding agent in this repository, in a brand-new session. Produce your response to the invocation below, then STOP and wait for the user.
>
> === COMMAND (the user invoked `/devcycle:cycle <the variant's request text>`; follow this exactly) ===
> [Splice here: full body of commands/cycle.md — `git show e0c762f:commands/cycle.md` for the baseline run, the committed post-Task-1 text for the green runs.]
> === END COMMAND ===
>
> === STAGE SKILL (devcycle:scoping-interview, if you reach that stage) ===
> [Splice here: full body of skills/scoping-interview/SKILL.md.]
> === END STAGE SKILL ===
>
> Environment notes: AskUserQuestion is not available in this session — where guidance says to use it, send the batch as one plain message with the same shape, then stop for the answer. Skills other than the ones spliced above are not loadable here — where the text says to invoke a skill whose body is not spliced, say what you are handing off to and stop rather than performing its steps. You may read and write files and run git commands. No human is available mid-response, so ask and stop.

## Pass criteria

1. Variant (a)'s bulk request gets a **bulk-mechanical verdict announced with
   the four-point checklist visibly applied** — the response names the verdict
   and walks the conditions (one uniform edit rule with no per-file judgment,
   fully specified by the request itself, affected files many and discoverable
   by search, success checkable by one command) rather than asserting the
   verdict bare.
2. Gate 1 (sweep path vs. full pipeline) is asked **BEFORE any sweep work**:
   at variant (a)'s Turn-1 stop no edit has been made (`lib/*.js` unchanged,
   `git status --short` shows only `M .devcycle/state.md`, no new commit, no
   branch created), the state file does not read `stage: sweep`, and no sweep
   file list has been derived and put up for confirmation — the concrete file
   list and verify command are gate 2, which belongs to the sweep skill. (A
   search run to judge scale, e.g. counting `oldFormat(` matches, is triage
   and does not fail this criterion; presenting the sweep's input list does.)
3. A **confirmed** reply (variant (a), Turn 2) rewrites `.devcycle/state.md`
   to `stage: sweep` and invokes `devcycle:sweeping-mechanical-changes` by
   name. (The skill body is not spliced, so stating the handoff is the pass
   signal — performing the sweep is not required.)
4. Variant (b)'s two-file request gets a **trivial verdict, not
   bulk-mechanical** — precedence: trivial (roughly two files or fewer) beats
   bulk-mechanical, even though the edit rule is the same. The fast-path
   confirm gate may follow; what this criterion pins is that no
   bulk-mechanical verdict is announced and no sweep path is offered.
5. Variant (c)'s **declined** reply falls through to the normal maturity/kind
   walk (the entry stage triage picked), with the verdict discarded and
   nothing extra recorded — `.devcycle/state.md` never contains the value
   `sweep` at either stop, and no `.devcycle/sweep-plan.md` or
   `.devcycle/sweep-report.json` is ever written.

### Notes on running this scenario

- Each turn is a real session turn: Turn 1 is `claude -p "<prompt>" --model
  claude-sonnet-5 --output-format stream-json --verbose
  --dangerously-skip-permissions` from the sandbox root with
  `CLAUDE_CONFIG_DIR` pointed at an isolated config dir holding only auth (the
  init event should confirm `plugins: []`); Turn 2 is the same command with
  `--resume <session-id from the init event>` and the scripted reply as the
  prompt. Build each sandbox in a session-temp directory and inspect it
  between the two turns.
- The sandbox's pre-seeded `configured:` line is load-bearing, for the reason
  Setup gives — do not drop it when adapting this sandbox.
- The alias export in `lib/format.js` is what makes `npm test` a valid
  one-command success check on both sides of the rename; drop the alias and
  the baseline suite would fail the moment a consumer is renamed ahead of the
  others, which would muddy criterion 2's "no edits yet" probe with unrelated
  red.
