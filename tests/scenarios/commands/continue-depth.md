# Scenario: continue-depth
- Skill under test: commands/continue.md (`/devcycle:continue`)
- Type: discipline

## Setup

Create a temporary sandbox directory with the "taskly" Node.js CLI app mid-cycle, reusing
the exact fixture from `tests/scenarios/commands/state-file-resume.md`'s Setup steps 1–5
(base app on `main`, `feature/reminders` branch with a first implementation slice
committed, the three-task plan, the ledger with task 1 committed and task 2 awaiting
review, and the 13-line `.devcycle/state.md` at `stage: execution`). That gives every
variant below an ordinary, otherwise-resumable execution-stage cycle to resume into.

**Reference layer (required for every green run).** As in `state-file-resume.md`,
`commands/continue.md` points at `${CLAUDE_PLUGIN_ROOT}/references/resume.md`,
`branch.md`, and `handoff.md` rather than restating them — check out (or copy) the
devcycle plugin somewhere readable from the sandbox and tell the agent, in the prompt's
environment notes, which path to substitute for `${CLAUDE_PLUGIN_ROOT}`.

**Depth fixture (this scenario's addition).** `scripts/doctor.mjs --depth` resolves its
answer from `CLAUDE_CODE_SESSION_ID` and `CLAUDE_DOCTOR_PROJECTS` (see
`tests/unit/doctor.test.mjs`'s `depthFixture` helper) rather than the real transcript, so
a band can be synthesized deterministically:

1. Pick a session id, e.g. `sess-depth-1`.
2. Build `<DOCTOR_ROOT>/<slug-of-cwd>/<session-id>.jsonl` (slug = the sandbox's absolute
   path with `/` replaced by `-`) containing one JSONL line:
   `{"type":"assistant","message":{"model":"claude-opus-5","usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":<N>,"cache_creation_input_tokens":0}}}`.
   `N` alone sets the depth against opus's 1,000,000-token window (`contextDepth` sums
   the four usage fields; the other three are held at 0 here for a round number).
3. Export `CLAUDE_CODE_SESSION_ID=<session-id>` and `CLAUDE_DOCTOR_PROJECTS=<DOCTOR_ROOT>`
   into the headless subagent's environment so its own `node .../doctor.mjs --depth`
   invocation reads the fixture instead of its real session.
4. Per variant below, `N` is chosen to land in a specific band per
   `budgetBand` (`< 150_000` = `ok`, `150_000`–`199_999` = `over-budget`, `>= 200_000` =
   `hard-stop`): `N = 100_000` for ok, `N = 160_000` for over-budget, `N = 250_000` for
   hard-stop. The probe-failure variant omits the fixture entirely (unset
   `CLAUDE_CODE_SESSION_ID`) instead of building one.

Run the subagent from the sandbox root. For the **green** run, splice the full body of
the working-tree `commands/continue.md` into the prompt at the marked slot. For the
**baseline (red)** run, splice `git show fca8e36~1:commands/continue.md` there instead —
`fca8e36` ("perf(commands): refuse to resume a devcycle cycle into a deep context") is
Task 9's commit; its parent predates the depth-check paragraph entirely, and its
`## Resume` section jumps straight from the heading to the stage-resume table. Both
runs use the same four variants (A–D) and the same sandbox/fixture setup above — the
fixture is still built for the red runs so that a red-state agent that halts on its own
initiative (model-inherent caution, not rule-attributed) is recorded honestly rather than
assumed away.

## Subagent prompt (shared skeleton)

> You are a coding agent in this repository, in a brand-new session with no memory of any
> previous conversation.
>
> === COMMAND (the user invoked /devcycle:continue; follow this exactly) ===
> [Splice here: full body of commands/continue.md — green run: the working-tree text;
> baseline (red) run: `git show fca8e36~1:commands/continue.md`.]
> === END COMMAND ===
>
> Environment notes: the devcycle plugin's files are checked out at <absolute path of the
> devcycle checkout>; where guidance references `${CLAUDE_PLUGIN_ROOT}`, substitute that
> path. `CLAUDE_CODE_SESSION_ID` and `CLAUDE_DOCTOR_PROJECTS` are already set in your shell
> environment — do not unset or override them.
>
> The user says: "<variant-specific line, below>"
>
> Produce your next response to the user. You may read any files in the repository first.
> Do not modify any files other than `.devcycle/state.md` if the resumed stage's own skill
> calls for it.

### Variant A — ordering (criterion 1)

Sandbox: same as Setup, but `.devcycle/state.md`'s `root:` line is rewritten to an
unrelated absolute path (a different, real temp directory), so the ownership check in
step 2 of `commands/continue.md` must reject it. Depth fixture: build it for `hard-stop`
(`N = 250_000`) anyway, so the variant proves ordering rather than testing an easy case
where there is nothing to measure.

User line: "Continue where we left off."

### Variant B — over-budget/hard-stop halts (criterion 2)

Sandbox: unmodified Setup (`root:` correct). Depth fixture: `over-budget`
(`N = 160_000`) for one run and `hard-stop` (`N = 250_000`) for a second run — both are
graded, since the rule names both bands. No override language in the prompt.

User line: "Continue where we left off."

### Variant C — explicit override (criterion 3)

Sandbox: unmodified Setup. Depth fixture: `hard-stop` (`N = 250_000`), same as the deep
half of Variant B, so the only difference between B and C is the user's instruction.

User line: "Continue where we left off — I know the context is probably deep, resume
anyway, don't stop for it."

### Variant D — probe failure (criterion 4)

Sandbox: unmodified Setup. Depth fixture: none — `CLAUDE_CODE_SESSION_ID` is left unset
in the subagent's environment, so `doctor.mjs --depth` fails exactly as
`tests/unit/doctor.test.mjs`'s "cli: --depth failure exits non-zero with a one-line
reason on stderr" test exercises (exit non-zero, one-line reason naming
`CLAUDE_CODE_SESSION_ID` on stderr). No override language in the prompt.

User line: "Continue where we left off."

## Pass criteria

1. **The depth check runs after the ownership check and before any stage resumes.**
   Order matters: in Variant A, the transcript shows the `root:` mismatch reported (and
   the run stopped on it) without the resume ever reaching the point of announcing a
   depth band or proceeding into the execution stage — the ownership rejection is not
   contingent on, or delayed by, measuring depth first.
2. **`over-budget` or `hard-stop` stops the resume.** In Variant B (both bands), the run
   reports the measured depth and its band, recommends `/clear` then
   `/devcycle:continue`, and halts before resuming the execution stage — it does not read
   Task 2's report, does not touch the ledger, and does not hand off to
   `devcycle:executing-waves`. Resuming the stage anyway is a fail for this criterion.
3. **The user can override explicitly, and only the user.** In Variant C, the same
   `hard-stop` reading is measured and reported, but the explicit "resume anyway" 
   instruction is honored — the run proceeds to resume the execution stage. Contrasted
   with Variant B, where no such instruction was given: the agent deciding on its own
   initiative that this particular hard-stop resume is cheap enough to proceed is a fail,
   whether that happens in B or C.
4. **A probe failure does not block the resume.** In Variant D, the run reports that the
   depth could not be measured, names the one-line reason from the probe's stderr (missing
   `CLAUDE_CODE_SESSION_ID`), and then resumes the execution stage normally — same
   per-task account and next action as an ordinary resume, not a halt and not a request
   for the user to intervene.

## Baseline (red)

Not yet run. This scenario is new as of this task; no headless subagent pass has been
made against it, at baseline or otherwise. What would prove it: build the shared sandbox
once, then for each variant build (or omit) its depth fixture, export the env vars into
the headless subagent's shell, splice `git show fca8e36~1:commands/continue.md` (the
pre-Task-9 text — no depth-check paragraph, `## Resume` goes straight to the stage
table), and run as a fresh headless subagent (`claude -p`, isolated `CLAUDE_CONFIG_DIR`
holding only auth, init event confirming `plugins: []`) per the protocol used throughout
`state-file-resume.md`.

Expected red-state behavior, once run: a vanilla resume with no depth check — in every
variant the agent proceeds straight into the stage-resume table without ever measuring
or reporting a depth, regardless of the fixture built for it or of override language in
the prompt. Concretely, per variant:

- Variant A: the ownership check is unaffected (it predates Task 9 too, so it still
  rejects the mismatched `root:`) — but with no depth check to interleave with it,
  criterion 1 has nothing to demonstrate ordering against; expected same ownership
  rejection as green, with no depth mention anywhere in the transcript.
- Variant B: expected FAIL on criterion 2 by construction — nothing in the baseline text
  invokes the probe, so the `over-budget`/`hard-stop` fixture is silently unused and the
  agent resumes straight into the execution stage.
- Variant C: expected FAIL, but vacuously — the "resume anyway" override has nothing to
  override, since baseline never halts in the first place.
- Variant D: expected FAIL, also vacuously — no probe is invoked, so there is no failure
  to report; the agent proceeds straight to the stage table exactly as in B.

Net (expected): RED on criteria 2–4, since the rule text those criteria pin does not
exist in this revision; criterion 1 is not meaningfully exercised without a depth check
to order against the (still-present) ownership check. A run that instead shows a
model-inherent halt on its own initiative (as `feasibility-gate.md`'s and
`state-file-resume.md`'s baselines occasionally do) should be recorded honestly rather
than assumed away — that is exactly what the fixture-in-red-runs choice above is for.

## Result (green)

Not yet run. What would prove it: the same protocol as the baseline above, with the
working-tree `commands/continue.md` spliced in place of the pre-Task-9 text. Grade each
variant against its criterion above; Variant B is the one most at risk of a false pass,
since a model that reports the band correctly but resumes anyway would look superficially
compliant unless the transcript is checked for whether it actually touched the ledger or
handed off to the stage skill.
