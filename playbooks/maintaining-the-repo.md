# Maintaining the Repo

Assess a repository's longitudinal health and stop at a ranked findings document —
assess-then-stop, starting no cycle. **Announce at start:** "I'm using the maintaining-the-repo
playbook to assess the repository."

This playbook wraps the shared review engine (`${CLAUDE_PLUGIN_ROOT}/playbooks/reviewing-code.md`)
rather than adding a second one: it orients the pass graph-first, gathers deterministic facts, then
runs depth-gated longitudinal lenses through that engine. It adds no control plane of its own — the
one engine touch is the optional orientation/hotspot input the engine already documents — and stays
**read-only** throughout.

## Scope

- No argument → the whole repository.
- A `<concern>` argument, handed over by `${CLAUDE_PLUGIN_ROOT}/commands/maintain.md` (which owns
  the `$ARGUMENTS` grammar; never re-derive it here) → the concern narrows the criteria the audit
  confirms.

maintain has no branch scope: longitudinal health is a whole-repo property.

## Run

Read this stage's lessons: `node "${CLAUDE_PLUGIN_ROOT}/scripts/dream.mjs" --lessons audit`. Reuses the audit store.

This playbook is **read-only**: it starts no cycle, writes no `.devcycle/state.md`, mutates no code
and no GitHub issue.

1. **Resolve maintenance depth.** Resolve `profile` per
   `${CLAUDE_PLUGIN_ROOT}/references/config.md` and read its **maintenance depth** row:
   `lean` = existing criteria only; `standard` = + the **Abstraction** criterion
   (`${CLAUDE_PLUGIN_ROOT}/references/quality-criteria.md`); `thorough` = + the history inspector.
2. **Scoping gate (mandatory, before any dispatch).** Run `reviewing-code.md` § 1's criteria
   interview and resolve knobs — the batched AskUserQuestion gate. Hard STOP until the user replies.
3. **Orientation — one shared digest, graph-first.** Compute graph availability with
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/graph-availability.mjs" --repo . --skills "<this session's skills>" --plugin-root "${CLAUDE_PLUGIN_ROOT}"`
   (the `resolveGraphAvailability` predicate as a CLI, printing `{available,reason}`); on the graph
   path dispatch the Research procedure (`${CLAUDE_PLUGIN_ROOT}/references/delegation.md`
   § Research dispatches) to read the report and query for high-centrality/high-churn nodes, else a
   bounded read-only `Explore` dispatch. Produce one compact **repo digest** and a **hotspot file
   list** handed to every lens.
4. **Deterministic-facts pre-pass.** Gather what tooling establishes exactly — dependency audit,
   dead-export detection, lint, broken-link check, and the `duplication-check.mjs` pattern
   (`${CLAUDE_PLUGIN_ROOT}/scripts/duplication-check.mjs`) — and hand the lenses those facts as
   evidence. Never spend an LLM lens re-deriving a tooling fact; a tool that is unreachable has its
   fact omitted and named in the coverage statement.
5. **History (thorough only).** Dispatch `devcycle:history-inspector` at the **fast tier** within its
   bounded traversal window (the smaller of the last 500 commits or 6 months, owned by the agent).
   Fold its churn/convergence signal into the Abstraction charter's historical-convergence input and
   keep its own findings.
6. **Depth-gated criteria → the engine.** Confirmed criteria = existing criteria always; **standard**
   adds **abstraction**; **thorough** additionally carries **history** evidence. Follow
   `${CLAUDE_PLUGIN_ROOT}/playbooks/reviewing-code.md` at `repo` scope, handing it the confirmed
   criteria, the **hotspot file list** (which scopes its `--match … --files` call rather than the
   whole tree), and the **digest** (its optional orientation input). The engine owns the panel
   dispatch, dedup-and-rank, and the ranked `docs/audits/` document.

## Fan-out ceiling (binding)

A repo-wide multi-lens pass is the unbounded fan-out shape that has historically blown up spend, so:

- the existing per-lens delegation budget (`${CLAUDE_PLUGIN_ROOT}/references/delegation.md`,
  ~30 tool calls / ~15 files) applies **per lens**;
- a global pass ceiling of **at most 5 concurrent panel lenses** and **at most 6 total LLM dispatches
  per pass** (≤5 lenses + 1 history inspector; the deterministic pre-pass is bounded tool commands,
  not LLM lenses);
- a **hard stop at the ≥20% context-depth band** `delegation.md` already defines
  (`node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --depth`); on a hard stop the coverage statement
  names the unswept remainder;
- every dispatch names its model; the history inspector routes to the fast tier.

## Boundaries

- Starts no cycle; creates, reads, or writes no `.devcycle/state.md`; emits no handoff block.
- Mutates no code and no GitHub issue, ever.
- Ends at the ranked findings document, committed per `${user_config.docTrackingPolicy}` exactly as
  `${CLAUDE_PLUGIN_ROOT}/playbooks/reviewing-code.md` commits it.

Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.
