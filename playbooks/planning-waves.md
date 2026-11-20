# Planning Waves

Produce an implementation plan that wave-based parallel execution can consume. Report per
`${CLAUDE_PLUGIN_ROOT}/references/output.md`. **Announce at start:** "I'm using the planning-waves
playbook to create the implementation plan."

Read this stage's lessons: `node "${CLAUDE_PLUGIN_ROOT}/scripts/dream.mjs" --lessons planning`. No store, no output.

Read `${CLAUDE_PLUGIN_ROOT}/references/stage-log.md` now, and log and skip as it says.

## Engine selection (keyed to `profile`)

Read `profile` from the `knobs:` line per
`node "${CLAUDE_PLUGIN_ROOT}/scripts/read-section.mjs" references/config.md knob-channel`. At **`lean` / `standard`** do NOT
load `superpowers:writing-plans` — the Plan mechanics section below is self-contained. At
**`thorough`** it is a REQUIRED SUB-SKILL for all plan-writing mechanics; where the two disagree this
playbook wins, and these rules of that section always override it — the plan header's "For agentic workers"
line names `playbooks/executing-waves.md` as the executor (never upstream's
subagent-vs-inline execution choice), the header carries a `**Verification gate:**` line, no task gets a
commit step, every task is drafted per `references/plan-task-format.md` (§ Drafting each task below),
and self-review item 7's plan gate runs. Everything outside that one section is unconditional, so a finished plan has
the same shape whichever engine produced it.

## Feasibility gate — before any detailed planning

Run a short feasibility pass and record an explicit verdict before writing any task:

- Can this be built here, with what actually exists? Run
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/spec-claims.mjs" check --spec <spec-path>` first (skip it with
  `spec: none`): a claim on a `verified:` line was confirmed by the spec reviewer against this spec
  and cites files unchanged since, so it stands. Verify every `reverify:` line, every claim the spec
  makes that neither list names, and all of them when it prints `verify every claim`, against real
  docs or code — never assume an API, module, tool, document section or convention exists.
- What are the real unknowns? Spike the riskiest bit if a quick spike can settle it; the
  thresholds below (Delegated planning) say when spikes run as parallel dispatches.
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
so the two never merge. Each task then carries a `**Quality constraints:**` line, which
`references/plan-task-format.md` § The task block defines, and
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

## Delegated planning — thresholds

**3+ independent feasibility unknowns** → parallel spikes. Drafting follows a decision table, run once the
task cut exists: write the cut as `.devcycle/plan-work/<run id>/task-cut.json` (the shape
`scripts/plan-strategy.mjs` documents) and run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-strategy.mjs" <cut path> --planningStrategy <value>`. Log its `strategy`,
`groups`, `drafters` and `est` as stage-log key `drafting-plan`, then draft by `strategy`: `inline`, every task in
this session; `checkpointed`, inline in one segment per wave group, logging `plan-group-<k>` as a segment's
tasks are written; `grouped`, rounds of group drafters; `delegated`, one drafter per task; `split`, the spec is too large for one plan,
a NO-GO under the feasibility gate above. Read
`${CLAUDE_PLUGIN_ROOT}/references/delegated-planning.md` for a spike, `grouped` or `delegated` run.
`planningStrategy` on the `knobs:` line forces the drafting arm: `inline`, `checkpointed`, `grouped` and `grouped-fork`
force theirs, `status-quo` keeps the old threshold (`delegated` from 5 tasks), and `auto` runs the table.

## Plan mechanics — the native engine (`lean` / `standard`)

Skip this section at `thorough`, except self-review item 7 (plan gate), which the override list
names; the sub-skill supplies the rest there. **Where the plan goes:**
`docs/superpowers/plans/YYYY-MM-DD-<topic>.md`, unless the user prefers another location. While planning, on every path, each task is its own work
file `.devcycle/plan-work/<run id>/tasks/task-<n>.md`, beside `plan-header.md` and `dispatch-map.md`;
`node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-assemble.mjs" .devcycle/plan-work/<run id> --out <plan path>`
assembles the plan (it fails on a missing or duplicate task id), and a later change goes into the task
file and is re-assembled. A spec covering multiple independent subsystems should have been split into sub-project specs during
brainstorming; if it wasn't, suggest one plan per subsystem, each producing working, testable
software on its own.

**Task right-sizing and step granularity.** A task is the smallest unit that carries its own test cycle
and is worth a fresh reviewer's gate, ending in an independently testable deliverable: fold setup,
configuration, scaffolding, and documentation steps into the task whose deliverable needs them, and
split only where a reviewer could reject one task while approving its neighbor. How each task's steps are written is `references/plan-task-format.md`'s.

**Plan header — every plan starts with it:** an H1 `<Feature Name> Implementation Plan`; a blockquote
for agentic workers naming `playbooks/executing-waves.md` as the REQUIRED
executor and noting checkbox (`- [ ]`) step syntax; `**Goal:**` (one sentence); `**Architecture:**`
(2–3 sentences); `**Tech Stack:**`; `**Verification gate:**` (the repo's whole verification gate as one
exact shell command in one code span; `references/evidence.md` § File-backed evidence says which tasks run it);
`## Global Constraints` (the spec's project-wide requirements —
version floors, dependency limits, naming and copy rules, platform requirements — one line each,
copied verbatim, implicitly part of every task's requirements); and `## Quality Constraints` above.

**Self-review — once the plan is complete,** run this checklist yourself (not a subagent dispatch; on the delegated path the cross-task items run
as the edge-checker dispatches `references/delegated-planning.md` names, which the inline path never makes), fixing what it finds inline as you go; no
re-review pass.

1. **Spec coverage:** point each spec requirement at the task that implements it; add a task for gaps.
2. **Per-task checks:** every task passed `references/plan-task-format.md` § Per-task checks — run
   them now on each task you drafted inline; a drafter ran them on its own.
3. **Type consistency:** signatures, method names, and property names later tasks use match what
   earlier tasks define — `clearLayers()` in Task 3 but `clearFullLayers()` in Task 7 is a bug. The
   plan gate's `crossTask` leg checks every `Consumes (Task N)` code span; what no span pins is yours.
4. **No count-only enumeration:** never cite an enumeration by count alone ("all four guardrails");
   one that more than one task reproduces belongs in Global Constraints, verbatim in every brief.
5. **Mirrored-file parity:** diff the pinned blocks where tasks restate logic across mirrored files;
   the `crossTask` leg notes a differing mirrored definition.
6. **Proportion:** the plan stays within 5× the spec's bytes and 20% non-test code fences, a red-green
   task's failing-test fences being exempt; above either, cut code to the contract or record
   `- Proportion override: <reason>`.
7. **Plan gate:** run `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-check.mjs" <plan-path> --spec <spec-path>`;
   `plan-check.mjs --help` lists its legs and the override line forms. A non-zero exit is a stop —
   fix the plan or record an override, never hand off around it.

## Drafting each task

Whoever drafts a task — this session inline, or a drafter on the delegated path — reads
`${CLAUDE_PLUGIN_ROOT}/references/plan-task-format.md` and follows it whatever the engine: the task
template, the three per-task declaration lines, Files derivation, No placeholders and the per-task
checks.

## Dispatch Map — required final section

The plan ends with a `## Dispatch Map` grouping tasks into waves — `- Wave 1: Task 1, Task 2
(file-disjoint, no dependencies)`, then `- Wave 2: Task 3 (needs Tasks 1+2 committed)`. A wave holds
only dependency-ready, file-disjoint tasks: never place two tasks touching the same file in one
wave, even if both declare `none`. Execution dispatches by readiness from this map, never by written
order. That map, the plan header, and the per-task blocks are the whole contract
`playbooks/executing-waves.md` consumes. Self-review item 7's plan gate checks both a literal
Files-block overlap within one wave and the harder case of two same-wave tasks coupled only because
one's brief names a file the other edits.

## Reuse before rebuild

What planning does with the rule `references/quality-criteria.md` (§Reuse before rebuild) owns:
each task names the existing modules, helpers, or components it extends, and a task introducing
a new abstraction states why no existing one fits. Find them: run the repo-research
procedure
`node "${CLAUDE_PLUGIN_ROOT}/scripts/read-section.mjs" references/delegation.md research-dispatches` owns before
searching file-by-file, with the confirmed scope and affected areas recorded in `.devcycle/scope.md`
as this stage's relevance filter, starting from implementation-scoped docs (a `frontend.md`,
`backend.md`, or equivalent). That dispatch's `description` opens with `plan-research: `
(`references/delegated-planning.md` owns the role prefixes), and the dispatch names its model at
the tier `node "${CLAUDE_PLUGIN_ROOT}/scripts/read-section.mjs" references/model-routing.md planning-dispatches`
assigns.

## Handoff — required final output

After saving the plan (or issuing a NO-GO report), update `.devcycle/state.md` (`stage: execution` —
the stage to resume at — and the `plan:` path; after a NO-GO, keep `stage: planning`), also writing
`- plan-counts: planned=<count from the Dispatch Map> waves=<wave count from the Dispatch Map>` so
the sensor can carry the plan totals into each progressive workload write (`planned=0 waves=0` after
a NO-GO, where no Dispatch Map exists). Then record the plan's shape with
`node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-stats.mjs" --state .devcycle/state.md --plan <plan path> --spec <spec path> --strategy inline|delegated`
(`delegated` when per-task drafters ran), which appends one `plan-stats` run-record row; skip it after
a NO-GO or with `spec: none`, and report a non-zero exit without stopping on it. Then emit this
stage's handoff block per `${CLAUDE_PLUGIN_ROOT}/references/handoff.md`, with
`Stage completed: planning` and the plan path (or the NO-GO report) as its artifact. The plan carries
everything execution needs, so the context action is `Clear + /devcycle:continue`. How the waves
run — walked or unattended — is settled at execution start, never here (`references/drive.md`).

Committing the saved plan is gated the way the spec's commit is: read
`docTrackingPolicy` from the `knobs:` line and check it against
`node "${CLAUDE_PLUGIN_ROOT}/scripts/read-section.mjs" references/config.md doc-tracking-what-each-policy-commits`, then `git check-ignore` the plan's path, and commit with an explicit pathspec only when
both permit it — otherwise the plan stays written and uncommitted. This paragraph is outside the
Plan mechanics section, so it binds at `thorough` too, where the upstream skill has no
plan-commit step of its own and `all-tracked` would otherwise never track a plan. A new
`docs/<subdir>/` the repo means to track needs its own `!docs/<subdir>/` line in `.gitignore` —
the blanket `docs/*` swallows it otherwise — plus an allowlist below any line that re-ignores its
contents; a subdirectory `references/config.md` § Doc tracking keeps local needs neither.
