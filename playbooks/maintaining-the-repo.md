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
   lint, the `duplication-check.mjs` pattern
   (`${CLAUDE_PLUGIN_ROOT}/scripts/duplication-check.mjs`), dead-export detection
   (`node "${CLAUDE_PLUGIN_ROOT}/scripts/dead-export-check.mjs"`), and cross-reference / broken-link
   checking (`node "${CLAUDE_PLUGIN_ROOT}/scripts/xref-check.mjs"`) — and hand the lenses those facts
   as evidence. The dead-export and xref checks are **advisory**: their findings print to stdout as
   evidence and they exit 0 even with findings, so only a non-zero (`abort`) exit — the tool could not
   run — omits the fact and is named in the coverage statement. Never spend an LLM lens re-deriving a
   tooling fact; a tool that is unreachable has its fact omitted and named in the coverage statement.
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
     commit/PR cited, reported in this pass's ranked list but — per step 8's persistence rule — never
     written to the store; undetermined → stays `suspected` at low confidence.
   - **Rank alongside lens findings.** Verified/suspected issue fragments merge into the same ranked
     list the engine produces — same severity-first ordering, same tie-break, same sections —
     distinguished only by `Origin: github-issue #<n>` (provenance only; origin never affects rank).
     Selecting one still starts a separate `/devcycle:cycle` naming that finding; maintenance never
     touches the issue on GitHub.

8. **Persistence across passes (§M5) — after the ranked findings exist.** The engine (step 6) and
   issue-folding (step 7) produce the ranked findings; this step gives them cross-pass memory. It is
   the only new write, still read-only toward code and issues.
   - **Assign a repo-local id (Screen).** Each finding gets a `findingId` = `<culprit-kind>:<hash>`
     via `scripts/maintenance-findings.mjs` `findingId(kind, canonicalLocation)`, where
     `canonicalLocation` is built WITHOUT a line number (a symbol/heading anchor) so a finding survives
     cosmetic line moves. An issue-sourced finding uses `github-issue:<n>`. Ids are screened for shape
     before any write and never written to `references/culprits.json`.
   - **Compare against the store.** Read prior records with `readMaintenanceFindings(<targetRoot>)`,
     build `detectedIds` from this pass, and call `verifyMaintenance(records, { detectedIds })` for the
     lifecycle transitions of records that already exist: `persisting` (report "persistent since
     <first-seen>") / `resolved` / `regressed`. A detected id with no prior record comes back in
     `newIds` and is a **new** finding (written with `passes: 1`). Its `gaps` list names
     undetected-active ids whose resolution is uncorroborated (the M4 rename/move limit) — render them
     so a moved-not-fixed finding stays visible.
   - **Offer dismissal.** A finding may be `dismissed` only with a **load-bearing** reason captured on
     the record (`dismissed-reason:`) — a bare skip is not a dismissal. A dismissed finding is excluded
     from the next pass's ranked list and is **never auto-re-evaluated**; it stays dismissed until a
     human asks maintenance to reconsider it.
   - **Rank + report.** Keep the engine's severity-first order as primary (never lowered); within a
     severity tier sort by the trending signal, tie-broken confidence → passes → first-seen. Add
     three longitudinal sections to the findings document: **Previously known (persisting)**,
     **Resolved since last pass**, **Trending**. Every lifecycle transition rendered is backed by
     this pass's live re-detection (verify-before-stating, `planning-waves.md` item 4), never a
     prior pass's wording.
   - **Write the store.** Persist a `persisting`, `regressed`, or new finding with
     `recordMaintenanceFinding(<targetRoot>, rec)` (idempotent by id; issue-sourced findings write a
     `github-issue` record the same way). A finding `verifyMaintenance` classifies `resolved` this
     pass is **deleted, not written** — `removeMaintenanceFinding(<targetRoot>, id)` — a closed loop
     is not a longitudinal artifact worth keeping tracked forever, unlike a `dismissed` record (which
     must persist so it is never re-flagged). This trades away regression detection for that one
     finding: a later recurrence re-enters as brand-new (`passes: 1`), not `regressed` — accepted so
     the store never accumulates settled history. Commit the store by resolving
     `${user_config.docTrackingPolicy}` against `${CLAUDE_PLUGIN_ROOT}/references/config.md` § Doc
     tracking, then `git check-ignore`, then an explicit pathspec — the order
     `learning-from-sessions.md` step 3 uses. Per-file, never one log — a deletion is its own `git rm`
     commit, distinct from a written finding's `git add`.
   - **Per-lens cost rollup (§M7).** Sum each lens's inspector `cost:` envelope and append one
     `lens-cost` run record per lens: `run-record.mjs append --kind lens-cost --stage maintain --lens
     <slug> --cost <dollars> --run <runId>`. Maintenance emits **no** `workload` record, so its cost
     stays on doctor's workload-independent `## Cost by stage` / `### Cost by lens` tables only.

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
- Writes one new artifact — the per-finding `docs/devcycle/maintenance-findings/` store — committed per
  `${user_config.docTrackingPolicy}` (`references/config.md` § Doc tracking); still no code or issue mutation.

Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.
