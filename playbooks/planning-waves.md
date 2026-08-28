# Planning Waves

Produce an implementation plan that wave-based parallel execution can consume. Report per
`${CLAUDE_PLUGIN_ROOT}/references/output.md`. **Announce at start:** "I'm using the planning-waves
playbook to create the implementation plan."

Read this stage's lessons: `node "${CLAUDE_PLUGIN_ROOT}/scripts/dream.mjs" --lessons planning`. No store, no output.

## Engine selection (keyed to `profile`)

Resolve `profile` per `${CLAUDE_PLUGIN_ROOT}/references/config.md`. At **`lean` / `standard`** do NOT
load `superpowers:writing-plans` — the Plan mechanics section below is self-contained. At
**`thorough`** it is a REQUIRED SUB-SKILL for all plan-writing mechanics; where the two disagree this
playbook wins, and two of that section's rules always override it — the plan header's "For agentic workers"
line names `${CLAUDE_PLUGIN_ROOT}/playbooks/executing-waves.md` as the executor (never upstream's
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
`${CLAUDE_PLUGIN_ROOT}/playbooks/executing-waves.md` resolves them back to verbatim lines when it
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
for agentic workers naming `${CLAUDE_PLUGIN_ROOT}/playbooks/executing-waves.md` as the REQUIRED
executor and noting checkbox (`- [ ]`) step syntax; `**Goal:**` (one sentence); `**Architecture:**`
(2–3 sentences); `**Tech Stack:**`; `## Global Constraints` (the spec's project-wide requirements —
version floors, dependency limits, naming and copy rules, platform requirements — one line each,
copied verbatim, implicitly part of every task's requirements); and `## Quality Constraints` above.

**Task template — each task carries, in this order:** an H3 `Task N: <Component Name>`; `**Files:**`
(Create / Modify, with `path.py:123-145` line ranges where they help / Test); `**Interfaces:**` (Consumes
— what this task uses from earlier tasks, exact signatures; Produces — what later tasks rely on, exact
function names and parameter and return types); the declaration lines below plus the
`**Quality constraints:**` line above and a `**Lessons:**` line right after it — emitted empty by
planning and filled by `${CLAUDE_PLUGIN_ROOT}/playbooks/executing-waves.md`'s brief-slice from
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
   bare fact (`${CLAUDE_PLUGIN_ROOT}/references/evidence.md` § Authored claims).
5. **No count-only enumeration:** never cite an enumeration by count alone ("all four guardrails");
   one that more than one task reproduces belongs in Global Constraints, verbatim in every brief.
6. **Mirrored-file parity:** diff the pinned blocks where tasks restate logic across mirrored files.
7. **Pasted-code lint:** run `node "${CLAUDE_PLUGIN_ROOT}/scripts/lint-plan-code-blocks.mjs" <plan-path>`
   over the plan just written and fix any JS/mjs code block it flags before a task brief carries it
   forward. Passing the path is what makes this gate non-vacuous: invoked bare it sweeps two
   directories the plan need not be in.
8. **Brief completeness:** run `node "${CLAUDE_PLUGIN_ROOT}/scripts/brief-completeness-check.mjs" <plan-path>` — every task carries Files / Interfaces / Dependencies / a valid Evidence class / Quality constraints, and the Dispatch Map lists every task. Fix any gap it reports.
9. **Blast-radius completeness:** run `node "${CLAUDE_PLUGIN_ROOT}/scripts/blast-radius-check.mjs" <plan-path>` — it hard-fails on a test file that references a task's changed file but is in no Files block, and warns on a non-test referencer. Add each flagged file to the right task's Files block, or record an explicit override — a `- Blast-radius override: <changed-file> [→ <test-file>] — <reason>` line (em-dash before the reason; a reasonless override is a hard error), e.g. referenced only in a comment.
10. **Assumed-tooling cross-check:** every tool or pattern a brief assumes (mock approach, a lint gate such as `prettier --check`, a named test-helper identifier) exists and is accepted by this repo's toolchain — an invented identifier or a rejected pattern is an unverified authored claim (item 4). Verify each against the repo before dispatch.

## The three per-task declaration lines

- `**Dependencies:**` — **derived, not decreed**: a task depends on exactly the tasks whose produced
  interfaces or files it consumes, nothing more, unless a real ordering constraint exists that
  consumption doesn't capture (a migration before schema users, a destructive step last), declared
  with its reason like any other dependency; anything not forced into sequence stays parallel. The
  line takes exactly one of `none (completely independent)`, `Task 2 (consumes its X interface)`, or
  `Tasks 1+4 committed`.
- `**Evidence:**` — `${CLAUDE_PLUGIN_ROOT}/references/evidence.md` owns the three classes and their
  exact declaration forms; use those forms verbatim.
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
`${CLAUDE_PLUGIN_ROOT}/playbooks/executing-waves.md` consumes. Before handing the plan off, run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/wave-disjointness-check.mjs" <plan-path>` -- it only catches a
literal Files-block overlap within one wave, not the harder case of two tasks coupled only by
editing the same shared resource's prose or assertions.

A non-zero exit from self-review items 8 or 9 is a stop, resolved by fixing the plan (or, for
blast-radius, recording an override) — never by handing off around it.

## Reuse before rebuild

The rule is owned by `${CLAUDE_PLUGIN_ROOT}/references/quality-criteria.md` (§Reuse before rebuild).
What planning does with it: each task names the existing modules, helpers, or components it extends,
and a task introducing a new abstraction states why no existing one fits. Find them by running the
repo-research procedure `${CLAUDE_PLUGIN_ROOT}/references/delegation.md` owns (`## Research
dispatches`) before searching file-by-file, with the confirmed scope and affected areas recorded in
`.devcycle/scope.md` as this stage's relevance filter, starting from implementation-scoped docs (a
`frontend.md`, `backend.md`, or equivalent).

## Handoff — required final output

After saving the plan (or issuing a NO-GO report), update `.devcycle/state.md` (`stage: execution` —
the stage to resume at — and the `plan:` path; after a NO-GO, keep `stage: planning`), also writing
`- plan-counts: planned=<count from the Dispatch Map> waves=<wave count from the Dispatch Map>` so
the sensor can carry the plan totals into each progressive workload write (`planned=0 waves=0` after
a NO-GO, where no Dispatch Map exists), then emit this
stage's handoff block per `${CLAUDE_PLUGIN_ROOT}/references/handoff.md`, with
`Stage completed: planning` and the plan path (or the NO-GO report) as its artifact. The plan carries
everything execution needs, so the context action is `Clear + /devcycle:continue`.

Committing the saved plan is gated the way the spec's commit is: resolve
`${user_config.docTrackingPolicy}` against `${CLAUDE_PLUGIN_ROOT}/references/config.md` § Doc
tracking, then `git check-ignore` the plan's path, and commit with an explicit pathspec only when
both permit it — otherwise the plan stays written and uncommitted. This paragraph is outside the
Plan mechanics section, so it binds at `thorough` too, where the upstream skill has no
plan-commit step of its own and `all-tracked` would otherwise never track a plan.
