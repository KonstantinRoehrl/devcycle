# Maintaining the Repo

Assess a repository's longitudinal health and stop at a ranked findings document —
assess-then-stop, starting no cycle. **Announce at start:** "I'm using the maintaining-the-repo
playbook to assess the repository."

This is the seam a later phase grows into: cross-pass memory, the abstraction and history
lenses, orientation and fan-out ceilings all attach here. In Phase 1 it is a thin forward to the
existing whole-repo audit — no new review content and no new orchestration layer, so it sits
within the "one thin command" requirement.

## Scope

- No argument → the whole repository.
- A `<concern>` argument, handed over by `${CLAUDE_PLUGIN_ROOT}/commands/maintain.md` (which owns
  the `$ARGUMENTS` grammar; never re-derive it here) → the concern narrows the criteria the audit
  confirms.

maintain has no branch scope: longitudinal health is a whole-repo property.

## Run

Follow `${CLAUDE_PLUGIN_ROOT}/playbooks/reviewing-code.md` at `repo` scope, handing it the
resolved `{ concern | none }`. That playbook owns everything the run needs: the criteria
interview, its lesson matching, lens grouping, the review-panel dispatch, dedup-and-rank, and the
ranked findings document under `docs/audits/`. Phase 1 adds no criteria of its own — the
abstraction criterion and the history lens are a later phase.

## Boundaries (Phase 1)

- Starts no cycle; creates, reads, or writes no `.devcycle/state.md`; emits no handoff block —
  maintenance is not a pipeline stage.
- Mutates no code and no GitHub issue, ever.
- Ends at the ranked findings document, committed per `${user_config.docTrackingPolicy}` exactly
  as `${CLAUDE_PLUGIN_ROOT}/playbooks/reviewing-code.md` commits it.

Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.
