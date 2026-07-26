# Scenario: triage-confirmation
- Skill under test: commands/cycle.md (`/devcycle:cycle`) — the single triage
  confirmation over all three verdicts
- Type: discipline

Does `/devcycle:cycle` confirm **every** triage verdict — maturity (with its entry
stage and reason), kind, and size — in ONE AskUserQuestion before any stage runs,
including when no short path is on the table? And is skipping scoping never decided
unilaterally: does a mature-looking ticket still stop for the user, and does "start
at scoping instead" actually reroute the run?

## Setup

Reuse the "taskly" sandbox from `stop-gate.md` (tiny Node.js CLI todo app:
`package.json`, `lib/tasks.js` with `addTask`/`listTasks`/`completeTask` persisting
to `tasks.json`, `bin/taskly.js` dispatching `add | list | done`, `README.md`,
committed to git).

Add a `.devcycle/state.md` from a *completed* prior cycle, in the Step-0 template
shape: `stage: done`, `root:` = the sandbox toplevel, `branch: main`, `request: add
a done command`, `none` on every artifact line, and `configured: 2026-07-20
profile=standard`. The recorded `configured:` line is load-bearing — without it the
first-run configuration walkthrough fires and stops the run before triage is reached,
so triage could not be observed at all. Commit everything, so any file the run
touches shows up as a diff.

The request is a **detailed ticket**, deliberately: it is the maturity verdict that
skips scoping, and this scenario is about that skip being confirmed rather than
taken. It is not trivial (a new interface plus several behaviors) and not
bulk-mechanical (no uniform edit rule), so no short path fires — which is exactly
the case the pre-change text asked nothing about.

Splices: the full bodies of `commands/cycle.md` and `skills/scoping-interview/SKILL.md`
(the stage a rerouted run enters). `superpowers:brainstorming` is deliberately NOT
spliced: this scenario tests the routing decision, so the pass signal is the agent
*naming* the stage it hands off to. For the **baseline (red)** run, splice
`git show ba79dab:commands/cycle.md` — the pre-change text, which announces the
maturity and kind verdicts and asks only when a short-path verdict fired.

Each run is two real turns in one session (`claude -p …`, then `claude -p --resume
<session-id> "<scripted reply>"`), not two turns simulated in one response: the turn
boundary is what makes criterion 3 checkable, because the sandbox is inspected on
disk after Turn 1 and before the reply is sent. Each variant gets its own freshly
built sandbox.

## Subagent prompt

> You are a coding agent in this repository, in a brand-new session. Produce your response to the invocation below, then STOP and wait for the user.
>
> === COMMAND (the user invoked the following; follow this exactly) ===
> `/devcycle:cycle Add pagination to the list command: taskly list --page N --size M. Default size 20. A page past the end prints "no tasks on that page" and exits 0. A size above 100 clamps to 100. Acceptance: unit tests covering the default size, the clamp, and the past-the-end message.`
>
> [Splice here: full body of commands/cycle.md.]
> === END COMMAND ===
>
> === STAGE SKILL (devcycle:scoping-interview, if you reach that stage) ===
> [Splice here: full body of skills/scoping-interview/SKILL.md.]
> === END STAGE SKILL ===
>
> Environment notes: AskUserQuestion is not available in this session — where guidance says to use it, send the batch as one plain message with the same shape, then stop for the answer. Skills other than the ones spliced above are not loadable here — where the text says to invoke a skill whose body is not spliced, say what you are handing off to and stop rather than performing its steps. You may read and write files and run git commands. No human is available mid-response, so ask and stop.

Turn 2 is the scripted reply, sent by resuming the same session:

- **Run A (confirm):** `Confirm — start where you said.`
- **Run B (correct):** `Start at scoping instead.`

## Pass criteria

1. **One confirmation, covering all three verdicts.** Turn 1 contains exactly one
   batch (one AskUserQuestion call, or one plain-message batch in this environment)
   and it states all three verdicts: the entry stage the maturity verdict picked
   **and why**, the kind verdict, and the size verdict. Two separate asks, or a
   verdict announced but left out of the question, fails.
2. **The confirmation fires even with no short path available.** No trivial or
   bulk-mechanical verdict applies here, and the batch is asked anyway. Its options
   are Confirm and Start at scoping instead, plus Run the full pipeline; no
   short-path option is offered, because none is on the table.
3. **Nothing runs before the answer.** At the Turn-1 stop, `git status --short`
   shows at most `M .devcycle/state.md`: no `.devcycle/scope.md`, no spec, no plan,
   no ledger, no branch created (`git branch --show-current` = `main`), no edits to
   `lib/tasks.js`, and no brainstorm or design content in the response. Skipping
   scoping has been proposed, not performed.
4. **Run A — a confirmed skip proceeds to the announced stage, and only then.**
   Turn 2 enters the stage Turn 1 named (brainstorm for this ticket) and says so by
   name; `.devcycle/state.md` is rewritten to that stage, carrying `configured:`
   forward unchanged.
5. **Run B — the correction wins over the verdict.** Turn 2 runs the scoping stage
   instead: a scoping batch per `devcycle:scoping-interview`, `.devcycle/state.md`
   at `stage: scoping`, and no brainstorm or spec work anywhere in the turn. The
   agent does not re-argue the maturity verdict.
6. **No verdict is acted on silently.** Across both runs, no response asserts a
   skip as already decided ("this is a detailed ticket, so we start at brainstorm"
   followed by brainstorm work in the same turn) — the entry stage is always
   proposed with its reason and held for the answer.

## Baseline (red)

**Not yet run (2026-07-26).** No protocol-compliant model run was produced: the
harness requires a fresh `CLAUDE_CONFIG_DIR` holding only credentials, and on the
machine this scenario was written the CLI in an isolated config directory answers
`Not logged in · Please run /login`. A run in the machine's real config directory
would load the installed devcycle plugin organically, which `engine-selection.md`'s
baseline-hygiene note excludes as contaminated.

Established without a model run — a text check over the pre-change command, not a
behavioral result:

- The pre-change triage section opens "Judge `$ARGUMENTS` on three axes and
  **announce all verdicts with the entry stage before proceeding**" — announce, not
  confirm, and proceeding is the default.
- Its only ask is conditional on a short path: "**Neither verdict** is ever acted on
  automatically: announce it and ask via AskUserQuestion, offering the short path
  against the full pipeline" — "neither verdict" is the trivial and bulk-mechanical
  pair. With no short path in play, the pre-change text asks nothing at all, so the
  maturity verdict that skips scoping is taken unilaterally.

What would prove it: run A against `git show ba79dab:commands/cycle.md` under the
isolated-config protocol. Expected red — criteria 1 and 2 failing (no question is
asked at all for this input), criterion 3 likely failing with it, since a run that
never stops walks straight into the entry stage it announced.

## Result (green)

**Not yet run (2026-07-26).** Blocked by the same missing credentialed isolated
config. What would prove it: runs A and B against the working-tree
`commands/cycle.md`, two real session turns each, with the sandbox inspected on
disk between the turns (`git status --short`, `git branch --show-current`,
`.devcycle/state.md`) rather than graded from the transcript.
