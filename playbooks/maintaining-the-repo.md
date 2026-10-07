# Maintaining the Repo

Assess a repository's longitudinal health and stop at a ranked findings document —
assess-then-stop, starting no cycle. **Announce at start:** "I'm using the maintaining-the-repo
playbook to assess the repository."

This playbook wraps the shared review engine (`playbooks/reviewing-code.md`)
rather than adding a second one: it orients the pass graph-first, gathers deterministic facts, then
runs depth-gated longitudinal lenses through that engine. It adds no control plane of its own — the
one engine touch is the optional orientation/hotspot input the engine already documents — and
stays inside § Boundaries.

## Scope

- No argument → the whole repository.
- A `<concern>` argument, handed over by `commands/maintain.md` (which owns
  the `$ARGUMENTS` grammar; never re-derive it here) → the concern narrows the criteria the audit
  confirms.

maintain has no branch scope: longitudinal health is a whole-repo property.

## Run

Read this stage's lessons: `node "${CLAUDE_PLUGIN_ROOT}/scripts/dream.mjs" --lessons audit`. Reuses the audit store.

This playbook's limits are § Boundaries'.

**Pass start — before anything is dispatched.** Resolve `$base_branch` — the integration branch when
one exists, else the default branch — per `${CLAUDE_PLUGIN_ROOT}/references/branch.md` § Committing,
by its bare name. Store PRs merge on GitHub, so the local branch usually lags them: run
`git fetch origin "$base_branch"`, then bind `$base` to `origin/<name>` whenever it resolves, fetched
now or earlier, else per `${CLAUDE_PLUGIN_ROOT}/references/branch.md` § "Names first". When the
fetch fails (offline, no `origin`) or `origin/<name>` still does not resolve (a `--single-branch`
clone fetches only `FETCH_HEAD`), report that the comparison may miss store records landed since
`$base` was last updated. `$base` feeds the stranded check, the store comparison and the worktree
cut; only `gh pr create --base` takes `$base_branch`, as GitHub rejects an `origin/` name. Run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/maintenance-findings.mjs" stranded --base "$base"`. A
`stranded <ref>` line is an earlier pass's store writes that never landed: stop and ask whether to
land or delete that branch first, or to proceed knowingly. `skipped` lines are reported, not blocking.

1. **Resolve maintenance depth.** Read `profile` from the `knobs:` line per
   `${CLAUDE_PLUGIN_ROOT}/references/config.md` § Knob channel and read its **maintenance depth** row:
   `lean` = existing criteria only; `standard` = + the **Abstraction** criterion; `thorough` = + the
   history inspector.
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
   adds **abstraction** — read `${CLAUDE_PLUGIN_ROOT}/references/abstraction-and-strengths.md` for
   its method; **thorough** additionally carries **history** evidence. Follow
   `${CLAUDE_PLUGIN_ROOT}/playbooks/reviewing-code.md` at `repo` scope, handing it the confirmed
   criteria, the **hotspot file list** (which scopes its `--match … --files` call rather than the
   whole tree), and the **digest** (its optional orientation input). The engine owns the panel
   dispatch and dedup-and-rank; `playbooks/writing-the-findings-document.md` writes the ranked
   `docs/audits/` document.
7. **GitHub issues as a second input source — read-only, all depths.** Unless the scoping gate
   excluded it, fold in the target repo's own open issues alongside the lens findings; this runs at
   every profile depth (lean, standard, thorough), since it is a separate input source, not a
   depth-gated lens. A `<concern>` argument narrows which fragments are in scope the same way it
   narrows lens criteria.
   - **Fetch & screen.** Run
     `node "${CLAUDE_PLUGIN_ROOT}/scripts/issue-intake.mjs" --repo <owner/name> --scratch .devcycle/issue-intake/<pass>`.
     It is **read-only** (`gh issue list` only) and redacts third-party body text on a `.devcycle/`
     working copy. On `available:false` (gh missing/unauth/timeout), skip the rest of issue-folding
     and name it in the coverage statement. It excludes devcycle's own
     `[culprit:]`/`[doctor:]`/`[compliance:]`-titled issues before anything downstream; record
     `counts.excludedCulprit` as a report line ("M
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
   issue-folding (step 7) produce the ranked findings; this step gives them cross-pass memory
   through one command, `node "${CLAUDE_PLUGIN_ROOT}/scripts/maintenance-findings.mjs" <verb>`, whose
   `apply-pass`, `dismiss` and `stranded` verbs are the store's only write path — never edit a
   record by hand. The store holds no issue records — `${CLAUDE_PLUGIN_ROOT}/CONTRIBUTING.md`
   § What belongs in `docs/` owns the defect-state split — so a folded issue's number stays on its
   `Origin:` line in the pass document.
   - **Write the pass file.** Write `.devcycle/maintain/pass-<date>.json`, `<date>` the pass
     document's own: a JSON array with one `{ culpritKind, canonicalLocation, title, severity,
     confidence, affectedFiles, verify? }` entry per ranked finding except an `Origin: github-issue`
     one, which the store does not hold (above), every field but `verify` mandatory.
     `canonicalLocation` is built WITHOUT a line number (a symbol/heading anchor) so a finding
     survives cosmetic line moves; `apply-pass` derives each `<culprit-kind>:<hash>` id from
     it, and ids are never written to `references/culprits.json`. Two entries deriving one id reject
     the pass: merge them (highest severity, union of affected files, the clearer title) and re-run.
   - **Decide the doc-tracking veto — before comparing.** Read `docTrackingPolicy` from the
     `knobs:` line and check it against `${CLAUDE_PLUGIN_ROOT}/references/config.md` § Doc tracking,
     then `git check-ignore`
     the store path; either one vetoing committing the store is a veto. It picks the store every
     dry run below reads: under a veto, the checkout's (`--root <checkout>`, no `--ref`), which
     holds earlier uncommitted passes; otherwise the one committed at `"$base"` (`--ref "$base"`),
     which the write's worktree is cut from — so the preview and the write read the same store.
   - **Compare against the store.** Run `apply-pass --pass <file> --date <date> --dry-run` on the
     store the veto picked. Its buckets are this pass's lifecycle: `new`, `persisting` (report
     "persistent since <first-seen>"), and `dismissed` (kept out of the ranked list).
   - **Resolution — confirmed, never automatic.** When a `<concern>` narrowed the pass, any lens
     failed, a hard stop fired, or the coverage statement names an unswept remainder, resolution is
     refused and **Resolved since last pass** renders "not assessed: partial pass". Otherwise re-run
     the dry run with `--resolve`, show its `resolved` rows, and ask the user to confirm; declined, it
     renders "not assessed: declined". A resolved record is deleted, not written — a closed loop is
     not a longitudinal artifact, so the store never accumulates settled history, and a recurrence
     re-enters as new. `apply-pass` never runs a record's `verify:`, so every resolution is also in
     `gaps`: render them, so a moved-not-fixed finding stays visible.
   - **Offer dismissal.** A finding is `dismissed` only with a **load-bearing** reason — `dismiss --id
     <id> --reason "<text>"`, plus `--title` when the stored title is blank; a bare skip is not a
     dismissal. A dismissed finding is excluded from the next pass's ranked list and is
     **never auto-re-evaluated**; it stays dismissed until a human asks to reconsider it
     (`dismiss --id <id> --revoke`).
   - **Rank + report.** Keep the engine's severity-first order as primary (never lowered); within a
     severity tier sort by the trending signal, tie-broken confidence → passes → first-seen — the
     rule `scripts/maintenance-findings.mjs`'s `rankByTrending` implements and singly owns, named
     here rather than silently re-specified. Add three longitudinal sections to the findings
     document: **Previously known (persisting)**, **Resolved since last pass**, **Trending**. Every
     lifecycle transition rendered is backed by this pass's live re-detection (verify-before-stating,
     `planning-waves.md` item 4), never a prior pass's wording.
   - **Commit gate.** Under a veto, ask nothing and cut no branch: run `apply-pass --root <checkout>`,
     with `--resolve` exactly when the user confirmed it, and each accepted `dismiss` in the
     checkout, and leave the store uncommitted. Otherwise ask one question: *commit the store on
     `chore/maintenance-findings-<date>` and open a PR* · *commit only* · *don't commit*.
   - **Write and land.** On either commit answer, cut the branch per
     `${CLAUDE_PLUGIN_ROOT}/references/branch.md` § Committing's standalone-worktree rule:
     `git worktree add -b chore/maintenance-findings-<date> .devcycle/maintain/wt-<date> "$base"` (a
     taken name gets `-2`, `-3`, …). Run `apply-pass [--resolve] --root <worktree>`, then each accepted
     `dismiss --root <worktree>`, then commit the `written` paths with `git add` and the `deleted`
     paths with `git rm` — two pathspec commits, `docs(maintenance): record the <date> pass's
     findings` and `docs(maintenance): remove findings resolved since the last pass`. On *open a PR*,
     `git push -u origin <branch>` and `gh pr create --base "$base_branch"` under a Conventional Commit
     title; on *commit only*, report the pass as **not landed**, naming the branch. Offer `git
     worktree remove`. On *don't commit*, write nothing.
   - **Per-lens cost rollup (§M7).** Read the panel's emitted `costByLens` array — one
     `{ lens, cost }` entry per lens plus a trailing `panel-overhead` row (the codex cross-model lens
     contributes an unpriced `0` row) — and append one `lens-cost` run record per entry:
     `run-record.mjs append --kind lens-cost --stage maintain --lens <slug> --cost <dollars> --run
     <runId>`. Maintenance emits **no** `workload` record, so its cost stays on doctor's
     workload-independent `## Cost by stage` / `### Cost by lens` tables only.

## Fan-out ceiling (binding)

A repo-wide multi-lens pass is the unbounded fan-out shape that has historically blown up spend, so:

- the existing per-lens delegation budget (`references/delegation.md`,
  ~30 tool calls / ~15 files) applies **per lens**;
- a global pass ceiling of **at most 5 concurrent panel lenses** and **at most 8 total LLM dispatches
  per pass** (≤5 lenses + 1 history inspector + 1 issue decompose/classify + 1 issue verification;
  the deterministic pre-pass and `issue-intake.mjs` fetch are bounded tool commands, not LLM lenses).
  This ceiling counts **orchestration** dispatches only: the review panel's own per-finding
  adversarial verify + reconcile are a **separately-governed sub-fan-out**, bounded by the panel's
  own concurrency limit (`VERIFY_CONCURRENCY` in `workflows/review-panel.js`), and are **not**
  counted against this pass ceiling;
- a **hard stop at the ≥20% context-depth band** `delegation.md` already defines
  (`node "${CLAUDE_PLUGIN_ROOT}/scripts/depth-probe.mjs"`); on a hard stop the coverage statement
  names the unswept remainder;
- every dispatch resolves its model per `${CLAUDE_PLUGIN_ROOT}/references/model-routing.md`; the
  history inspector routes to the fast tier.

## Boundaries

- Starts no cycle; creates, reads, or writes no `.devcycle/state.md`; emits no handoff block.
- Mutates no code and no GitHub issue, ever.
- Issue-folding is read-only: `gh issue list`/`view` only, never `close`/`comment`/`edit`/`label`.
- Ends at the ranked findings document, a **local** per-run report (`references/config.md` § Doc
  tracking, audit-report row = local at all depths) exactly as
  `playbooks/writing-the-findings-document.md` writes it.
- Writes the per-finding `docs/devcycle/maintenance-findings/` store only through step 8's CLI and
  only after its commit gate: on its own `chore/maintenance-findings-<date>` branch in a worktree,
  pushed as a PR only on the user's say — in the checkout only when doc tracking vetoes committing
  it; still no code or issue mutation.

Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.
