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
   Then mint this pass's run record:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/run-record.mjs" new --plugin-version <this plugin's plugin.json version> --plugin-sha <node "${CLAUDE_PLUGIN_ROOT}/scripts/self-dev-check.mjs" --plugin-digest> --profile <profile>`
   prints the `<runId>` every later `--run <runId>` names. Then, as its own Bash call:
   `run-record.mjs append --run <runId> --kind session --sessionId "$CLAUDE_CODE_SESSION_ID"`.
2. **Scoping gate (mandatory, before any dispatch).** Run `reviewing-code.md` § 1's criteria
   interview and resolve knobs — the batched AskUserQuestion gate, which also asks this pass's sweep
   consent per `${CLAUDE_PLUGIN_ROOT}/references/hygiene-sweeps.md` § Classes and consent. Hard STOP until the user
   replies, then record both answers:
   `run-record.mjs append --run <runId> --kind sweep-consent --consentExecuting true|false --consentCoverage true|false`.
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
   lint, the hygiene sweep — and hand the lenses those facts as evidence.
   The dead-code sweep runs first: `node "${CLAUDE_PLUGIN_ROOT}/scripts/hygiene-sweep.mjs" run --out .devcycle/maintain/sweep-<date>`
   writes candidate clusters and coverage rows — tooling facts like the others. Its contract is `${CLAUDE_PLUGIN_ROOT}/references/hygiene-sweeps.md`.
   Add `--consent-executing` and `--consent-coverage` for each step 2 yes. It runs at every depth,
   and a `<concern>` narrows the lens criteria, never the sweep. `<dir>` below is its `--out`.
   - **Verify the sweep.** One dispatch per `references/hygiene-sweeps.md` § Verification reads
     `<dir>/candidates.json`; save the verdicts array it returns as `<dir>/verdicts.json`. On the
     coverage yes, run the repo's documented test command with coverage, writing under `<dir>/`, and
     keep its lcov path for step 8; a failed run or a non-lcov report is named in the coverage
     statement instead.
   - **Plugin-only checks.** Only when `node "${CLAUDE_PLUGIN_ROOT}/scripts/self-dev-check.mjs" --is-source`
     prints `source`, also run the `duplication-check.mjs` pattern
     (`${CLAUDE_PLUGIN_ROOT}/scripts/duplication-check.mjs`), dead-export detection
     (`node "${CLAUDE_PLUGIN_ROOT}/scripts/dead-export-check.mjs"`) and cross-reference / broken-link
     checking (`node "${CLAUDE_PLUGIN_ROOT}/scripts/xref-check.mjs"`). They check devcycle's own
     layout, so any other repo skips them and the coverage statement says so. The dead-export and
     xref checks are **advisory**: their findings print to stdout as evidence and they exit 0 even
     with findings, so only a non-zero (`abort`) exit — the tool could not run — omits the fact. A
     `not covered:` line from dead-export detection goes into the coverage statement.

   Never spend an LLM lens re-deriving a tooling fact; a tool that is unreachable has its fact
   omitted and named in the coverage statement.
5. **History (thorough only).** Dispatch `devcycle:history-inspector` at the **fast tier** within its
   bounded traversal window (the smaller of the last 500 commits or 6 months, owned by the agent).
   Fold its churn/convergence signal into the Abstraction charter's historical-convergence input and
   keep its own findings.
6. **Depth-gated criteria → the engine.** Confirmed criteria = existing criteria always; **standard**
   adds **abstraction** — read `${CLAUDE_PLUGIN_ROOT}/references/abstraction-and-strengths.md` for
   its method; **thorough** additionally carries **history** evidence. Follow
   `${CLAUDE_PLUGIN_ROOT}/playbooks/reviewing-code.md` at `repo` scope — where `reviewDepth: auto` is `single`, with a note that `reviewDepth=panel` is available — handing it the confirmed
   criteria, the **hotspot file list** (which scopes its `--match … --files` call rather than the
   whole tree), and the **digest** (its optional orientation input). The engine owns the panel
   dispatch and dedup-and-rank; `playbooks/writing-the-findings-document.md` writes the ranked
   `docs/audits/` document.
   The lenses do not re-sweep step 4's ground: they get the verified clusters (`<dir>/candidates.json`
   with `<dir>/verdicts.json`) as tooling facts, not the **dead or unreachable code** criterion. A lens
   finding on a cluster's anchor merges by step 8's merge rule.
7. **GitHub issues as a second input source — read-only, all depths.** Unless the scoping gate
   excluded it, fold in the target repo's own open issues alongside the lens findings; this runs at
   every profile depth (lean, standard, thorough), since it is a separate input source, not a
   depth-gated lens. A `<concern>` argument narrows which fragments are in scope the same way it
   narrows lens criteria.
   Follow `${CLAUDE_PLUGIN_ROOT}/references/issue-folding.md` as its maintain caller, with these
   maintain-specific parts:
   - **Fetch.** Run
     `node "${CLAUDE_PLUGIN_ROOT}/scripts/issue-intake.mjs" --repo <owner/name> --scratch .devcycle/issue-intake/<pass>`,
     with no flag that keeps devcycle's own tracked issues in.
   - **Unavailable.** `available:false`, whatever the `reason` (including `count-mismatch` and
     `count-unavailable`), skips the rest of issue-folding and is named with its reason in the
     coverage statement.
   - **Report lines.** Record `counts.excludedCulprit` as a report line ("M devcycle-tracked culprit
     issues, handled by the promotions engine — not re-triaged here") and the dropped feature
     fragments as another ("N feature requests in the backlog, out of scope for maintenance").
   - **Merge.** Selecting a merged fragment still starts a separate `/devcycle:cycle` naming that
     finding; maintenance never touches the issue on GitHub.

8. **Persistence across passes (§M5) — after the ranked findings exist.** The engine (step 6) and
   issue-folding (step 7) produce the ranked findings; this step gives them cross-pass memory
   through one command, `node "${CLAUDE_PLUGIN_ROOT}/scripts/maintenance-findings.mjs" <verb>`, whose
   `apply-pass`, `dismiss` and `stranded` verbs are the store's only write path — never edit a
   record by hand. The store holds no issue records — `${CLAUDE_PLUGIN_ROOT}/CONTRIBUTING.md`
   § What belongs in `docs/` owns the defect-state split — so a folded issue's number stays on its
   `Origin:` line in the pass document.
   - **Fold in the sweep.** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/hygiene-sweep.mjs" finalize --dir <dir> --verdicts <dir>/verdicts.json --run <runId>`,
     adding `--lcov <file>` when step 4's coverage run produced one. `<dir>/section.md` becomes the
     findings document's **Dead code** section, and `<dir>/entries.json`'s entries join the pass file.
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
     failed, a hard stop fired, or the coverage statement names an unswept lens area, lens-kind
     resolution is refused and **Resolved since last pass** renders "not assessed: partial pass" for
     those kinds; a sweep gap is not one of these conditions. A sweep kind can resolve only when
     `<dir>/coverage.json` lists it in `fullKinds` (every source behind it ran in full). With no finalized sweep
     (failed or skipped verification, no `finalize`, earlier hard stop), pass no `--sweep-coverage`, say why
     in the coverage statement, and no sweep kind resolves. Re-run the dry run with the resolution flags
     (`--resolve` unless lens-kind resolution was refused, plus `--sweep-coverage <dir>/coverage.json`), show its `resolved`
     rows, and ask the user to confirm: the real `apply-pass` takes them only on a confirmed run, and
     a decline passes neither and renders "not assessed: declined". A resolved record is deleted, not written
     — a closed loop is not a longitudinal artifact, so the store never accumulates settled history, and a
     recurrence re-enters as new. `apply-pass` never runs a record's `verify:`, so every resolution is also in
     `gaps`: render them, so a moved-not-fixed finding stays visible.
   - **Offer dismissal.** A finding is `dismissed` only with a **load-bearing** reason — `dismiss --id
     <id> --reason "<text>"`, plus `--title` when the stored title is blank; a bare skip is not a
     dismissal. A dismissed finding is excluded from the next pass's ranked list and is
     **never auto-re-evaluated**; it stays dismissed until a human asks to reconsider it
     (`dismiss --id <id> --revoke`).
   - **Rank + report.** The findings document is ordered Impact → Severity → Priority, which
     `references/findings.md` § Ordering owns. The committed findings store's own order is
     unchanged: severity tier first (never lowered), then the trending signal, tie-broken
     confidence → passes → first-seen — the rule `scripts/maintenance-findings.mjs`'s
     `rankByTrending` implements and singly owns, named here rather than silently re-specified.
     Add three longitudinal sections to the findings
     document: **Previously known (persisting)**, **Resolved since last pass**, **Trending**. Every
     lifecycle transition rendered is backed by this pass's live re-detection (verify-before-stating,
     `references/evidence.md` § Authored claims), never a prior pass's wording.
   - **Commit gate.** Under a veto, ask nothing and cut no branch: run `apply-pass --root <checkout>`,
     with the confirmed dry run's resolution flags (`--resolve`, `--sweep-coverage`) exactly when the user confirmed it, and each accepted `dismiss` in the
     checkout, and leave the store uncommitted. Otherwise ask one question: *commit the store on
     `chore/maintenance-findings-<date>` and open a PR* · *commit only* · *don't commit*.
   - **Write and land.** On either commit answer, cut the branch per
     `${CLAUDE_PLUGIN_ROOT}/references/branch.md` § Committing's standalone-worktree rule:
     `git worktree add -b chore/maintenance-findings-<date> .devcycle/maintain/wt-<date> "$base"` (a
     taken name gets `-2`, `-3`, …). Run `apply-pass --root <worktree>` with the confirmed dry run's resolution flags, then each accepted
     `dismiss --root <worktree>`, then commit the `written` paths with `git add` and the `deleted`
     paths with `git rm` — two pathspec commits, `docs(maintenance): record the <date> pass's
     findings` and `docs(maintenance): remove findings resolved since the last pass`. On *open a PR*,
     `git push -u origin <branch>` and `gh pr create --base "$base_branch"` under a Conventional Commit
     title; on *commit only*, report the pass as **not landed**, naming the branch. Offer `git
     worktree remove`. On *don't commit*, write nothing.
   - **Per-lens cost rollup (§M7).** Read the panel's emitted `costByLens` array — one
     `{ lens, cost }` entry per lens plus a trailing `panel-overhead` row (the codex cross-model lens
     contributes an unpriced `0` row) — and append one `lens-cost` row per entry to step 1's run:
     `run-record.mjs append --kind lens-cost --stage maintain --lens <slug> --cost <dollars> --run
     <runId>`. Maintenance emits **no** `workload` record, so its cost stays on doctor's
     workload-independent `## Cost by stage` / `### Cost by lens` tables only.

## Fan-out ceiling (binding)

A repo-wide multi-lens pass is the unbounded fan-out shape that has historically blown up spend, so:

- the existing per-lens delegation budget (`references/delegation.md`,
  ~30 tool calls / ~15 files) applies **per lens**;
- a global pass ceiling of **at most 5 concurrent panel lenses** and **at most 9 total LLM dispatches
  per pass** (≤5 lenses + 1 history inspector + 1 issue decompose/classify + 1 issue verification
  + 1 sweep verification; the deterministic pre-pass, the sweep's `run` and `finalize`, and the
  `issue-intake.mjs` fetch are bounded tool commands, not LLM lenses). Every hygiene sweep shares the
  one sweep verification, so no later sweep raises this ceiling again.
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
