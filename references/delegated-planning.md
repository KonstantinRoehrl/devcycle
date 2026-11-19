# Delegated planning

How `playbooks/planning-waves.md` splits a large plan across dispatches once one of its thresholds
trips, so the coordinator's window holds answers and interfaces, never a spike's or a draft's body.
Every dispatch here follows `references/delegation.md`'s envelope rules and runs at the tier
`references/model-routing.md` § Planning dispatches assigns, naming its model explicitly; this file
owns only the flow, the context pack and the two brief shapes. A finished plan must not show whether
it was delegated.

Work files are run-scoped, under `.devcycle/plan-work/<run id>/` (the state file's `run:`), and each
is logged as it lands, per `references/stage-log.md`, so a resume skips what is done. The coordinator
writes `plan-header.md`, the plan header it composed, once, before it dispatches any drafter; the pack,
spikes, the `tasks/task-<n>.md` files and `merge-findings.md` land as their own sections below say. Spikes run as
`Explore` and drafters as `devcycle:plan-drafter`. Every planning-stage dispatch, the repo-research
one `playbooks/planning-waves.md` § Reuse before rebuild runs included, opens its `description` with
its role: `plan-spike: `, `plan-research: `, `plan-drafter: `, `plan-checker: ` or `plan-repair: `
(a drafter's repair of a finding). `hooks/dispatch-sensor.mjs` reads that prefix into the
`role` of the agent's `agent-cost` row, and doctor's Planning breakdown prices each role from it.

## Spikes — 3+ independent feasibility unknowns

An unknown that needs only reading rides the repo-research dispatch. A spike is its own dispatch,
one per unknown and in parallel, only when it must run something; it changes nothing in the repo
and returns at most fifteen lines in this shape:

```text
Question: <the unknown, one line>
Answer: <GO, NO-GO, or the finding, one line>
Evidence: <what was run or read; each claim marked per references/evidence.md § Authored claims>
Design impact: <what the plan must do differently, or none>
```

The coordinator persists each return to `spikes/<n>.md`, and reads the `Answer:` lines, and the
`Design impact:` section alone of a spike whose impact is non-empty, before the task cut, then logs
`feasibility-verdict`. A NO-GO, or an answer that changes a mechanism the spec names, goes to the
user under planning's feasibility gate.

## Coordinator-only work

Quality Constraints, the task cut, Dependencies, each task's pinned `**Interfaces:**` and the Dispatch
Map stay with the coordinator. They are one global optimisation, so work is split by task, never by
section.

## The context pack

After the task cut the coordinator writes `.devcycle/plan-work/<run id>/pack.md` from what it already
holds, capped at about 8k tokens and ordered stable content first, so every drafter's opening reads
match: the binding conventions for the touched paths, the flat interface table, the research-map path
and its one-line conclusions, the selected spike conclusions, then the per-task spec excerpts. Each
line names its source path, to be read only if the line is insufficient. Whether drafters share a
cached prefix is measured (doctor's P6), never assumed.

## Drafters — 5+ tasks

One `devcycle:plan-drafter` dispatch per task, in parallel. Its brief carries paths, never content:
`pack.md` and `plan-header.md` (whose `## Quality Constraints` section the drafter's
`**Quality constraints:**` line cites), plus inline only the verdict, its own task's pinned Interfaces and its
dependencies' Produces. The agent reads `references/plan-task-format.md` by its own definition. The
drafter writes the whole `### Task <n>` block to `tasks/task-<n>.md`, having derived its Files block
with the template's `--scan`, marked every load-bearing claim it makes, and pinned what the task's
detail level asks of it. Before returning it runs the per-draft gate, `references/plan-task-format.md`
§ Per-task checks' last item. Its envelope is the
result-file shape, with any `Blast-radius override` it wrote as the summary. The coordinator picks each
drafter's tier from the task cut it already holds (its estimated file count, whether the cut marks the
task `code-pinned`, whether it adds an abstraction or crosses packages) by
`node "${CLAUDE_PLUGIN_ROOT}/scripts/read-section.mjs" references/model-routing.md planning-dispatches`,
and falls back as `references/model-routing.md` § Model tiers says.

A drafter whose summary begins `stopped: <what pin cannot hold>` wrote no draft. The coordinator, who
owns Interfaces, decides that pin and re-dispatches the task, or drafts it inline.

## The merge

The coordinator writes its own Dispatch Map to `dispatch-map.md`, then assembles the plan with
`node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-assemble.mjs" .devcycle/plan-work/<run id> --out <plan path>`,
never by reading a task file: the plan header, then `tasks/task-<n>.md` in task order, then the map.
It assembles only once every dispatched task has its file, and the script fails on a missing or
duplicate task id. The cross-task self-review checks are the plan gate's `crossTask` leg, which covers every
`Consumes (Task N)` code span and the placeholder and back-reference scan, and the edge checker below;
spec coverage and enumerations stay the coordinator's.

**Edge checker.** After assembly, `plan-assemble.mjs edges .devcycle/plan-work/<run id>` lists the
producer→consumer pairs, and each pair gets one fast-tier checker dispatch described
`plan-checker: round <n> — Task <p> → Task <c>`. It reads only the two task files and `pack.md`,
keeps to a budget of about 40k tokens of context, and writes its findings to
`.devcycle/plan-work/<run id>/checker/round-<n>/task-<p>-task-<c>.md`; its summary is the finding
count, and the coordinator logs `checker-round-<n>` when the round's dispatches are done. No dispatch
holds the whole plan. The coordinator reads a findings file only when its count is above zero, runs
the plan gate once, and presents the plan to the user by path with `plan-check`'s result and the
findings count; it does not read the plan body on this path.

**Patch, not redraft.** A finding opening `Task <n>:` goes back to that task's original drafter by
`SendMessage`, its agent id logged as `agentId` in the `plan-draft-<n>` stage-log line. A one-line
fix is the coordinator's own `Edit` of the task file. A finding never goes to a fresh dispatch; after
a resume, when the drafter can no longer be reached, the coordinator edits the task file itself. Any
other finding is the coordinator's to fix.

**Round cap.** One checker round, one repair round, then the task files are re-assembled and the plan
gate re-run. A finding the repair left open, or a gate failure that would need a second repair round,
stops and goes to the user in one AskUserQuestion with the residual findings; an Other answer
appends `user-correction-at-gate` (`references/ledger.md` owns the condition).
