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
- Context action: <Continue | Compact with hint | Clear + /devcycle:continue | Fresh session>
- Compaction hint: Keep <X>. Drop <Y>.
```

At a wave → wave boundary within execution the first field is instead
`Wave completed: <n> of <m> (stage: execution)` — `Stage completed:` is
reserved for true stage ends. These are the only two sanctioned first-field
labels.

At the finish stage specifically, the block carries one additional line, directly after
`Artifacts:` — the resolved git policy, in the exact shape `devcycle:finishing-the-cycle`
defines. No other stage's block carries this line.

Pick the context action from this table and recommend it to the user explicitly:

| Boundary | Action | Keep | Drop |
| --- | --- | --- | --- |
| scoping → brainstorm | Continue | everything | — |
| scoping → diagnosis (bugs) | Continue | everything | — |
| audit → brainstorm (findings selected) | Continue | everything | — |
| diagnosis → brainstorm (root cause established) | Compact with hint | diagnosis report path, reproduction steps, root cause | debugging transcripts, ruled-out hypotheses |
| brainstorm → planning (spec approved) | Compact with hint | spec path, decisions, constraints | design back-and-forth |
| planning → execution (plan approved) | Clear + `/devcycle:continue` | nothing (files carry it) | planning conversation |
| wave → wave (within execution) | Compact if over ~40% context | ledger/plan paths, pinned interfaces, dispatch map, wave status | implementer transcripts, resolved findings |
| execution → branch-review | Clear + `/devcycle:continue` or Fresh session (a reviewer that watched the code being written inherits the implementer's assumptions) | branch, spec path, ledger path | all implementation context |
| branch-review → on-device | Fresh session | checklist path, branch | everything else |
| fast-path → finish | Continue | everything | — |
| sweep → finish | Continue | everything | — |

## Await the context action — never run past a recommended compact or clear

Emitting the handoff block is NOT permission to continue. **Only a `Continue` action lets the
pipeline proceed to the next stage in the same turn.** For every other action — `Compact with
hint`, `Clear + /devcycle:continue`, `Fresh session`, or a `wave → wave` boundary where the
~40% condition to compact is met — STOP after the block and wait: the user must run `/compact`
or `/clear` (or explicitly tell you to continue anyway) before any next-stage work begins. Never
begin the next stage in the same response that recommended a compact or clear — a user who looks
away would otherwise sail past the boundary with an un-cleared context, exactly what this gate
prevents. `/clear` ends the session by design; state the `/devcycle:continue` resume path in the
same message you halt on.
