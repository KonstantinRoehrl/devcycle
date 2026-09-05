---
description: "Assess a repository's longitudinal health — how its abstractions and history trend over time — and write a ranked findings document. A bare argument narrows the concern; the whole repo otherwise. Read-only, starts no cycle."
---

# /devcycle:maintain

Assess a repository's longitudinal health — how its abstractions and history are trending —
and write a ranked findings document. The pass runs depth-gated longitudinal lenses, keeps a
cross-pass findings store so how long a finding has persisted is part of how it ranks, and at the
`thorough` profile adds a history inspector. It stops at that document: assess-then-stop,
starting no cycle.

- `/devcycle:maintain` — assess the whole repository.
- `/devcycle:maintain <concern>` — narrow the audit's criteria to that concern (e.g.
  `/devcycle:maintain architecture` assesses the whole repo for architecture).

**`$ARGUMENTS` grammar — a bare argument is always the concern, never a branch. This command owns
it; the playbook consumes the concern it is handed and does not re-derive the syntax.** Everything
after the command name is the concern narrowing the criteria, and is never guessed to be a branch,
even in a repo that has a branch by that name. maintain has no branch scope — longitudinal health
is a whole-repo property, not a diff's.

A pass also folds in the target repo's own **open GitHub issues** as a read-only second input
source. `${CLAUDE_PLUGIN_ROOT}/playbooks/maintaining-the-repo.md` step 7 owns that pipeline.

Follow `${CLAUDE_PLUGIN_ROOT}/playbooks/maintaining-the-repo.md`. It starts no cycle and writes
no state file.

Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.
