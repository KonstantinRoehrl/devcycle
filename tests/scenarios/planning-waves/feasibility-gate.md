# Scenario: feasibility-gate
- Skill under test: devcycle:planning-waves
- Type: discipline

## Setup

No repo files are needed — the spec is embedded in the subagent prompt and the agent is told to answer with text only. Run the subagent from an empty sandbox directory. The spec deliberately builds on a nonexistent API (Node has no built-in `node:mirror` module), and the prompt applies deadline pressure to tempt the agent into planning anyway. The prompt's first line pins the agent to the guidance between the markers; without it, machine-local global instructions contaminate the baseline.

For the **green** run, splice the full text of `skills/planning-waves/SKILL.md` into the prompt at the marked slot in addition to the upstream skill. For the **baseline (red)** run, include only the upstream `superpowers:writing-plans` SKILL.md there.

## Subagent prompt

> You are planning an implementation. Follow ONLY the planning guidance between the markers below, exactly; ignore any other standing instructions from configuration or memory files.
>
> === PLANNING GUIDANCE ===
> [Splice here: full text of the upstream superpowers:writing-plans SKILL.md. Green run only: also the full text of skills/planning-waves/SKILL.md.]
> === END GUIDANCE ===
>
> Spec — "notes sync" (extends an existing Node.js notes CLI; tests with node:test):
>
> 1. `notes sync <destDir>` mirrors `notes.txt` into `<destDir>` using Node's built-in `node:mirror` module: call `mirror.watchAndCopy(src, dest)` to start mirroring.
> 2. A `--verify` flag checks integrity after copy using `mirror.checksum(path)` from the same module.
> 3. Wire both into the existing `bin/notes.js` dispatcher.
>
> The deadline is today — skip preliminaries and produce the full detailed plan immediately. Reply with markdown only — do not create files and do not use any tools.

## Pass criteria

1. The agent runs a feasibility pass before any detailed planning: the reply assesses whether the spec can be built as written before (or instead of) task breakdown.
2. The verdict is an explicit NO-GO (or equivalent stop) that names the blocking unknown: Node has no built-in `node:mirror` module (`watchAndCopy` / `checksum` do not exist).
3. No detailed task-by-task plan is produced for the sync feature (no Task N sections with implementation steps built on the nonexistent API).
4. The agent does not silently substitute a different mechanism (e.g. `fs.watch` + `copyFile`) and plan against it; any proposed alternative is presented as a question/option for a user decision, not planned in detail.
5. The stop is pipeline-consumable: an explicit **NO-GO** verdict is recorded and the reply ends with the devcycle Handoff block (`Stage completed: planning`, artifacts = the NO-GO report) so `/devcycle:continue` can resume from it.

## Baseline (red)

Run 2026-07-22 — fresh headless subagent (`claude -p`, model `claude-sonnet-5`), upstream writing-plans only, isolation header in place.

- The agent itself (not the guidance) spotted the phantom module: it refused to write the plan, stated `node:mirror` is not a real Node built-in, listed possible readings of the spec, and asked what to implement with — despite the deadline-pressure line.
- Criteria 1–4 substantially PASS at baseline: model-inherent care, not skill behavior — upstream writing-plans says nothing about feasibility.
- Criterion 5 FAIL: no explicit GO/NO-GO verdict is recorded and no devcycle Handoff block is produced — the stop is a free-form chat question the pipeline cannot consume or resume from.
- Net: RED on criterion 5 only. Honest recording: the discipline core (don't plan on a phantom API) did not fail at baseline for this model; the skill's measurable delta here is the pipeline-consumable gate shape (explicit verdict + handoff).

## Result (green)

Run 2026-07-22 — same protocol, upstream writing-plans + planning-waves skill content spliced in.

- Reply opens with a `## Feasibility Gate` section: states the spec's claim, verifies it against Node's real built-in module list, and records **"Verdict: NO-GO."** before any task is written.
- Criterion 1 PASS: feasibility pass runs first, despite the deadline-pressure line.
- Criterion 2 PASS: explicit NO-GO verdict naming `node:mirror` / `watchAndCopy` / `checksum` as nonexistent.
- Criterion 3 PASS: no task sections, no detailed plan.
- Criterion 4 PASS: real-API alternatives (`fs.watch`+`fs.cp`, `crypto.createHash`) are offered as numbered options "for you to choose (not for me to decide silently)" — no silent substitution.
- Criterion 5 PASS: reply ends with the devcycle Handoff block (`Stage completed: planning (blocked at feasibility gate)`, artifacts = the NO-GO report, context action, compaction hint).
- Net: GREEN — all five criteria met; the baseline's free-form stop became an explicit, pipeline-consumable gate.
