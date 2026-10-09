# Planning Waves

Produce an implementation plan that wave-based parallel execution can consume. Report per
`${CLAUDE_PLUGIN_ROOT}/references/output.md`. **Announce at start:** "I'm using the planning-waves
playbook to create the implementation plan."

Read this stage's lessons: `node "${CLAUDE_PLUGIN_ROOT}/scripts/dream.mjs" --lessons planning`. No store, no output.

## Engine selection (keyed to `profile`)

Read `profile` from the `knobs:` line per `${CLAUDE_PLUGIN_ROOT}/references/config.md` § Knob
channel. At **`lean` / `standard`** do NOT
load `superpowers:writing-plans` — the Plan mechanics section below is self-contained. At
**`thorough`** it is a REQUIRED SUB-SKILL for all plan-writing mechanics; where the two disagree this
playbook wins, and two of that section's rules always override it — the plan header's "For agentic workers"
line names `playbooks/executing-waves.md` as the executor (never upstream's
subagent-vs-inline execution choice), and no task gets a commit step. Everything outside that one
section is unconditional, so a finished plan has the same shape whichever engine produced it.

## Feasibility gate — before any detailed planning

Run a short feasibility pass and record an explicit verdict before writing any task:

- Can this be built here, with what actually exists? Verify every API, module, tool, document
  section, and convention the spec names against real docs or code — never assume one exists.
- What are the real unknowns? Spike the riskiest bit if a quick spike can settle it.
- Verdict: **GO**, or **NO-GO** — a stop, not a footnote, since a risk noted inside a detailed plan
  still gets dispatched: name each blocking unknown in plain language, report it for a user decision,
  and write no detailed plan.

Never plan in detail on an unvalidated assumption, and never silently substitute a different API or
mechanism for one the spec names — that is a spec change, offered as a NO-GO option for the user to decide.

## Quality constraints — derived, before any task is written

Read `${CLAUDE_PLUGIN_ROOT}/references/quality-criteria.md` filtered to the confirmed scope — its
`## Forward use` section owns the filtering rule and the cost rule, neither restated here — and emit
a `## Quality Constraints` section into the plan: one line per applicable constraint, numbered
`QC<n>`, shaped `QC1 — <do or don't> (measured against: <repo convention or named source>)`. That
section is **not** `## Global Constraints`: those lines are copied verbatim from the spec, these are
derived from the criteria catalog, and the precedence rule requires the difference to stay visible,
so the two never merge. Each task then carries a `**Quality constraints:**` line — `QC1, QC3`, or
`none` — naming the ids whose subject its own `**Files:**` touch, and
`playbooks/executing-waves.md` resolves them back to verbatim lines when it
slices each brief, so an implementer is told up front what a later audit would flag it for.

## Execution strategy — twin goals

The plan IS the execution strategy: while drawing task boundaries, decide how the tasks will run,
not just what they contain. Two goals govern every boundary decision, together:

- **Maximize parallelism.** Draw boundaries so parallel tracks are file-disjoint and
  interface-decoupled — the more dependency-free, file-disjoint tasks, the wider each wave.
- **Minimize each implementer's context.** Every task must be implementable from its own brief alone:
  pin exact interfaces — signatures, names, values — in its `**Interfaces:**` block, so concurrent
  implementers need neither each other's context nor the planning conversation or the spec's history.
  A brief that cannot be made self-contained means the boundary is drawn wrong — split it or move it.
  When the goals pull apart, prefer the smaller context: a longer wave sequence beats a stuffed brief.

## Plan mechanics — the native engine (`lean` / `standard`)

Skip this section at `thorough`; the sub-skill supplies it there. **Where the plan goes:**
`docs/superpowers/plans/YYYY-MM-DD-<topic>.md`, unless the user prefers another location. A spec
covering multiple independent subsystems should have been split into sub-project specs during
brainstorming; if it wasn't, suggest one plan per subsystem, each producing working, testable
software on its own.

**Task right-sizing and step granularity.** A task is the smallest unit that carries its own test cycle
and is worth a fresh reviewer's gate, ending in an independently testable deliverable: fold setup,
configuration, scaffolding, and documentation steps into the task whose deliverable needs them, and
split only where a reviewer could reject one task while approving its neighbor. Each step is one action,
2–5 minutes of work, ordered as the evidence class requires — for `red-green`: write the failing test /
run it and confirm red / write the minimal code / run it and confirm green; for `green-green`, the baseline
suite run is step 1. Never a commit step.

**Plan header — every plan starts with it:** an H1 `<Feature Name> Implementation Plan`; a blockquote
for agentic workers naming `playbooks/executing-waves.md` as the REQUIRED
executor and noting checkbox (`- [ ]`) step syntax; `**Goal:**` (one sentence); `**Architecture:**`
(2–3 sentences); `**Tech Stack:**`; `## Global Constraints` (the spec's project-wide requirements —
version floors, dependency limits, naming and copy rules, platform requirements — one line each,
copied verbatim, implicitly part of every task's requirements); and `## Quality Constraints` above.

**Task template — each task carries, in this order:** an H3 `Task N: <Component Name>`; `**Files:**`
(Create / Modify, with `path.py:123-145` line ranges where they help / Test); `**Interfaces:**` (Consumes
— what this task uses from earlier tasks, exact signatures; Produces — what later tasks rely on, exact
function names and parameter and return types); the declaration lines below plus the
`**Quality constraints:**` line above and a `**Lessons:**` line right after it — emitted empty by
planning and filled by `playbooks/executing-waves.md`'s brief-slice from
`--match`; then `- [ ]` steps carrying the actual code, the exact command,
and the expected output inline.

**No placeholders.** Every step carries the actual content the implementer needs; none of these may
appear: "TBD", "TODO", "implement later", "fill in details"; "add appropriate error handling" / "add
validation" / "handle edge cases"; "write tests for the above" without the test code; "similar to
Task N" instead of the repeated code (tasks are read out of order, and concurrently); a step that
says what to do without showing how (code steps need code blocks); a reference to a type, function,
or method no task defines.

**Self-review — once the plan is complete,** run this checklist yourself (not a subagent dispatch),
fixing what it finds inline as you go; no re-review pass.

1. **Spec coverage:** point each spec requirement at the task that implements it; add a task for gaps.
2. **Placeholder scan:** search the plan for the failures above and fix them.
3. **Type consistency:** signatures, method names, and property names later tasks use match what
   earlier tasks define — `clearLayers()` in Task 3 but `clearFullLayers()` in Task 7 is a bug.
4. **Factual-claim accuracy:** every load-bearing plan-authored claim — file/section targets,
   locked "must show no changes" regions, verification greps, counts — was checked by running
   the proving command/grep and citing its result, or is marked an assumption; never stated as
   bare fact (`references/evidence.md` § Authored claims). Its mechanized backstop is item 8's
   `authoredClaims` leg — a blocking lint that flags an unguarded `path.ext:line` reference or a
   bare count claim, cleared by a `(verified: <cmd>)` or `(assumption)` marker on the same or an
   adjacent line.
5. **No count-only enumeration:** never cite an enumeration by count alone ("all four guardrails");
   one that more than one task reproduces belongs in Global Constraints, verbatim in every brief.
6. **Mirrored-file parity:** diff the pinned blocks where tasks restate logic across mirrored files.
7. **Assumed-tooling cross-check:** every tool or pattern a brief assumes (mock approach, a lint gate such as `prettier --check`, a named test-helper identifier) exists and is accepted by this repo's toolchain — an invented identifier or a rejected pattern is an unverified authored claim (item 4). Verify each against the repo before dispatch.
8. **Plan gate:** run `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-check.mjs" <plan-path>` — one command,
   seven legs, compact on success: pasted JS/mjs code blocks parse (`codeBlocks`); every task carries
   Files / Interfaces / Dependencies / a valid Evidence class / Quality constraints and the Dispatch Map
   lists every task (`briefCompleteness`); every referencer of a changed file, test or not, sits in some
   Files block (`blastRadius`); no same-wave task's brief names a file another same-wave task edits
   (`contentCoupling`); a task touching a budgeted surface (`playbooks/`, `commands/`, `agents/`,
   `references/` markdown) also touches its budget fixtures and `docs/decisions/README.md`, which holds
   their `budget:` lines — `references/` markdown matches the context budget as well, because a
   playbook's context budget counts every reference it cites (`budgetFixtures`); no two same-wave tasks
   list the same file (`waveDisjointness`); and item 4's claims (`authoredClaims`). A plan with no
   `## Dispatch Map` fails before any leg runs. Three findings clear by an explicit override line
   instead of a fix, each reasonless form a hard error: `- Blast-radius override: <changed-file>
   [→ <referencer>] — <reason>` (e.g. referenced only in a comment), `- Content-coupling override:
   Task B → <file> (Task A) — <reason>` (or a real dependency), and `- Budget-fixture override:
   <surface-or-fixture> — <reason>`. A non-zero exit is a stop, resolved by fixing the plan or recording
   an override — never by handing off around it.

## The three per-task declaration lines

- `**Dependencies:**` — **derived, not decreed**: a task depends on exactly the tasks whose produced
  interfaces or files it consumes, nothing more, unless a real ordering constraint exists that
  consumption doesn't capture (a migration before schema users, a destructive step last), declared
  with its reason like any other dependency; anything not forced into sequence stays parallel. The
  line takes exactly one of `none (completely independent)`, `Task 2 (consumes its X interface)`, or
  `Tasks 1+4 committed`.
- `**Evidence:**` — read the three classes and their exact declaration forms from
  `${CLAUDE_PLUGIN_ROOT}/references/evidence.md` § The three evidence classes; use those forms verbatim.
- `**Execution:** sweep` — optional, and declared only when the task is one uniform edit rule applied
  identically across its whole file list AND the task body pins all three sweep parameters verbatim:
  the instruction, the concrete file list, and the verifyCommand. Executing-waves then runs the task
  through `workflows/mechanical-sweep.js` instead of dispatching an implementer, so the evidence
  class stays orthogonal and is typically `green-green (behavior-preserving)`. Any per-file judgment
  in the rule disqualifies the marker — leave the line off and let a normal implementer take the
  task. Wave placement rules are unchanged.

## Dispatch Map — required final section

The plan ends with a `## Dispatch Map` grouping tasks into waves — `- Wave 1: Task 1, Task 2
(file-disjoint, no dependencies)`, then `- Wave 2: Task 3 (needs Tasks 1+2 committed)`. A wave holds
only dependency-ready, file-disjoint tasks: never place two tasks touching the same file in one
wave, even if both declare `none`. Execution dispatches by readiness from this map, never by written
order. That map, the plan header, and the per-task blocks are the whole contract
`playbooks/executing-waves.md` consumes. Self-review item 8's plan gate checks both a literal
Files-block overlap within one wave and the harder case of two same-wave tasks coupled only because
one's brief names a file the other edits.

## Reuse before rebuild

What planning does with the rule `references/quality-criteria.md` (§Reuse before rebuild) owns:
each task names the existing modules, helpers, or components it extends, and a task introducing
a new abstraction states why no existing one fits. Find them: run the repo-research
procedure `${CLAUDE_PLUGIN_ROOT}/references/delegation.md` owns (`## Research dispatches`) before
searching file-by-file, with the confirmed scope and affected areas recorded in `.devcycle/scope.md`
as this stage's relevance filter, starting from implementation-scoped docs (a `frontend.md`,
`backend.md`, or equivalent).

## Handoff — required final output

After saving the plan (or issuing a NO-GO report), and on a GO after the opt-in gate below, update
`.devcycle/state.md` (`stage: execution` —
the stage to resume at — and the `plan:` path; after a NO-GO, keep `stage: planning`), also writing
`- plan-counts: planned=<count from the Dispatch Map> waves=<wave count from the Dispatch Map>` so
the sensor can carry the plan totals into each progressive workload write (`planned=0 waves=0` after
a NO-GO, where no Dispatch Map exists), then emit this
stage's handoff block per `${CLAUDE_PLUGIN_ROOT}/references/handoff.md`, with
`Stage completed: planning` and the plan path (or the NO-GO report) as its artifact. The plan carries
everything execution needs, so the context action is `Clear + /devcycle:continue`.

Committing the saved plan is gated the way the spec's commit is: read
`docTrackingPolicy` from the `knobs:` line and check it against
`${CLAUDE_PLUGIN_ROOT}/references/config.md` § Doc tracking, then `git check-ignore` the plan's path, and commit with an explicit pathspec only when
both permit it — otherwise the plan stays written and uncommitted. This paragraph is outside the
Plan mechanics section, so it binds at `thorough` too, where the upstream skill has no
plan-commit step of its own and `all-tracked` would otherwise never track a plan. A new
`docs/<subdir>/` the repo means to track needs its own `!docs/<subdir>/` line in `.gitignore` —
the blanket `docs/*` swallows it otherwise — plus an allowlist below any line that re-ignores its
contents; a subdirectory `references/config.md` § Doc tracking keeps local needs neither.

**Opt-in gate (GO only).** Ask one AskUserQuestion — how execution should run — with three
options: **Walk the waves manually** (today's behaviour) · **Unattended — start it now** ·
**Unattended — I'll start it myself**. Offer **Unattended — start it now** only when
`node "${CLAUDE_PLUGIN_ROOT}/scripts/drive-execution.mjs" --check-sandbox` prints
`{"sandboxed":false}` (plus a `sessionHash` for step 3); otherwise say that this session's
sandbox keeps the driver from writing under `~/.claude`, and offer the other two. An Other answer
appends `user-correction-at-gate`; `references/ledger.md` owns the rule. Only the user's answer
opts in (`docs/decisions/README.md`, 2026-10-08 — Unattended execution). On either unattended
answer, in this order:

1. Settle the branch: on the default or an integration branch, cut the topic branch now and record
   it on `branch:` as `references/branch.md` § Committing requires, so the driver's pre-flight
   finds it.
2. Take `<id>` from the `model` that `node "${CLAUDE_PLUGIN_ROOT}/scripts/depth-probe.mjs" --json`
   prints, never from self-report, and `<stamp>` from `node "${CLAUDE_PLUGIN_ROOT}/scripts/stamp.mjs" now`.
3. Rewrite the state file in full as above, adding `- drive: auto model=<id> opted=<stamp>` (with
   ` session=<sessionHash>` on start-now only, so no later Claude Code session can start it), then
   commit the saved plan as the paragraph above gates it, and only then start a driver, so it never
   reads `stage: planning` or meets this session's commit. Write nothing to the ledger: the first
   driven session records the opt-in.
4. **Unattended — start it now:** run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/drive-execution.mjs" --state .devcycle/state.md --model <id> --detach`.
   Exit 3 is a pre-flight refusal: report its reason and offer the manual walk, which drops the
   `drive:` row from the state file. Otherwise print the PID it returns, the log path,
   `tail -f .devcycle/drive.log` to watch it and `kill <PID>` to stop it, emit the handoff, and
   touch the working tree no further. **Unattended — I'll start it myself:** print
   `node "<devcycle-root's output>/scripts/drive-execution.mjs" --state "<the state file's absolute
   path>"` for the user's own terminal, then emit the handoff.
