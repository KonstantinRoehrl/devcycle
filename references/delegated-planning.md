# Delegated planning

How `playbooks/planning-waves.md` splits a large plan across dispatches once one of its thresholds
trips, so the coordinator's window holds answers and interfaces, never a spike's or a draft's body.
Every dispatch here follows `references/delegation.md`'s envelope and model-routing rules; this file
owns only the flow and the two brief shapes. A finished plan must not show whether it was delegated.

Work files are run-scoped, under `.devcycle/plan-work/<run id>/` (the state file's `run:`), and each
is logged as it lands, per `references/stage-log.md`, so a resume skips what is done. Spikes and
drafters dispatch as `general-purpose` at the session tier: both are planning judgment, and both
write a file.

## Spikes — 3+ independent feasibility unknowns

One dispatch per unknown, in parallel, read-only on the repo except its own `spikes/<n>.md`:

```text
Question: <the unknown, one line>
Answer: <GO, NO-GO, or the finding, one line>
Evidence: <what was run or read; each claim marked per references/evidence.md § Authored claims>
Design impact: <what the plan must do differently, or none>
```

Its envelope names the file and repeats the `Answer:` line, nothing more. The coordinator reads only
the `Answer:` lines, then logs `feasibility-verdict`. A NO-GO, or an answer that changes a mechanism
the spec names, goes to the user under planning's feasibility gate.

## Coordinator-only work

Quality Constraints, the task cut, Dependencies, each task's pinned `**Interfaces:**` and the Dispatch
Map stay with the coordinator. They are one global optimisation, so work is split by task, never by
section.

## Drafters — 5+ tasks

One dispatch per task, in parallel. Its brief carries paths, never content: the spec, the relevant
spike files, and the installed `playbooks/planning-waves.md` for the task template and the No
placeholders rule. Inline it carries only the verdict, its own task's pinned Interfaces and its
dependencies' Produces. The drafter writes the whole `### Task <n>` block to `drafts/task-<n>.md`,
having derived its Files block with the template's `--scan`, marked every load-bearing claim it
makes, and prototyped and marked every fenced block it pins. Before returning it scans its own draft
for placeholders (TBD, "write tests for the above") and back-references to another task ("similar to
Task N"). Its envelope names the file and lists any `Blast-radius override` it wrote.

## The merge

The coordinator splices by shell concatenation, never by reading a draft: its own plan header, then
`drafts/task-<n>.md` in task order, then its own Dispatch Map. The cross-task self-review checks —
spec coverage, type consistency, no count-only enumeration, mirrored-file parity, and a scan of the
merged plan for placeholders and cross-task back-references — run as one `general-purpose` checker
dispatch over the merged plan's path, which returns findings only. The coordinator reads `plan-check`'s
output and those findings, then runs the plan gate once; where the plan goes to the user for approval,
`references/delegation.md`'s exemption for a plan under approval applies. A finding that opens
`Task <n>:` goes back to that task's drafter as a fresh dispatch carrying the finding and the draft's
path; any other finding is the coordinator's to fix.
