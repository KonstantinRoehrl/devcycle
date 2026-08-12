# Taking the Fast Path

The mini-cycle for requests triage has judged trivial and the user has confirmed via the
AskUserQuestion gate (fast path vs. full pipeline), where an Other answer appends `user-correction-at-gate`, the rule `${CLAUDE_PLUGIN_ROOT}/references/ledger.md` owns. This playbook never re-litigates that
verdict — by the time it runs, the trivial checklist has already passed. Instead of the full
scoping → brainstorm → planning → execution → branch-review → on-device walk it runs a single
in-session pass: implement, commit, one reviewer pass, hand to finish. The ceremony
(subagents, plan file, ledger events) is what gets dropped; every guardrail in the steps below
still binds.

**Announce at start:** "I'm using the taking-the-fast-path playbook to implement this in-session."

Report as `${CLAUDE_PLUGIN_ROOT}/references/output.md` requires.

## The mini-cycle

1. **Branch discipline.** Read `${CLAUDE_PLUGIN_ROOT}/references/branch.md` and follow it
   before any edit — the fast path is a committing path like any other, so it never implements
   on the default or an integration branch, whatever the change is. The topic branch recorded
   on the `branch:` line of `.devcycle/state.md` is the durable record of where this work
   lives, and resume (below) keys off it.
2. **Implement in-session.** No subagents, no plan file, no ledger entries — just make the
   change. It still carries the evidence class triage determined at the gate: read
   `${CLAUDE_PLUGIN_ROOT}/references/evidence.md` and produce that class's before/after
   evidence as it specifies, writing this run's files to `.devcycle/evidence/fast-before.txt`
   and `.devcycle/evidence/fast-after.txt` (`fast` is this path's task id). `fast-before.txt`
   opens with one line naming the declared class and the exact verification command, and each
   run's exit status is appended to its own evidence file as the run finishes — that reference
   makes "an exit status contradicts the declared class" and "the class mismatches the diff"
   rejection conditions, and step 5's reviewer can only run those checks if the class, the
   command and the statuses are on disk with the output.
3. **Escalation valve.** If implementation reveals the change is not trivial after all — the
   blast radius is spreading past what triage saw, or a real design choice has surfaced that
   the request didn't settle — stop, say so, and re-enter the normal pipeline at whichever
   stage the discovery calls for (usually scoping or brainstorm), updating
   `.devcycle/state.md` accordingly. Never push a non-trivial change through the fast path
   just because it is already in flight.
4. **Commit** with a Conventional Commit subject, scoped per
   `${CLAUDE_PLUGIN_ROOT}/references/commit-convention.md`'s "Scoping the commit" — read it
   there and follow it. Run `git add -N` on any file the change creates before committing, or
   the pathspec matches nothing for it and the commit aborts.
5. **Light review.** Dispatch exactly ONE `devcycle:task-reviewer` subagent with the diff and
   the two evidence-file paths from step 2; the reviewer reads the declared class and the exact
   command off `fast-before.txt`'s first line, since the fast path writes no implementer report
   to carry them. On reject: fix, re-verify the evidence, re-dispatch. No review panel, no
   cross-model lens, no red-team — those belong to the full branch-review stage, not here. This
   one-reviewer floor is never profile-conditional: a `lean` run runs it too.

   Cap: 2 rounds. One round is one reviewer dispatch plus its fix. Statuses and their
   reporting are owned by `${CLAUDE_PLUGIN_ROOT}/references/loops.md`.

   Write the exit status to `.devcycle/findings/fast-path-status.md` in the one-line form
   `references/loops.md` defines, before reporting anything to the user. The finish stage
   reads that file, not the conversation.
6. **Handoff.** Emit this stage's block per `${CLAUDE_PLUGIN_ROOT}/references/handoff.md` with
   `Stage completed: fast-path` — its table's `fast-path → finish` row gives the context
   action, so the fast path and finish fit in one session. Then set `stage: finish` in
   `.devcycle/state.md` and hand to
   `${CLAUDE_PLUGIN_ROOT}/playbooks/finishing-the-cycle.md` unchanged — that playbook's policy
   resolution and git action apply exactly as they do at the end of the full pipeline.

## State file

Fast-path runs still write `.devcycle/state.md` in the standard shape (`commands/cycle.md`),
with these fields specifically: `scope:`, `spec:`, `plan:` stay `none`, since the mini-cycle
produces none of them; `request:` carries the intent step 2 is implementing; `ledger:` stays
the standard `.devcycle/ledger.md` line but is unused, there being no wave dispatches to log.

## Resume (`/devcycle:continue`)

On re-entry at `stage: fast-path`, read `${CLAUDE_PLUGIN_ROOT}/references/resume.md` and
follow it. Mapped onto this playbook: its `(re)implement` row is step 2, its `dispatch the
task reviewer` row is step 5, and the acceptance it says is never inferable from git is
recorded only by step 6 advancing `stage:` to `finish` — after which `/devcycle:continue`
routes to `${CLAUDE_PLUGIN_ROOT}/playbooks/finishing-the-cycle.md` and never re-enters here.

**No step is optional because the change is small.** A one-line change still gets step 1's
topic branch, step 2's evidence files, step 5's single reviewer dispatch, and — the moment it
stops being small — step 3's valve rather than a push to the finish line.

**Delegation.** `${CLAUDE_PLUGIN_ROOT}/references/delegation.md` exempts this path from
delegate-by-default (`## The short paths`) — working in-session is the point. Its stage budget
still binds: reaching those counters here means triage judged the change trivial and was
wrong. Say so and escalate to the full pipeline rather than pressing on.
