# Comparison memo: planning-waves vs superpowers:writing-plans

- Upstream read live: `~/.claude/plugins/cache/superpowers-marketplace/superpowers/6.1.1/skills/writing-plans/SKILL.md` (v6.1.1, read 2026-07-22).
- Verdict: **build** — the wave-execution planning mechanics (dependencies, dispatch map, file-disjointness, feasibility gate, reuse-before-rebuild) have no upstream counterpart.

## (a) What upstream already covers (referenced, never restated)

The plugin skill defers to these upstream sections by reference:

- Plan file location and naming (`docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md`).
- Scope check (one plan per independent subsystem).
- File-structure mapping before task decomposition.
- Task right-sizing and bite-sized step granularity (one 2–5 minute action per step).
- Test-first step ordering inside each task (upstream's task template: write the failing test, verify it fails, implement, verify it passes) — the output contract's "checkbox steps with test-first ordering" is satisfied by following upstream, not by anything this skill adds.
- Plan document header template — Goal, Architecture, Tech Stack, and a Global Constraints section.
- Task structure template — `**Files:**` (Create/Modify/Test) and `**Interfaces:**` (Consumes/Produces with exact signatures).
- No-placeholders rules and the "Remember" checklist.
- Self-review checklist (spec coverage, placeholder scan, type consistency).

Note: upstream 6.x already carries the Consumes/Produces interfaces block and a Global Constraints header, so "pinned interfaces" is not wholly new. The plugin delta narrows to making interface pinning serve *concurrent* implementers (see b, item 2) rather than only sequential ones.

## (b) What planning-waves adds (§12.2 — this is the skill's entire content)

1. **Concurrency as a first-class goal.** Task boundaries drawn so parallel tracks are file-disjoint and interface-decoupled. Upstream sizes tasks for review granularity; it never optimizes for parallel dispatch.
2. **Interface pinning for context independence.** Exact signatures/names/values pinned so concurrent implementers never need each other's context and each brief is self-contained. (Sharpens upstream's existing Interfaces block with a purpose upstream doesn't have.)
3. **Per-task `**Dependencies:**` declaration** in exactly three forms: `none (completely independent)` / `Task N (reason)` / `Tasks N+M committed`. No upstream counterpart.
4. **`## Dispatch Map` section** listing waves of file-disjoint, dependency-ready tasks. No upstream counterpart.
5. **File-disjointness rule.** No two tasks touching the same file share a wave, even if both declare no dependencies.
6. **Reuse before rebuild.** Each task names the existing modules/helpers it extends; a task introducing a new abstraction must say why no existing one fits.
7. **Feasibility gate.** A short GO/NO-GO pass before any detailed planning — verify every API/module/tool the spec names, spike the riskiest bit, never plan in detail on an unvalidated assumption. No upstream counterpart (upstream's self-review runs *after* the plan is written; the gate runs *before*).
8. **Plan-format output contract** (the P5 contract, quoted verbatim in the skill) consumed by `devcycle:executing-waves`, plus the devcycle stage handoff block as the skill's final output.

## (c) Conflicts and resolutions

1. **Execution handoff.** Upstream ends by offering a choice: subagent-driven vs inline execution. The devcycle pipeline has no such choice — execution is always wave-based. *Resolution:* planning-waves overrides the handoff; the stage ends with the devcycle handoff block and names `devcycle:executing-waves` as the next stage. No choice is offered.
2. **Plan-header worker pointer.** Upstream's header template tells agentic workers to use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. *Resolution:* in plans produced by this skill, that line names `devcycle:executing-waves` instead.
3. **In-task commit steps.** Upstream tasks end with an implementer "Commit" step. In devcycle, the commit lands only after review acceptance (the executing-waves cycle: implementer TDD → diff → review → commit on accept). *Resolution:* plans do not give tasks an implementer-executed commit step — the Conventional Commit belongs to the executing-waves acceptance cycle.
