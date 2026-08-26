# Taking the Fast Path

Triage's short in-session alternative to the full pipeline, entered only after triage has judged
the request trivial (a strict checklist, any doubt on any criterion means not trivial) and the
user has confirmed via the AskUserQuestion gate — this playbook never re-litigates that verdict,
it only executes what it already implies.

Instead of the full scoping → brainstorm → planning → execution → branch-review → on-device
walk, it runs a single in-session pass: implement, commit, one reviewer pass, hand to finish. The
ceremony that gets dropped is subagents, the plan file, and wave ledger entries — every
guardrail that isn't ceremony still binds, evidence discipline included. The mini-cycle is six
steps: (1) branch discipline — read `references/branch.md` and never implement on the default or
an integration branch, the same rule any committing path follows; (2) implement in-session, no
subagents or plan file, still producing the before/after evidence the triage-determined class
requires, written to `.devcycle/evidence/fast-before.txt` and `fast-after.txt` (`fast` is this
path's task id) with the declared class and exact command on `fast-before.txt`'s first line; (3)
an **escalation valve** — if implementation reveals the change isn't trivial after all (blast
radius spreading, a real design choice surfacing), stop and re-enter the normal pipeline at
scoping or brainstorm rather than forcing a non-trivial change through; (4) commit with a
Conventional Commit subject, scoped per `references/commit-convention.md`, running `git add -N`
first on any newly created file; (5) light review — exactly one `devcycle:task-reviewer`
dispatch reading the declared class and command off `fast-before.txt`, capped at 2 rounds, its
verdict written to `.devcycle/findings/fast-path-status.md` before anything is reported to the
user; (6) handoff to `playbooks/finishing-the-cycle.md`, unchanged from how the full pipeline
finishes.

No step shrinks because the change is small: a one-line change still gets its own topic branch,
its own evidence files, and its own single reviewer dispatch — the moment it stops being small,
step 3's valve applies rather than a push to the finish line. This path is one of the two short
paths `references/delegation.md` exempts from delegate-by-default (alongside
`playbooks/sweeping-mechanical-changes.md`), since working in-session — rather than dispatching
an implementer subagent — is the entire point of taking it.

## How it fits
- Up: [the pipeline](../../pipeline/README.md) — triage's "trivial, after you confirm" branch,
  the short-path alternative to full-pipeline execution.
- Source: [`playbooks/taking-the-fast-path.md`](../../../playbooks/taking-the-fast-path.md) — the
  behavior spec this page summarizes.
</content>
