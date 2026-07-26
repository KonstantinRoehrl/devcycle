# Comparison memo: planning-waves vs superpowers:writing-plans

- Upstream baseline: `superpowers/6.1.1/skills/writing-plans/SKILL.md` from the plugin
  cache, read 2026-07-22. Memo refreshed 2026-07-26 for the profile split. 6.2.0 is now
  installed alongside 6.1.1. Most upstream claims this memo relies on (plan location, the
  header's worker pointer, the in-task Commit step, the two-option execution offer) were
  spot-checked and still hold there. One does not: 6.2.0 deleted `writing-plans`'
  `## Remember` section outright — see (a). The memo has not otherwise been re-derived
  against 6.2.0.
- Verdict: **build** — the wave-execution planning mechanics (dependencies, dispatch map,
  file-disjointness, feasibility gate, evidence declaration, reuse-before-rebuild) have no
  upstream counterpart at any profile.

## Engine per profile

| profile | plan-writing mechanics | upstream loaded? |
| --- | --- | --- |
| `lean` | devcycle-native, stated inline in the skill's Plan mechanics section | no — explicitly "do NOT load `superpowers:writing-plans`" |
| `standard` | devcycle-native, same section | no |
| `thorough` | upstream overlay, with this skill's Overrides section on top | yes — `superpowers:writing-plans` (REQUIRED SUB-SKILL) |

The engine decides only **where the plan-writing mechanics come from**. Everything in
section (c) below is unconditional, so a finished plan has the same shape whichever engine
produced it — and where the two disagree at `thorough`, this skill wins.

## (a) `thorough` only — upstream's share, referenced and never restated

At `thorough` the skill defers to upstream for:

- Plan file location and naming (`docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md`).
- Scope check (one plan per independent subsystem).
- File-structure mapping before task decomposition.
- Task right-sizing and bite-sized step granularity (one 2–5 minute action per step).
- Test-first step ordering inside each task.
- The plan document header template — Goal, Architecture, Tech Stack, Global Constraints.
- The task structure template — `**Files:**` (Create/Modify/Test) and `**Interfaces:**`
  (Consumes/Produces with exact signatures).
- No-placeholders rules. The `## Remember` checklist that sat beside them is **6.1.1 only**:
  6.2.0 deleted that section, so a `thorough` run on 6.2.0 inherits the no-placeholders
  rules and nothing else from this line.
- Self-review checklist (spec coverage, placeholder scan, type consistency).

Note: upstream 6.x already carries the Consumes/Produces block and a Global Constraints
header, so "pinned interfaces" is not wholly new even at `thorough`. The delta narrows to
making interface pinning serve *concurrent* implementers (see (c)2).

## (b) `lean` / `standard` — the native engine

Upstream is not loaded, so the skill states those same mechanics itself, compactly: plan
location (with a user preference overriding the default), the scope check, task
right-sizing keyed to what a reviewer could meaningfully reject, step granularity ordered
by the task's evidence class, the plan header template, the task template, the
no-placeholders failure list, and a three-point self-review the skill runs itself rather
than dispatching.

This is deliberate duplication of intent, not of text: at these profiles the whole skill is
delta, and the compaction — no upstream skill load — is the point. Two things differ from
upstream even here, and they are the Overrides of section (d) folded straight into the
native templates: the header names `devcycle:executing-waves` as the executor, and the task
template has no Commit step.

## (c) Unconditional delta — every profile

1. **Concurrency as a first-class goal.** Task boundaries are drawn so parallel tracks are
   file-disjoint and interface-decoupled. Upstream sizes tasks for review granularity; it
   never optimizes for parallel dispatch.
2. **Minimal implementer context, as the twin goal.** Every task must be implementable from
   its own brief alone; exact signatures, names, and values are pinned in `**Interfaces:**`
   so concurrent implementers never need each other's context, the planning conversation,
   or the spec's history. A task whose brief cannot be made self-contained is drawn wrong.
   Where the two goals pull apart, the smaller context wins — a longer wave sequence beats
   an overstuffed brief.
3. **Dependencies derived, not decreed.** A task depends on exactly the tasks whose produced
   interfaces or files it consumes, plus any real ordering constraint that consumption does
   not capture (a migration before schema users, a destructive step last), declared with its
   reason. Anything not forced into sequence stays parallel.
4. **Per-task `**Dependencies:**` declaration** in exactly three forms:
   `none (completely independent)` / `Task N (reason)` / `Tasks N+M committed`. No upstream
   counterpart.
5. **Per-task `**Evidence:**` declaration.** Every task names the proof its implementation
   must produce; the three classes and their exact declaration forms are owned by
   `references/evidence.md` and used verbatim rather than restated. The class is planning's
   call, not the implementer's, and `red-green` is never declared where no failing test can
   exist — that would force a faked red or a rejected-correct-work verdict downstream. No
   upstream counterpart.
6. **Optional `**Execution:** sweep` marker**, declared only for one uniform edit rule
   applied identically across a whole file list, and only when the task body pins the
   instruction, the concrete file list, and the verifyCommand verbatim. Any per-file
   judgment disqualifies it. Wave placement is unchanged — file-disjointness already
   isolates a sweep task from its neighbors. No upstream counterpart.
7. **`## Dispatch Map` section** listing waves of file-disjoint, dependency-ready tasks. No
   upstream counterpart.
8. **File-disjointness rule.** No two tasks touching the same file share a wave, even if
   both declare `none`.
9. **Feasibility gate.** A GO/NO-GO pass *before* any detailed planning: verify every API,
   module, and tool the spec names against real docs or code; spike the riskiest bit; on
   NO-GO, name each blocking unknown in plain language and stop rather than footnote it.
   Never silently substitute a different API for one the spec names — that is a spec change
   and needs a user decision. Upstream's self-review runs *after* the plan is written; there
   is no upstream gate before it.
10. **Reuse before rebuild, with a pinned research procedure.** Each task names the existing
    modules or helpers it extends; a task introducing a new abstraction must say why no
    existing one fits. The search follows the repo-research procedure `scoping-interview`
    defines canonically — an existing graphify graph first, read-only, falling back to plain
    search plus a two-phase doc index when the graph is absent or thin, never triggering a
    build or `--update` — with the relevance filter here being the confirmed scope in
    `.devcycle/scope.md`. No upstream counterpart.
11. **Plan-format output contract** consumed by `devcycle:executing-waves`, plus the
    devcycle stage handoff block (per `references/handoff.md`) as the skill's final output,
    with `.devcycle/state.md` updated to `stage: execution` — or kept at `stage: planning`
    after a NO-GO.

## (d) Conflicts and resolutions

All three are *live at `thorough` only*: they are collisions with upstream text, and the
skill's Overrides section is what binds the overlay. At `lean`/`standard` the native
templates already embody the devcycle side, so there is nothing to collide with — the
resolutions themselves are unconditional.

1. **Execution handoff.** Upstream ends by offering a choice: subagent-driven vs inline
   execution. The devcycle pipeline has no such choice — execution is always wave-based.
   *Resolution:* planning-waves overrides the handoff; the stage ends with the devcycle
   handoff block naming `devcycle:executing-waves` as the next stage. No choice is offered.
2. **Plan-header worker pointer.** Upstream's header template tells agentic workers to use
   `superpowers:subagent-driven-development` or `superpowers:executing-plans`.
   *Resolution:* in plans produced by this skill, that line names
   `devcycle:executing-waves` instead.
3. **In-task commit steps.** Upstream tasks end with an implementer "Commit" step. In
   devcycle the commit lands only after review acceptance and the coordinator's green gate.
   *Resolution:* plans never give tasks an implementer-executed commit step — the
   Conventional Commit belongs to the executing-waves acceptance cycle.
