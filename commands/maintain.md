---
description: "Assess a repository's longitudinal health — how its abstractions and history trend over time — and write a ranked findings document. A bare argument narrows the concern; the whole repo otherwise. Read-only, starts no cycle."
---

# /devcycle:maintain

Assess a repository's longitudinal health — how its abstractions and history are trending —
and write a ranked findings document. In Phase 1 this runs a whole-repo audit and stops at
that document; the cross-pass memory and longitudinal lenses that will set it apart from a
single-shot review arrive in a later phase.

- `/devcycle:maintain` — assess the whole repository.
- `/devcycle:maintain <concern>` — narrow the audit's criteria to that concern (e.g.
  `/devcycle:maintain architecture` assesses the whole repo for architecture).

**`$ARGUMENTS` grammar — a bare argument is always the concern, never a branch.** This command
reuses the grammar `${CLAUDE_PLUGIN_ROOT}/commands/review.md` owns: everything after the command
name is the concern narrowing the criteria, and is never guessed to be a branch, even in a repo
that has a branch by that name. maintain has no branch scope — longitudinal health is a
whole-repo property, not a diff's.

Follow `${CLAUDE_PLUGIN_ROOT}/playbooks/maintaining-the-repo.md`. It starts no cycle and writes
no state file.

Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.
