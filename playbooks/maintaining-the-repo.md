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
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/graph-availability.mjs" --repo . --skills "<comma-separated session skills, e.g. graphify,token-optimizer>" --plugin-root "${CLAUDE_PLUGIN_ROOT}"`
   (the `resolveGraphAvailability` predicate as a CLI, printing `{available,reason}`; `--skills`
   is split on commas only, so pass the list comma-separated — a space-separated value is read as
   one non-matching entry and silently degrades to the `Explore` fallback); on the graph
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
7. **GitHub issues as a second input source — read-only, all depths.** Unless the scoping gate
   excluded it, fold in the target repo's own open issues alongside the lens findings; this runs at
   every profile depth (lean, standard, thorough), since it is a separate input source, not a
   depth-gated lens. A `<concern>` argument narrows which fragments are in scope the same way it
   narrows lens criteria.
   - **Fetch & screen.** Run
     `node "${CLAUDE_PLUGIN_ROOT}/scripts/issue-intake.mjs" --repo <owner/name> --scratch .devcycle/issue-intake/<pass>`.
     It is **read-only** (`gh issue list` only) and redacts third-party body text on a `.devcycle/`
     working copy. On `available:false` (gh missing/unauth/timeout), skip the rest of issue-folding
     and name it in the coverage statement. It excludes devcycle's own `[culprit:]`/`[doctor:]`-titled
     issues before anything downstream; record `counts.excludedCulprit` as a report line ("M
     devcycle-tracked culprit issues, handled by the promotions engine — not re-triaged here").
   - **Decompose before classify.** For each screened issue, split its body into independently
     true-or-false, independently fixable claims — one fast-tier read-only dispatch over the screened
     set. Conservative: don't fragment one coherent problem, but do separate distinct claims. The
     worked example is issue #44's shape: 3 independently-fixable bugs plus several enhancement
     suggestions in one body decompose into 3 bug fragments plus a separate excluded suggestion
     count, never one candidate for the whole issue.
   - **Classify each fragment, after decomposition.** `bug`/`refactor` fragments are candidates;
     `feature` fragments are excluded from the ranked list entirely and kept only as a report count
     ("N feature requests in the backlog, out of scope for maintenance") — never verified. An
     ambiguous bug-vs-feature call falls to `suspected` rather than forcing a binary.
   - **Verify each in-scope fragment** by routing it to whichever existing lens methodology fits its
     claim (a dead-code claim → the dead-code criterion's investigation; an architecture claim → the
     architecture criterion's; no match → a general read-and-attempt-reproduce pass) — lens charters
     used as verification tools against a pre-existing claim, in one session-tier reviewer dispatch
     over the in-scope fragments. Outcomes: `verified` → ranked; doesn't-reproduce → dropped (not
     ranked, not flagged for closing); verified-as-already-fixed → resolved/low, only with a landed
     commit/PR cited; undetermined → stays `suspected` at low confidence.
   - **Rank alongside lens findings.** Verified/suspected issue fragments merge into the same ranked
     list the engine produces — same severity-first ordering, same tie-break, same sections —
     distinguished only by `Origin: github-issue #<n>` (provenance only; origin never affects rank).
     Selecting one still starts a separate `/devcycle:cycle` naming that finding; maintenance never
     touches the issue on GitHub.

## Fan-out ceiling (binding)

A repo-wide multi-lens pass is the unbounded fan-out shape that has historically blown up spend, so:

- the existing per-lens delegation budget (`${CLAUDE_PLUGIN_ROOT}/references/delegation.md`,
  ~30 tool calls / ~15 files) applies **per lens**;
- a global pass ceiling of **at most 5 concurrent panel lenses** and **at most 8 total LLM dispatches
  per pass** (≤5 lenses + 1 history inspector + 1 issue decompose/classify + 1 issue verification;
  the deterministic pre-pass and `issue-intake.mjs` fetch are bounded tool commands, not LLM lenses);
- a **hard stop at the ≥20% context-depth band** `delegation.md` already defines
  (`node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --depth`); on a hard stop the coverage statement
  names the unswept remainder;
- every dispatch names its model; the history inspector routes to the fast tier.

## Boundaries

- Starts no cycle; creates, reads, or writes no `.devcycle/state.md`; emits no handoff block.
- Mutates no code and no GitHub issue, ever.
- Issue-folding is read-only: `gh issue list`/`view` only, never `close`/`comment`/`edit`/`label`.
- Ends at the ranked findings document, committed per `${user_config.docTrackingPolicy}` exactly as
  `${CLAUDE_PLUGIN_ROOT}/playbooks/reviewing-code.md` commits it.

Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.
