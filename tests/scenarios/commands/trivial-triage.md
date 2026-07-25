# Scenario: trivial-triage
- Skill under test: commands/cycle.md (`/devcycle:cycle`) — triage size axis and the
  fast-path confirm gate
- Type: output-shape + discipline

Does `/devcycle:cycle` judge a genuinely trivial request against the size checklist and
announce that verdict, hold the fast path behind a confirm gate asked BEFORE any
fast-path work happens, route a confirmed answer to `stage: fast-path` +
`devcycle:fast-path`, and drop the verdict entirely on a declined answer?

## Setup

Create a minimal Node sandbox repo: `package.json` with `"test": "node --test"`,
`src/greet.js` exporting `greet(name)` whose returned string carries the typo
`Helo, ${name}!`, a passing `test/greet.test.js` (asserts only that the name appears, so
the suite is green before the fix), a one-line `README.md`, all on `main`.

The sandbox also carries a `.devcycle/state.md` from a *completed* prior cycle, in the
Step-0 template shape: `stage: done`, `root:` = the sandbox toplevel, `branch: main`,
`request: add a greet() helper with tests`, `none` on every artifact line, and a
`configured:` line recording a date plus all four KEY=VALUE pairs. This is deliberate:
without a recorded `configured:` line the first-run configuration walkthrough fires and
stops the run before triage is ever reached, so triage could not be observed at all.
Everything is committed (two commits), so any file the run touches is visible as a diff.

The command text is spliced raw. For the **green** runs, splice the committed
post-Task-2 `commands/cycle.md` (`git show HEAD:commands/cycle.md`, the text carrying
the size axis). For the **baseline (red)** run, splice `git show
4889d29:commands/cycle.md` — dev HEAD before this feature, which has no size axis and no
fast path. `skills/scoping-interview/SKILL.md` is spliced in every run as the stage the
full pipeline enters. **`skills/fast-path/SKILL.md` is deliberately NOT spliced**: this
scenario tests the routing decision, not the mini-cycle, so criterion 3's pass signal is
the agent *stating* the handoff to `devcycle:fast-path` by name.

Each run is two real turns in one session (`claude -p …` then `claude -p --resume
<session-id> "<scripted reply>"`), not two turns simulated in one response — the turn
boundary is what makes criterion 2 checkable: after Turn 1 the sandbox is inspected on
disk (`git status`, the state file, `src/greet.js`) before the reply is sent. Run the
subagent from the sandbox root with file write access. Each variant gets its own
freshly built sandbox.

## Subagent prompt

> You are a coding agent in this repository, in a brand-new session. Produce your response to the invocation below, then STOP and wait for the user.
>
> === COMMAND (the user invoked `/devcycle:cycle fix the typo in the greeting string`; follow this exactly) ===
> [Splice here: full body of commands/cycle.md — `git show 4889d29:commands/cycle.md` for the baseline run, the committed post-Task-2 text for the green runs.]
> === END COMMAND ===
>
> === STAGE SKILL (devcycle:scoping-interview, if you reach that stage) ===
> [Splice here: full body of skills/scoping-interview/SKILL.md.]
> === END STAGE SKILL ===
>
> Environment notes: AskUserQuestion is not available in this session — where guidance says to use it, send the batch as one plain message with the same shape, then stop for the answer. Skills other than the ones spliced above are not loadable here — where the text says to invoke a skill whose body is not spliced, say what you are handing off to and stop rather than performing its steps. You may read and write files and run git commands. No human is available mid-response, so ask and stop.

Turn 2 is the scripted reply, sent by resuming the same session:

- **Run A (confirm)** and the baseline run: `Yes — go with the fast path.`
- **Run B (decline):** `No — run the full pipeline.`

## Pass criteria

1. A trivial input ("fix the typo in the greeting string") gets a **trivial verdict
   announced with the checklist visibly applied** — the response names the size verdict
   and walks the trivial conditions (fully specified, no design decisions/new
   interfaces, ~two files or fewer, evidence class determinable, root cause evident for
   bugs) rather than asserting triviality bare.
2. The confirm gate (fast path vs. full pipeline) is asked **BEFORE any fast-path work**:
   at the Turn-1 stop there is no implementation on disk (`src/greet.js` still carries
   the typo, no new commit, no branch created) and `.devcycle/state.md` does not read
   `stage: fast-path`.
3. A **confirmed** reply rewrites `.devcycle/state.md` to `stage: fast-path` and invokes
   `devcycle:fast-path` by name. (The skill body is not spliced, so stating the
   invocation is the pass signal — performing the mini-cycle is not required.)
4. A **declined** reply falls through to the normal maturity/kind walk (the entry stage
   triage picked), with the size verdict discarded and nothing extra recorded — no
   `fast-path` value anywhere in the state file, no fast-path artifact written.

## Baseline (red)

Run 2026-07-25 — fresh headless subagent (`claude -p`, model `claude-sonnet-5`),
isolated config (fresh `CLAUDE_CONFIG_DIR` holding only auth; the init event confirmed
`plugins: []`), sandbox per Setup in a session-temp directory, prompt spliced from
`git show 4889d29:commands/cycle.md` — the text that judges `$ARGUMENTS` "on two axes"
and contains no `Size` axis, no trivial checklist, and no occurrence of the string
`fast-path` (verified: `grep -c fast-path` over the spliced text returns 0).

- **Criterion 1 FAIL** — no size axis exists to apply, so no trivial verdict was
  announced. Turn 1's triage line in full: *"**Triage:** Kind = **bug** (typo fix).
  Maturity = one-liner / vague ticket (doesn't name the file or exact text) → entry
  stage is **scoping**, with **diagnosis** to follow since the input doesn't state the
  root cause with evidence itself."* The words "trivial" and "size" appear nowhere in
  Turn 1's output; the run went straight into the scoping interview, ending with a
  scoping question (*"**Confirm the typo and fix** — Yes — that's the typo, fix 'Helo' →
  'Hello' … I'll hold here for your answer before writing the scope summary."*).
- **Criterion 2 not exercisable** — there is no confirm gate to ask before fast-path
  work, and no fast path to do work on. (On disk after Turn 1 the sandbox was untouched
  apart from the expected Step-0 state rewrite: `git status --short` showed only
  `M .devcycle/state.md`, `src/greet.js` still read ``return `Helo, ${name}!`;``, branch
  still `main`, no new commit. Recorded as not-a-delta, not as a pass.)
- **Criterion 3 FAIL** — the scripted reply *"Yes — go with the fast path."* was consumed
  as a *scoping* answer: Turn 2 wrote `.devcycle/scope.md`, moved the state file to
  `stage: brainstorm`, and emitted *"The scope is confirmed, and since the root cause is
  now established with evidence (the literal typo, confirmed by you), this bug skips the
  diagnosis stage and routes straight to brainstorm, per the pipeline's triage rule."*
  The string `devcycle:fast-path` appears zero times across both turns; the only two
  `fast-path` hits in the whole transcript are the agent echoing the user's own words —
  *"Given the fast-path request and how trivial this fix is (one-word spelling
  correction, no design decisions), I'd flag to whoever runs that stage that it's likely
  a rubber-stamp pass rather than real exploration."* — while still handing off to
  `superpowers:brainstorming`. A user asking for the fast path under the pre-change text
  gets the full pipeline anyway.
- **Criterion 4 not exercisable** — with no gate there is no declined branch to fall
  through from.
- Net: **RED** — fails criteria 1 and 3 for the expected reason (the guidance is absent
  from the spliced text), not from a harness error: the run completed cleanly (exit 0,
  no tool errors), read the sandbox, and produced a full pipeline response.

## Result (green)

Runs 2026-07-25 — same protocol and same sandbox build, prompt spliced from the
committed post-Task-2 `commands/cycle.md` ("three axes" + the `Size` checklist + the
confirm gate). Two variants, each its own freshly built sandbox and its own session:
run A answers the gate with `Yes — go with the fast path.`, run B with `No — run the
full pipeline.`

- **Criterion 1 PASS** (both runs). Run A, Turn 1, verbatim: *"**Size: trivial.** Fully
  specified by the request itself, no design decisions or new interfaces, blast radius
  is one file / one line, evidence class is `convention` (fix the obvious spelling error
  — no red/green cycle needed), and the root cause is already evident. All trivial
  criteria are met."* — every checklist condition walked in order, announced alongside
  the other two axes (*"**Maturity:** one-liner request … **Kind:** bug, with root cause
  already evident (not a hunch): `src/greet.js:2` reads `` `Helo, ${name}!` ``"*). Run B
  reached the same verdict with the same conditions enumerated (*"All trivial criteria
  are met: fully specified by the request itself, no design decisions or new interfaces,
  blast radius is 1 file / 1 line, the root cause is self-evident … **Verdict:
  trivial.**"*). Observed variance, recorded not corrected: both runs picked evidence
  class `convention` for what is a behavior change (`red-green` fits better) — the
  criterion pins that a class is *determined and stated*, not which one, so this passes;
  it is noted below as a possible follow-up.
- **Criterion 2 PASS** (both runs). The verdict was followed immediately by the gate,
  not by work. Run A: *"Since this is trivial, I'm required to confirm before acting
  rather than proceeding automatically. Would you like to: 1. **Fast path** — skip the
  full scoping → brainstorm → plan → execution pipeline and just fix the typo directly
  (`Helo` → `Hello` in `src/greet.js`), via `devcycle:fast-path`. 2. **Full pipeline** —
  run the complete scoping/diagnosis/brainstorm/planning/execution/review walk anyway."*
  — then stopped. Disk state at that stop (both runs, checked before the reply was
  sent): `git status --short` = `M .devcycle/state.md` only, no untracked files;
  `src/greet.js` unchanged (``return `Helo, ${name}!`;``); `git log --oneline` still the
  sandbox's two setup commits; `git branch --show-current` = `main` (no topic branch);
  `.devcycle/state.md` at `stage: scoping` with `grep -c fast-path` = 0. No
  implementation, no branch, no `stage: fast-path` before the answer.
- **Criterion 3 PASS** (run A). The confirmed reply produced exactly one file edit —
  `old_string: "- stage: scoping"` → `new_string: "- stage: fast-path"` on
  `.devcycle/state.md` (verified on disk: the file's second line now reads
  `- stage: fast-path`, `configured:` carried forward byte-identical) — and named the
  skill: *"State updated to `stage: fast-path`. This session doesn't have the
  `devcycle:fast-path` skill body loaded, so I can't execute its steps myself — handing
  off to it now and stopping here. Please run `/devcycle:continue` (or invoke
  `devcycle:fast-path` directly) to carry out the fix."* Stopping instead of running the
  mini-cycle is the spliced-environment note working as intended (the skill body is not
  in the prompt); the routing decision — state value plus named handoff — is what this
  criterion pins, and both landed. Minor variance, accepted: the surgical single-line
  edit left the `updated:` timestamp at its Turn-1 value rather than refreshing it.
- **Criterion 4 PASS** (run B). The declined reply dropped the verdict and walked the
  normal path: Turn 2 did the scoping stage's research and asked the scoping batch
  (*"Since AskUserQuestion isn't available, here's the batch as a plain message: **1.
  Summary confirmation:** My reading — `greet()` in `src/greet.js:2` returns …"*), with
  no mention of the fast path anywhere in the turn. On disk after Turn 2: state file
  still `stage: scoping` (the maturity-picked entry stage), `git status --short` =
  `M .devcycle/state.md` only — no scope/plan/ledger file written, nothing extra
  recorded — and a recursive `grep -rn fast-path` over the whole sandbox (excluding
  `.git`) returned **NONE**. The discard is evidenced by behavior rather than by an
  explicit "discarding the trivial verdict" sentence, which the text does not require.
- Net: **GREEN** — all four criteria met (1 and 2 on both variants, 3 on the confirm
  variant, 4 on the decline variant).

### Notes on running this scenario

- Each turn is a real session turn: Turn 1 is `claude -p "<prompt>" --model
  claude-sonnet-5 --output-format stream-json --verbose --dangerously-skip-permissions`
  from the sandbox root with `CLAUDE_CONFIG_DIR` pointed at the isolated config dir;
  Turn 2 is the same command with `--resume <session-id from the init event>` and the
  scripted reply as the prompt. Inspect the sandbox between the two.
- The sandbox's pre-seeded `configured:` line is load-bearing. Without it, both offer
  conditions for the first-run configuration walkthrough hold, the run stops at that
  walkthrough, and triage — the thing under test — never runs.
- Possible follow-up (out of scope here, no text changed for it): both green runs called
  the evidence class `convention` for a code fix that changes behavior. If that pick
  recurs, the place to sharpen it is the fast-path skill's evidence-class list or the
  size checklist's wording — not this scenario's criteria.
