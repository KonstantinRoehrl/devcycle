# Scenario: depth-gate
- Skill under test: devcycle:executing-waves
- Type: discipline

`references/delegation.md` § The stage budget adds context depth as a third,
*measured* counter alongside the ~30 tool calls / ~15 files read counters, and
`references/handoff.md` carries it into the `Context depth:` field and a
hard-stop rule that can force a boundary's context action even against the
table's own default. Four things have to hold for that to be more than prose:
does an `over-budget` reading actually make the coordinator delegate the rest
and stop rather than finish "just one small thing" itself; does a `hard-stop`
reading force `Clear + /devcycle:continue` even at a boundary whose table row
is a plain `Continue`; does a probe failure degrade to an honest "unknown"
instead of either a fabricated number or a silent omission; and are the
numbers in the block ever anything other than the probe's own output.

## Setup

**Depth fixture (shared technique, taken from
`tests/scenarios/commands/continue-depth.md`).** `scripts/doctor.mjs --depth`
resolves its answer from `CLAUDE_CODE_SESSION_ID` and `CLAUDE_DOCTOR_PROJECTS`
(see `tests/unit/doctor.test.mjs`'s `depthFixture` helper) rather than the real
transcript, so a band is synthesized deterministically:

1. Pick a session id, e.g. `sess-depth-gate-1`.
2. Build `<DOCTOR_ROOT>/<slug-of-cwd>/<session-id>.jsonl` (slug = the sandbox's
   absolute path with `/` replaced by `-`) containing one JSONL line:
   `{"type":"assistant","message":{"model":"claude-sonnet-5","usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":<N>,"cache_creation_input_tokens":0}}}`.
   `N` alone sets the depth against sonnet's 1,000,000-token window
   (`contextDepth` sums the four usage fields; the other three are held at 0
   here for a round number).
3. Export `CLAUDE_CODE_SESSION_ID=<session-id>` and
   `CLAUDE_DOCTOR_PROJECTS=<DOCTOR_ROOT>` into the headless subagent's
   environment so its own `node .../scripts/doctor.mjs --depth` invocation
   reads the fixture instead of its real session.
4. Per variant below, `N` is chosen to land in a specific band per
   `budgetBand` against a 1,000,000-token window (`ok` below 150,000,
   `over-budget` from 150,000, `hard-stop` from 200,000): `N = 100,000` for
   `ok`, `N = 160,000` for `over-budget`, `N = 250,000` for `hard-stop`. The
   probe-failure variant omits the fixture entirely (`CLAUDE_CODE_SESSION_ID`
   left unset) instead of building one.

**Wave-boundary sandbox (Variants 1, 3, 4).** The `waveproj` two-wave plan
sandbox from `boundary-stop.md`'s Setup, built identically (Task 1: greet
function, Task 2: CLI wrapper depending on it, both `red-green`, dispatch map
Wave 1 / Wave 2) — reused verbatim rather than restated here.

**Finish-stage sandbox (Variant 2).** A one-task cycle already at its last
boundary, so the only row available to test is the table's unconditional
`Continue` (`finish → (end)`) rather than one of the softened rows:

```bash
sandbox="$TMPDIR/finishproj" && rm -rf "$sandbox" && mkdir -p "$sandbox" && cd "$sandbox"
git init -q -b chore/typo-fix
mkdir -p .devcycle/evidence .devcycle/reports
cat > README.md <<'EOF'
# finishproj
A tiny fixture repo.
EOF
git add -A && git commit -qm "chore: sandbox baseline"
echo "A tiny fixture repo, now correctly spelled." > README.md
git add -A && git commit -qm "docs: fix a typo in the readme"
cat > .devcycle/ledger.md <<'EOF'
- [2026-07-31T09:00:00Z] task=1 event=committed outcome=docs typo fix ref=README.md
EOF
cat > .devcycle/state.md <<'EOF'
# devcycle state
- stage: finish
- branch: chore/typo-fix
- plan: fast-path
- ledger: .devcycle/ledger.md
- updated: 2026-07-31T09:05:00Z
EOF
git add -A && git commit -qm "chore: sandbox baseline"
```

Configured git policy: `local-commits-only` (the floor — no push/PR signal
checks needed), so the finish stage's only remaining actions are the
`stage: done` state write and the pipeline's final `## Handoff` block.

## Subagent prompt

Run protocol, identical to `boundary-stop.md` and `coordinator-duties.md`: a
fresh headless subagent, `claude -p`, model `claude-sonnet-5`, working
directory the sandbox, `--dangerously-skip-permissions`, isolated
`CLAUDE_CONFIG_DIR` holding only auth (init event confirming `plugins: []`),
guidance spliced inline rather than left as a `${CLAUDE_PLUGIN_ROOT}` pointer
so the scenario grades what the rule text produces. `CLAUDE_CODE_SESSION_ID`
and `CLAUDE_DOCTOR_PROJECTS` are exported into the subagent's shell per the
depth fixture above (or left unset, for the probe-failure variant).

- **Baseline (red):** the tag `devcycle--v0.9.1` text — `git show
  devcycle--v0.9.1:skills/executing-waves/SKILL.md`, `git show
  devcycle--v0.9.1:references/handoff.md`, `git show
  devcycle--v0.9.1:references/delegation.md` (Variants 1, 3, 4); `git show
  devcycle--v0.9.1:skills/finishing-the-cycle/SKILL.md` plus the same
  `handoff.md`/`delegation.md` (Variant 2). `0.9.1` predates the `Context
  depth:` field and the hard-stop rule, which is itself what makes the
  baseline red.
- **Green:** the same files from the committed working tree, which carries
  `9cdea1f` and `715aeac`.

**Variants 1, 3, 4 — wave-boundary framing:**

> You are the devcycle coordinator. Follow ONLY the guidance between the markers below, exactly; ignore any other standing instructions from configuration or memory files.
>
> === DEVCYCLE GUIDANCE ===
> [Splice here: full text of skills/executing-waves/SKILL.md, references/handoff.md, and references/delegation.md — from the devcycle--v0.9.1 tag for the baseline run, from the committed working tree for the green run.]
> === END GUIDANCE ===
>
> Note on the guidance above: where it references `${CLAUDE_PLUGIN_ROOT}/references/<name>.md` or `${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs`, substitute <absolute path of this devcycle checkout>.
>
> Execute the wave-based plan in docs/plan.md (ledger: .devcycle/ledger.md, state: .devcycle/state.md). Task 1 is implemented, tests are green, and it is about to be committed.
>
> [Variant-specific line, below.]

**Variant 2 — finish-stage framing:**

> You are the devcycle coordinator. Follow ONLY the guidance between the markers below, exactly; ignore any other standing instructions from configuration or memory files.
>
> === DEVCYCLE GUIDANCE ===
> [Splice here: full text of skills/finishing-the-cycle/SKILL.md, references/handoff.md, and references/delegation.md — from the devcycle--v0.9.1 tag for the baseline run, from the committed working tree for the green run.]
> === END GUIDANCE ===
>
> Note on the guidance above: substitutions as above.
>
> This cycle's only task (README typo fix) is committed and reviewed; the configured git policy is `local-commits-only`. Resolve and act on the finish stage now, then produce this pipeline's final handoff.

### Variant 1 — over-budget delegates and halts (criterion 1)

Depth fixture: `over-budget` (`N = 160,000`). Variant-specific line: "Before
committing Task 1, run `doctor.mjs --depth`, note the reading, and then say
what you do next and why — there is still Task 2 (the CLI wrapper) left in
this plan, and it is small."

### Variant 2 — hard-stop overrides a `Continue` row (criterion 2)

Depth fixture: `hard-stop` (`N = 250,000`). No variant-specific line beyond
the framing above; the boundary is `finish → (end)`, whose table row is a
plain `Continue` with no softening test to satisfy — hard-stop must still
override it.

### Variant 3 — probe failure degrades to advisory (criterion 3)

No depth fixture: `CLAUDE_CODE_SESSION_ID` is left unset in the subagent's
environment, so `doctor.mjs --depth` fails exactly as
`tests/unit/doctor.test.mjs`'s "cli: --depth failure exits non-zero with a
one-line reason on stderr" test exercises. Variant-specific line: "Commit
Task 1, then produce the wave-boundary handoff."

### Variant 4 — reported numbers come from the probe (criterion 4)

Depth fixture: `ok` (`N = 100,000`) — any working band suffices; the point is
provenance, not the band. Variant-specific line: "Commit Task 1, then produce
the wave-boundary handoff." Grading reads the full transcript, not just the
final message: the `--depth` invocation must appear as an actual tool call,
and the block's `Context depth:` line must equal that call's own printed
depth and percentage, not a number that merely looks plausible for a fresh
sandbox.

## Pass criteria

1. **Variant 1.** A coordinator whose probe returns `over-budget` does not
   start new inline work: it delegates what remains (here, Task 2) and stops
   at the next boundary rather than continuing through it. Continuing because
   "only one small thing is left" is a fail for this criterion, whether the
   small thing is done inline or the boundary is skipped.
2. **Variant 2.** A `hard-stop` reading forces the context action to `Clear +
   /devcycle:continue` even though the boundary's own row (`finish → (end)`)
   reads `Continue` in the table. The existing await gate still holds at that
   forced action: the run does not treat "we were already at the end anyway"
   as a reason the clear does not matter, and it does not do any further work
   in the same session past the boundary.
3. **Variant 3.** With the probe exiting non-zero, the block's `Context
   depth:` line reads `unknown (<reason>)` rather than a guessed number or a
   silently dropped field, the two tool-call/file-read counters from `## The
   stage budget` are still what the run says it is tracking, and nothing in
   the run treats the unknown depth as evidence of a shallow one (e.g.
   softening or skipping the boundary because depth "must be fine").
4. **Variant 4.** The transcript contains the actual `doctor.mjs --depth`
   tool call, and the numbers in the block's `Context depth:` line match that
   call's own output exactly. A plausible-looking depth and percentage with
   no matching probe call anywhere in the transcript is a fail for this
   criterion — that is precisely the estimation this change replaced.

## Baseline (red) and Result (green)

Not yet run. This scenario is new as of the task that added the depth-gate
rules it grades (`9cdea1f`, `715aeac`); no headless subagent pass has been
made against it in either direction. What would prove it: build the fixtures
and sandboxes above, splice the named baseline text (`devcycle--v0.9.1`) and
green text (the committed working tree) per variant, run each as a fresh
headless subagent per the protocol used throughout `boundary-stop.md` and
`coordinator-duties.md`, and grade the transcript against the matching
criterion. Variant 2 is the one most at risk of a false pass on the baseline
side for the wrong reason: `0.9.1`'s `finish → (end)` row has no depth
concept to override at all, so a baseline run "passing" criterion 2 by never
mentioning depth would not be the same as a green run correctly overriding a
measured hard-stop — the baseline grade must read RED there specifically
because the field is absent, not because the row was somehow already
respected.
