# Handoff blocks

The contract for every stage boundary in a devcycle run. Skills and commands name this
file; none of them restate it.

At every boundary: update `.devcycle/state.md`, then emit the handoff block as the
stage's final output. **One block per completed stage, no batching:** when several
stages complete in a single response or session, each stage still emits its own
`## Handoff` block, in order, at that stage's end — never one merged or summary
block for the run. A stage that is skipped or judged not applicable (e.g.
on-device with no rendered surface) still emits its block: the skip IS the stage
outcome. The finish stage emits the pipeline's final block. The block shape:

```markdown
## Handoff
- Stage completed: <stage>
- Artifacts: <paths, one per line>
- Carry-overs: <pinned interfaces / open decisions, or "none">
- Context action: <Continue | Clear + /devcycle:continue | Fresh session>
- Compaction hint: Keep <X>. Drop <Y>.
```

At a wave → wave boundary within execution the first field is instead
`Wave completed: <n> of <m> (stage: execution)` — `Stage completed:` is
reserved for true stage ends. These are the only two sanctioned first-field
labels.

At the finish stage specifically, the block carries one additional line, directly after
`Artifacts:` — the resolved git policy, in the exact shape `devcycle:finishing-the-cycle`
defines. No other stage's block carries this line.

Pick the context action from this table and recommend it to the user explicitly. The action
column takes exactly three values — `Continue`, `Clear + /devcycle:continue`, `Fresh session`
— and the table gives each boundary's default. Only the test below may soften one.

| Boundary | Action | Keep | Drop |
| --- | --- | --- | --- |
| scoping → brainstorm | Clear + `/devcycle:continue` | scope path, confirmed constraints, open `<tbd>`s | interview transcript, research output |
| scoping → diagnosis (bugs) | Clear + `/devcycle:continue` | scope path, reproduction steps | interview transcript |
| audit → brainstorm (findings selected) | Clear + `/devcycle:continue` | audit path, the selected findings | audit transcript, rejected findings |
| diagnosis → brainstorm (root cause established) | Clear + `/devcycle:continue` | diagnosis report path, reproduction steps, root cause | debugging transcripts, ruled-out hypotheses |
| brainstorm → planning (spec approved) | Clear + `/devcycle:continue` | spec path, decisions, constraints | design back-and-forth |
| planning → execution (plan approved) | Clear + `/devcycle:continue` | nothing (files carry it) | planning conversation |
| wave → wave (within execution) | Clear + `/devcycle:continue` | ledger/plan paths, dispatch map, wave status | implementer transcripts, resolved findings |
| execution → branch-review | Clear + `/devcycle:continue` | branch, spec path, ledger path | all implementation context |
| branch-review → on-device | Fresh session | checklist path, branch | everything else |
| fast-path → finish | Clear + `/devcycle:continue` | branch, what changed | the implementation conversation |
| sweep → finish | Clear + `/devcycle:continue` | branch, sweep report path | per-file sweep output |
| finish → (end) | Continue | — | — |

A reviewer that watched the code being written inherits the implementer's assumptions, which is
why `execution → branch-review` resets rather than carries: the clear is bias control as much
as cost control.

**When `Continue` is permitted instead.** At `scoping → brainstorm`, `scoping → diagnosis`,
`audit → brainstorm`, `fast-path → finish`, and `sweep → finish` — and nowhere else — the
action softens to `Continue` when all three hold:

- the stage that just ended stayed under the budget in
  `${CLAUDE_PLUGIN_ROOT}/references/delegation.md` (`## The stage budget`); and
- it dispatched no implementer, task-reviewer, or sweep — a research dispatch does not count,
  because it returns a map on the fast tier and barely moves the coordinator's depth; and
- the next stage's inputs are all on disk.

Any doubt resolves to the table's default. A light scoping interview may flow into brainstorm;
a heavy one stops.

## Await the context action — never run past a recommended compact or clear

Emitting the handoff block is NOT permission to continue. **Only a `Continue` action lets the
pipeline proceed past that boundary in the same turn**, and `Continue` is only ever reached
through the table above or its test. For `Clear + /devcycle:continue` and `Fresh session`,
STOP after the block and wait: the user must run `/clear` (or explicitly tell you to continue
anyway) before **any work past that boundary** begins — the next stage, or the next wave
within execution. Every boundary the table names is a boundary in this sense: finishing wave 1
of 3 halts exactly as hard as finishing a stage, and dispatching wave 2's implementers is work
past that boundary.

The gate is unconditional for the agent and overridable only by the user. The orchestrator may
not decide on its own judgment that this particular boundary is cheap enough to run through —
that judgment is what the table and its test already made. How small the plan is, how few waves
are left, and how urgent the run feels are not exceptions; they are the reasons the gate is
written down rather than left to judgment. A user who looks away would
otherwise sail past the boundary with an un-cleared context, which is exactly what this gate
prevents. `/clear` ends the session by design; state the `/devcycle:continue` resume path in the
same message you halt on.
