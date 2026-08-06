# Fast Path

The mini-cycle for requests triage has judged trivial and the user has confirmed
via the AskUserQuestion gate (fast path vs. full pipeline). This skill never
re-litigates that verdict — by the time it runs, the trivial checklist has already
passed and confirmation has already happened. What it runs instead of the full
scoping → brainstorm → planning → execution → branch-review → on-device walk is a
single in-session pass: implement, commit, one reviewer pass, hand to finish. All
four guardrails a plan task would carry — branch discipline, verbatim evidence, an
escalation valve, and an independent review — still apply; only the ceremony
around them (subagents, plan file, ledger events) is dropped.

**Announce at start:** "I'm using the fast-path skill to implement this in-session."

Report as `${CLAUDE_PLUGIN_ROOT}/references/output.md` requires.

## The mini-cycle

1. **Branch discipline.** Read `${CLAUDE_PLUGIN_ROOT}/references/branch.md` and
   follow it before any edit — the fast path is a committing path like any other.
   The topic branch recorded on the `branch:` line of `.devcycle/state.md` is the
   durable record of where this work lives, and resume (below) keys off it.
2. **Implement in-session.** No subagents, no plan file, no ledger entries — just
   make the change. It still carries an evidence class exactly as a plan task
   would, determined already at the triage gate. Read
   `${CLAUDE_PLUGIN_ROOT}/references/evidence.md` and produce the class's
   before/after evidence as it specifies, writing this run's files to
   `.devcycle/evidence/fast-before.txt` and `.devcycle/evidence/fast-after.txt`
   (`fast` is this path's task id). Note each run's exit status as you go — it
   cannot be recovered from the file afterwards, and step 5 hands it over.
3. **Escalation valve.** If implementation reveals the change is not trivial after
   all — the blast radius is spreading past what triage saw, or a real design
   choice has surfaced that the request didn't settle — stop, say so, and re-enter
   the normal pipeline at whichever stage the discovery calls for (usually scoping
   or brainstorm), updating `.devcycle/state.md` accordingly. Never push a
   non-trivial change through the fast path just because it is already in flight.
4. **Commit** with a Conventional Commit subject, scoped per
   `${CLAUDE_PLUGIN_ROOT}/references/commit-convention.md`'s "Scoping the commit" — read
   it there and follow it. Run `git add -N` on any file the change creates before
   committing, or the pathspec matches nothing for it and the commit aborts.
5. **Light review.** Dispatch exactly ONE `devcycle:task-reviewer` subagent with
   the diff, the two evidence-file paths from step 2, and — because the short
   path produces no implementer report to carry them — the declared evidence
   class, the exact command, and the before/after exit statuses step 2 noted.
   `${CLAUDE_PLUGIN_ROOT}/references/evidence.md` makes "an exit status
   contradicts the declared class" a rejection condition, so a reviewer handed
   only the paths cannot run the check it is told to run. On reject: fix,
   re-verify the evidence, re-dispatch until accept. No review panel, no
   cross-model lens, no red-team — those belong to the full branch-review stage,
   not here. This one-reviewer floor is never profile-conditional: a `lean` run
   runs it too.
6. **Handoff.** Emit this stage's block per
   `${CLAUDE_PLUGIN_ROOT}/references/handoff.md` with
   `Stage completed: fast-path` — its table's `fast-path → finish` row gives the
   context action, so the fast path and finish fit in one session. Then set
   `stage: finish` in `.devcycle/state.md` and hand to
   `${CLAUDE_PLUGIN_ROOT}/playbooks/finishing-the-cycle.md` unchanged — that skill's policy resolution and
   git action apply exactly as they do at the end of the full pipeline.

## State file

Fast-path runs still write `.devcycle/state.md` in the standard shape
(`commands/cycle.md`), with these fields specifically:

- `scope:`, `spec:`, `plan:` stay `none` — the mini-cycle produces none of them.
- `request:` carries the intent (what step 2 is implementing).
- `ledger:` stays the standard `.devcycle/ledger.md` line but is unused — the fast
  path has no wave dispatches to log.

## Resume (`/devcycle:continue`)

On re-entry at `stage: fast-path`, read
`${CLAUDE_PLUGIN_ROOT}/references/resume.md` and follow it. Mapped onto this
skill: its `(re)implement` row is step 2, its `dispatch the task reviewer` row is
step 5, and the acceptance it says is never inferable from git is recorded only by
step 6 advancing `stage:` to `finish` — after which `/devcycle:continue` routes to
`${CLAUDE_PLUGIN_ROOT}/playbooks/finishing-the-cycle.md` and never re-enters this skill.

## Guardrails preserved vs. dropped

| Rationalization | Reality |
| --- | --- |
| "It's trivial, skip the reviewer pass" | Step 5 is not optional — one `devcycle:task-reviewer` dispatch is the floor, even for a one-line change. |
| "It's trivial, evidence isn't worth capturing" | The evidence class from step 2 still needs its before/after files; "it obviously works" is not evidence. |
| "It got bigger, but I'm already halfway through" | That is exactly what the escalation valve (step 3) exists for — stop and re-enter the pipeline, don't finish a non-trivial change on the fast path because it's in flight. |
| "It's a doc/config tweak, branch discipline doesn't matter" | Step 1 applies to every fast-path change — never implement directly on the default or an integration branch. |

**Delegation.** `${CLAUDE_PLUGIN_ROOT}/references/delegation.md` exempts this path from its
delegate-by-default rule (`## The short paths`) — working in-session is the point. The counters
in `## The stage budget` still bind: reaching ~30 tool calls or ~15 file reads here means
triage judged the change trivial and was wrong. Say so and escalate to the full pipeline rather
than pressing on.
