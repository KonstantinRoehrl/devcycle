# Repo maintenance audit — devcycle — 2026-08-23

**Branch:** dev
**SHA audited:** 87977760df74188a87439b99ab592532e1b001c7
**PR:** none (whole-repo `/devcycle:maintain` pass, not a branch review)
**Profile:** standard (existing criteria + Abstraction lens; no history-inspector traversal)
**Scope:** whole repository
**Criteria confirmed at the scoping gate:** docs-vs-reality drift & cross-reference consistency; duplication vs. reuse & token/context cost; Abstraction (standard-depth addition); architecture & separation of concerns / conformance to stated conventions; correctness/error-handling/test coverage in `scripts/`+`tests/`; security & dependency health. Accessibility: not applicable (no UI in this repo).
**GitHub issues folded in:** yes, per the confirmed scoping gate.

This is the **first pass** run against the persistence store the Phase 4 work (`playbooks/maintaining-the-repo.md` §M5, shipped in this same 0.16.0 release) introduces. `docs/devcycle/maintenance-findings/` held no prior records, so every finding below is new (`passes: 1`) and the three longitudinal sections below are empty by construction, not by omission.

## Previously known (persisting)

None — no prior maintenance-findings store existed before this pass.

## Resolved since last pass

None — no prior pass to resolve against.

## Trending

None — every finding below is new this pass.

## GitHub issues folded in

12 open issues fetched; 4 excluded as devcycle's own auto-filed `[culprit:...]` issues (handled by the promotions engine, not re-triaged here): #119, #118, #117, #112. 8 screened issues decomposed into 9 independently-verifiable claim fragments (issue #103 split into 2). **0 feature-request fragments** — every fragment classified `bug` or `refactor`. All 9 fragments were independently re-verified against current code (session-tier dispatch, each routed to the matching lens methodology); **all 9 came back `verified`** — none dropped as non-reproducing, none already fixed. They are folded into the ranked list below, tagged `Origin: github-issue #<n>`.

---

## Ranked findings

### High

#### 1. README.md and DESIGN.md still describe devcycle as "seven commands," omitting the shipped `/devcycle:maintain`
- **Severity:** high · **Confidence:** verified · **Origin:** lens (docs integrity) · **Finding-id:** `docs-drift:b897b96f`
- **Location(s):** `README.md:47`, `README.md:322-330` (command table), `README.md:18-24` (mermaid diagram), `DESIGN.md:63`, `DESIGN.md:334-337`, `DESIGN.md:260-276` (§8 Playbook Roadmap), `DESIGN.md:87-100` (§3 blueprint tree)
- **What's wrong:** README's "Where to start" mermaid diagram, its "Those seven commands are devcycle's entire surface" line, and its full command table list only `cycle`, `continue`, `review`, `verify`, `learn`, `doctor`, `onboard` — `/devcycle:maintain` is absent from all three. DESIGN.md's §3 blueprint tree, §8 roadmap table, and §13 naming section say the same "seven entry points."
- **Why it's wrong:** `commands/maintain.md` and `playbooks/maintaining-the-repo.md` both ship (confirmed present; `tests/fixtures/context-budget.json` prices the playbook). `docs/routing.md` correctly lists 8 rows including `maintain`. `CHANGELOG.md:7-12` documents `/devcycle:maintain` as an eighth command, shipped across four phases and released in this same 0.16.0. No `docs/DECISIONS.md` entry records updating README/DESIGN for it — the update was simply missed, even though a documented precedent (the 2026-08-06 collapse-to-seven decision) explicitly calls out README's Machinery table as something a command-surface change touches.
- **Measured against:** repo convention — `quality-criteria.md`'s docs-vs-reality-drift criterion; `docs/routing.md`'s own statement that it is the single owner of the user-facing surface.
- **Category:** Documentation integrity. **Impact:** README is the first surface a user reads to discover the plugin; a shipped, user-invocable command is invisible there, and DESIGN.md asserts a stale invariant a reader would take as authoritative. **Complexity:** S. **Impact if unaddressed:** no README-driven discovery path for `/devcycle:maintain`; a future ninth command risks the same drift since DESIGN.md's self-description is already wrong.
- **How to verify/reproduce:** `grep -n "maintain" README.md` → only in an unrelated agent-table row, never the command table/diagram; `grep -n "seven" DESIGN.md README.md` → 3 stale assertions.
- **Suggested fix:** add a `MAINTAIN` node to README's mermaid diagram and a row to its command table; update "seven" → "eight" (or de-number) in both files' §3/§8/§13 and Machinery table.
- **Effort estimate:** ~5 small edits across 2 files, well under an hour.

#### 2. Task-reviewer dispatch contract's findings-file requirement is routinely skipped
- **Severity:** high · **Confidence:** verified · **Origin:** github-issue #107
- **Location(s):** `references/delegation.md:130-153`, `agents/task-reviewer.md:57-64`, `playbooks/executing-waves.md` step 5
- **What's wrong:** `delegation.md` defines the task-reviewer's return envelope as paths/counts only — `findings:` is `.devcycle/findings/<task-id>-round-<n>.md | none`, never content. But `task-reviewer.md` and `executing-waves.md` step 5 both instruct "the coordinator writes what that envelope returns" to the findings file — a mechanism the envelope schema cannot support, since it never carries verdict content. In C4, three of four reviewers satisfied only the envelope; the coordinator had to hand-transcribe findings from envelope text after the fact, each explicitly marked second-hand.
- **Why it's wrong:** the findings file is the durable record `references/resume.md`'s "files are the state, the conversation is a cache" model depends on; an envelope-only return is lost across a `/clear`, so a reviewer that skips the file produces a finding a resumed session can't see.
- **Measured against:** `references/resume.md`'s file-based state model; the task-reviewer's own dispatch contract in `references/delegation.md`.
- **Category:** Pipeline reliability. **Impact:** repo-wide — every wave's per-task review is exposed to this gap. **Complexity:** M. **Impact if unaddressed:** review findings keep silently dropping across resume boundaries.
- **Suggested fix:** either enforce the findings-file write as part of the reviewer's exit contract (coordinator-side check before accepting the return — no file, no accepted verdict), or fold the envelope's content into the file automatically.
- **Effort estimate:** M — touches the dispatch contract and the coordinator's accept-return step.

#### 3. Wave planning enforces file disjointness but not content coupling
- **Severity:** high · **Confidence:** verified · **Origin:** github-issue #106
- **Location(s):** `scripts/wave-disjointness-check.mjs:5-8`, `playbooks/planning-waves.md:146-148`
- **What's wrong:** both files explicitly state the check "only catches a literal Files-block overlap... not the harder case of two tasks coupled only by editing the same shared resource's prose or assertions." No other check or gate anywhere in `planning-waves.md`'s self-review list covers this class.
- **Why it's wrong:** C6 dispatched five file-disjoint wave-2 tasks; two were content-coupled anyway (one wrote a rule reading another's table values), producing a real high-severity defect neither implementer could see, caught only at branch-review round 2 and requiring two more rounds to close — exactly the failure mode the wave-planning apparatus exists to prevent.
- **Measured against:** the wave-disjointness apparatus's own stated purpose.
- **Category:** Pipeline reliability. **Impact:** repo-wide — any multi-task wave is exposed. **Complexity:** M. **Impact if unaddressed:** repeat of C6's failure mode, caught only late in branch review at the cost of extra rounds.
- **Suggested fix:** `planning-waves.md`'s dispatch-map step flags (for human confirmation) any same-wave task pair where one brief references a file/table/interface another same-wave brief edits, even when literal file sets are disjoint.
- **Effort estimate:** M.

#### 4. `redaction-check.mjs`'s finish-stage gate can't pass on legitimate `.devcycle` content
- **Severity:** high · **Confidence:** verified · **Origin:** github-issue #105
- **Location(s):** `scripts/redaction-check.mjs` `PATTERNS` array (home-directory-path and session-id patterns), `playbooks/finishing-the-cycle.md:50-56`
- **What's wrong:** the home-path pattern matches any `/Users/<name>/...` span and the session-id pattern matches any UUID-shaped string, with no allowlist for `state.md`'s own mandated `root:` field or devcycle's own dream-observation UUID filenames. A real run produced 341 findings / exit 1, the large majority false positives on gitignored, local-only evidence — while `finishing-the-cycle.md` still runs this as a hard, non-optional gate.
- **Why it's wrong:** a required gate that, as built, cannot pass on content produced by devcycle's own routine operation defeats its purpose while still blocking every finish stage; not touched by the most recent commit on the file (flag-parsing hardening only).
- **Measured against:** the gate's own stated purpose in `finishing-the-cycle.md`.
- **Category:** Pipeline reliability / correctness. **Impact:** blocks every finish stage until routed around by hand. **Complexity:** M. **Impact if unaddressed:** the gate supplies no real signal and gets routed around every time, training operators to ignore it.
- **Suggested fix:** narrow the patterns — exempt `state.md`'s required fields, drop or re-anchor the bare-UUID pattern (or exempt `dreaming/observations/*.json`), or make the local `.devcycle` screen advisory rather than a hard stop (nothing it scans is about to be pushed anywhere).
- **Effort estimate:** M.

### Medium

#### 5. The release PR's own CI checks (`pr-title`, `commit-convention`) sit in GitHub's approval-required state and may never run
- **Severity:** medium · **Confidence:** verified · **Origin:** lens (security/dependency health) · **Finding-id:** `ci-gate-gap:6fd5435a`
- **Location(s):** `.github/workflows/prepare-release.yml:121-152` (`open-pr` job, `GH_TOKEN: ${{ github.token }}`), `.github/workflows/validate.yml:3-4,74-113`
- **What's wrong:** the release PR (`main`←`dev`) is opened via `gh pr create` with the implicit `GITHUB_TOKEN`. Per GitHub's documented behavior, a `pull_request opened` event from `GITHUB_TOKEN` creates a workflow run in **approval-required** state — a human must click "Approve workflows to run" before `pr-title`/`commit-convention` execute. Nothing in this repo automates or surfaces that approval, and `main` carries no branch protection (confirmed live via the GitHub API), so nothing else compensates.
- **Why it's wrong:** CONTRIBUTING.md states "CI checks both" title and commit-subject conventions as the release path's merge gate; for the one PR that most needs it, the gate doesn't fire automatically.
- **Measured against:** CONTRIBUTING.md § Releasing; GitHub Docs on `GITHUB_TOKEN` workflow-approval behavior.
- **Category:** CI / release-path hardening. **Impact:** bounded to the release path; `bump-version.mjs` and `prepare-release.yml`'s own re-run of `validate` already backstop most of this — the residual gap is a human retitling the PR before merge with nothing to re-check it. **Complexity:** S. **Impact if unaddressed:** a retitled/malformed release-PR merge could ship with no automated title check.
- **Suggested fix:** document the approval-required banner in CONTRIBUTING.md's Releasing section, and/or have `open-pr`'s PR body remind the merger to approve pending workflow runs; a structural fix (re-running the title check from the same-token job that opens the PR) closes the gap entirely.
- **Effort estimate:** S (documentation) to S/M (structural fix).

#### 6. Ledger and state timestamps are estimated, not measured, and `references/ledger.md` never documents that they must be
- **Severity:** medium · **Confidence:** verified · **Origin:** github-issue #103
- **Location(s):** `references/ledger.md:25`, `.devcycle/ledger.md`, `.devcycle/state.md`, `scripts/run-record.mjs`
- **What's wrong:** `ledger.md` specifies the `- [<ISO-8601 UTC>] ...` line shape but nowhere states the value must come from the system clock at write time. Measured drift of +3h30m and −1h51m was observed in two concurrent cycles' files at the same real moment. No script mechanically stamps ledger/state.md timestamps — unlike `run-record.mjs`'s own lines, which do use `new Date().toISOString()`.
- **Why it's wrong:** every duration derived from a ledger is fiction where estimated; it corrupts `doctor.mjs`'s cost/depth attribution (the same `$/turn` trend devcycle uses to make its own optimization decisions) and defeats `resume.md`'s "re-derive position from the ledger" ordering guarantee.
- **Measured against:** `references/ledger.md`'s own (silent) spec; `run-record.mjs`'s own correct pattern.
- **Category:** Correctness / observability. **Impact:** repo-wide — every ledger-derived duration and doctor.mjs cost attribution. **Complexity:** M. **Impact if unaddressed:** the $/turn trend devcycle optimizes against keeps being built on fiction.
- **Suggested fix:** route every ledger/state timestamp write through a script that stamps the time itself (mirroring `run-record.mjs`), or at minimum state explicitly that the value must be the literal `date -u +%Y-%m-%dT%H:%M:%SZ` output at write time, with a monotonicity gate against the run record. Past entries not rewritten.
- **Effort estimate:** M.

#### 7. A worktree cycle's run record splits across two repo slugs
- **Severity:** medium · **Confidence:** verified · **Origin:** github-issue #104
- **Location(s):** `scripts/run-record.mjs:124-127` (`gitToplevel`), consumed by `repoSlug` and `recordPath`
- **What's wrong:** `git rev-parse --show-toplevel` resolves to a linked worktree's own path, not the main checkout's, inside a worktree. Confirmed unchanged via `git blame` since 2026-08-12 — never touched by later hardening passes.
- **Why it's wrong:** a run whose appends happen from inside a worktree writes to a different slug directory than appends from the main checkout for the *same* run, so `doctor.mjs`'s per-repo cost/depth attribution under-reports for worktree cycles; already hand-worked-around twice (C4, C6) because nothing enforces the fix.
- **Measured against:** `doctor.mjs`'s per-repo-slug attribution model.
- **Category:** Correctness / observability. **Impact:** every worktree-run cycle's cost/depth data. **Complexity:** S. **Impact if unaddressed:** the manual workaround keeps needing to be rediscovered every cycle.
- **Suggested fix:** resolve the *main* repo's toplevel regardless of worktree — `git rev-parse --git-common-dir`'s parent, or `git worktree list --porcelain`'s first entry.
- **Effort estimate:** S.

#### 8. A tmpdir failure in `runCrossModelLens` aborts the whole stage-1 fan-out instead of degrading gracefully
- **Severity:** medium · **Confidence:** verified · **Origin:** github-issue #90
- **Location(s):** `workflows/review-panel.js:332` (`mkdtempSync`, above the `try` at line 334)
- **What's wrong:** every other failure path inside the `try` (spawn error, timeout, missing JSON, parse error) degrades to `{findings: [], note: ...}`, but a `mkdtempSync` throw is uncaught, propagating through `mapLimit`'s `Promise.all` to `main().catch(fatal)` → `process.exit(1)`, discarding every lens result already collected in that batch and orphaning sibling subprocesses.
- **Why it's wrong:** contradicts the function's own documented contract ("if codex is unavailable... the lens is skipped with a note... the panel itself still succeeds").
- **Measured against:** the function's own header comment and exit-code contract.
- **Category:** Correctness / error handling. **Impact:** a narrow-trigger edge case (tmpdir exhaustion/permissions/EMFILE) that aborts a whole batch when it fires. **Complexity:** S. **Impact if unaddressed:** low-probability but total loss of an in-progress panel run.
- **Suggested fix:** move `mkdtempSync` inside the `try`; also check whether `mapLimit` should isolate a rejecting job rather than aborting the whole fan-out.
- **Effort estimate:** S.

#### 9. `diffStats()` never checks the exit status of its two `git diff` calls
- **Severity:** medium · **Confidence:** verified · **Origin:** lens (tooling correctness) · **Finding-id:** `runtime-defect:4b073a03`
- **Location(s):** `scripts/run-record.mjs:131-148`
- **What's wrong:** `diffStats(base, cwd)` runs two `git diff` `spawnSync` calls and unconditionally parses `stdout` without ever inspecting `.status`. An invalid/unreachable `base` makes both calls exit 128 with empty stdout — silently returned as an all-zero, schema-valid "no changes" result.
- **Why it's wrong:** the sibling function three lines above, `gitToplevel`, *does* check `status === 0` — `diffStats` breaks the codebase's own established pattern for this exact idiom, and the function's own doc comment says it exists specifically so "a workload line always reflects what actually landed... never a self-reported count." A silently-zeroed record on git failure is exactly that.
- **Measured against:** `run-record.mjs`'s own `gitToplevel` pattern and `diffStats`'s own doc comment.
- **Category:** Correctness / error handling. **Impact:** every future invocation with a bad `--base` pollutes the append-only run-record store (feeding `doctor.mjs`'s cost/workload trend) with a misleading zero-diff data point, invisible to any consumer. **Complexity:** S. **Impact if unaddressed:** silently corrupted analytics with no diagnostic anywhere.
- **How to verify/reproduce:** `node -e 'const {diffStats}=await import("./scripts/run-record.mjs"); console.log(diffStats("deadbeef", process.cwd()))'` → all-zero stats, exit 0, despite the underlying `git diff` failing with status 128.
- **Suggested fix:** check `num.status`/`status.status` (mirroring `gitToplevel`) and `die()` or propagate an explicit error marker rather than falling through to zeroed stats.
- **Effort estimate:** S — plus one new test in `tests/unit/run-record.test.mjs` using an invalid `--base`.

#### 10. `defaultRunCheck` misclassifies a directory `verify:` target as a shell command
- **Severity:** medium · **Confidence:** verified · **Origin:** lens (tooling correctness) · **Finding-id:** `runtime-defect:77833114`
- **Location(s):** `scripts/verification.mjs:54,78`
- **What's wrong:** `existsSafe(target)` probes existence via `readFileSync`, treating any thrown error (including a directory's `EISDIR`) as "does not exist." `isCommand = verifyVal.includes(" ") || !existsSafe(target)` then classifies a bare directory name as a shell command, runs it via `/bin/sh -c "<dirname>"`, which fails to execute, yielding verdict `broken` instead of `unmeasurable`.
- **Why it's wrong:** the function's own comment says a check that "cannot verify" must map to `unmeasurable`, never a stat-only `held`/`broken` — the directory case reaches the same bug the comment says was deliberately avoided, through the untested path.
- **Measured against:** the function's own documented contract.
- **Category:** Correctness / error handling. **Impact:** no current promotion record names a directory `verify:` value, so today's blast radius is latent; a future one would silently report as a regressed/broken fix rather than unmeasurable, misdirecting debugging effort. **Complexity:** S. **Impact if unaddressed:** confusing false-"broken" verdicts whenever this shape of `verify:` value is authored.
- **How to verify/reproduce:** `defaultRunCheck("somecheck", {root})` where `somecheck` is a directory → `{status: "failed"}` instead of `unrunnable`.
- **Suggested fix:** replace `existsSafe`'s `readFileSync` probe with `existsSync(target) && statSync(target).isFile()`.
- **Effort estimate:** S — plus a new test case in `tests/unit/verification.test.mjs`.

#### 11. `commands/maintain.md`'s own body text still frames the command as "Phase 1," describing already-shipped Phase 2-4 capability as future work
- **Severity:** medium · **Confidence:** verified · **Origin:** lens (docs integrity) · **Finding-id:** `stale-phase-description:5342cfb0`
- **Location(s):** `commands/maintain.md:7-10`
- **What's wrong:** the description says the cross-pass memory and longitudinal lenses "arrive in a later phase," but `playbooks/maintaining-the-repo.md` — the playbook this same file hands off to two lines later — already implements exactly that: a history-inspector dispatch, an abstraction lens, and the cross-pass persistence mechanism this very report used.
- **Why it's wrong:** `CHANGELOG.md:14-22` confirms Phases 2-4 landed and released in this same 0.16.0; the command's self-description describes a past state as still pending.
- **Measured against:** `quality-criteria.md`'s docs-vs-reality-drift criterion; `CONTRIBUTING.md`'s one-owner-per-concept principle (this note duplicates, poorly, what CHANGELOG.md already tracks accurately).
- **Category:** Documentation integrity. **Impact:** localized but user-visible — actively misleads about the command's current capability. **Complexity:** S. **Impact if unaddressed:** the phase language keeps aging with no natural end.
- **Suggested fix:** replace with a plain statement of current behavior, or drop the phase framing now that all four phases are complete.
- **Effort estimate:** S — one-sentence edit.

#### 12. Only one of six third-party-action pin sites is guarded by a full-commit-SHA-format test
- **Severity:** medium · **Confidence:** verified · **Origin:** lens (security/dependency health) · **Finding-id:** `test-coverage-gap:b894b390`
- **Location(s):** `tests/unit/workflows.test.mjs:106-115` (the only SHA-format assertion, scoped to `bump-version.yml`'s checkout step only); unguarded: `validate.yml` (2× checkout, 1× setup-node), `prepare-release.yml` (checkout, setup-node), `back-merge.yml` (checkout), `bump-version.yml` (setup-node)
- **What's wrong:** all six sites *are* correctly pinned today (independently verified against `actions/checkout`/`actions/setup-node`'s real tag SHAs via the GitHub API), but 5 of 6 have no automated defense against a future regression to a floating ref.
- **Why it's wrong:** the user's own CLAUDE.md states, as a hard rule, "pin every third-party action to a full commit SHA with the version as a trailing comment"; a prior planning artifact in this repo's own history specified exactly this repo-wide sweep test and it was never implemented — only the one narrow assertion exists.
- **Measured against:** the user's global CLAUDE.md § CI hardening defaults; this repo's own precedent pattern (`validate.mjs` check 21, `golden-path.test.mjs`'s workflow-directory walk).
- **Category:** Testing coverage / CI hardening. **Impact:** repo-wide if a regression ever lands — `validate.yml` (runs on every PR) is the highest-value target and has zero coverage today. **Complexity:** S. **Impact if unaddressed:** a weakened pin could land and nothing in CI would object.
- **How to verify/reproduce:** temporarily edit `validate.yml`'s checkout pin to `actions/checkout@v7` and run the full test suite — it stays green.
- **Suggested fix:** generalize `workflows.test.mjs:106-115`'s regex into a repo-wide loop over `.github/workflows/*.yml`, mirroring `validate.mjs` check 21 / `golden-path.test.mjs`'s existing pattern.
- **Effort estimate:** S.

### Low

#### 13. `references/findings.md` cites a non-existent "§M10" section in the maintain playbook
- **Severity:** low · **Confidence:** verified · **Origin:** lens (architecture/conformance) · **Finding-id:** `broken-cross-reference:8f229fea`
- **Location(s):** `references/findings.md:42`
- **What's wrong:** the `Origin` field's provenance rule cites "`/devcycle:maintain` §M10." No such section exists — `maintaining-the-repo.md`'s only labeled sections are §M5 and §M7; the GitHub-issues step (which actually sets `Origin: github-issue #<n>`) carries no `§M` label.
- **Why it's wrong:** `git log -p -S "M10"` shows the number was carried over from the local, gitignored planning brief's own numbering (`cycle-input-maintain-v9.md §M10`), not the shipped playbook — an instance of docs-vs-reality drift in the citation discipline `CONTRIBUTING.md`'s one-owner rule depends on.
- **Measured against:** `CONTRIBUTING.md` § One owner per concept; `quality-criteria.md`'s docs-vs-reality-drift criterion.
- **Category:** Documentation integrity. **Impact:** low — the rule is correctly implemented, just uncited. **Complexity:** S. **Impact if unaddressed:** a future restructure of the GitHub-issues step has no live anchor pulling findings.md along.
- **Suggested fix:** label the GitHub-issues step `(§M10)` for consistency with its siblings, or change the citation to a text anchor.
- **Effort estimate:** S.

#### 14. `commands/maintain.md` restates `review.md`'s owned `$ARGUMENTS` grammar rule instead of only pointing to it
- **Severity:** low · **Confidence:** verified · **Origin:** lens (architecture/conformance) · **Finding-id:** `restated-content:53a3dbe3`
- **Location(s):** `commands/maintain.md:16-20`, restating `commands/review.md:19-24`
- **What's wrong:** maintain.md says it "reuses the grammar review.md owns," then restates its substance almost verbatim — including a "even in a repo that has a branch by that name" clause addressing an ambiguity maintain's own grammar (no `branch:` token) doesn't have.
- **Why it's wrong:** `CONTRIBUTING.md`'s one-owner-per-concept rule: "adding a pointer next to a retained copy is worse than either alone." `duplication-check.mjs` reports `ok` here only because the restated clause sits inside a larger, partly-original paragraph, diluting its per-paragraph score below threshold.
- **Measured against:** `CONTRIBUTING.md` § One owner per concept.
- **Category:** Documentation integrity / duplication. **Impact:** cosmetic today; review.md remains the real owner. **Complexity:** S. **Impact if unaddressed:** the two copies can silently diverge if review.md's rule is ever refined.
- **Suggested fix:** trim to a pointer plus only the new content ("maintain has no branch scope").
- **Effort estimate:** S.

#### 15. `workflows/lib/` is the repo's sole `lib/` subdirectory; no rationale or convention is recorded
- **Severity:** low · **Confidence:** verified · **Origin:** github-issue #91
- **Location(s):** `workflows/lib/agent-cli.js`; `scripts/` (28 files, fully flat, confirmed via `find scripts -type d`)
- **What's wrong:** the module sits one level deeper than the repo's established flat-directory precedent, with no rationale recorded anywhere (`DESIGN.md`'s tree diagram lists it with only a functional comment; `docs/DECISIONS.md`/`CONTRIBUTING.md` have no layout-convention entry).
- **Why it's wrong:** defensible (a `lib/` does mark "shared, not an entry point," which matters more where every sibling file *is* an entry point) but establishes a one-off layout pattern nothing records either way.
- **Measured against:** `quality-criteria.md`'s conformance-to-stated-conventions criterion.
- **Category:** Architecture conformance. **Impact:** nothing functionally broken. **Complexity:** S. **Impact if unaddressed:** the next shared module's placement is decided ad hoc rather than by a recorded convention.
- **Suggested fix:** decide and record it either way — keep `lib/` and state the convention, or flatten to match `scripts/`.
- **Effort estimate:** S.

#### 16. The stage-1 concurrency-cap test infers peak via wall-clock markers and can false-pass under CI contention
- **Severity:** low · **Confidence:** verified · **Origin:** github-issue #89
- **Location(s):** `tests/unit/review-panel.test.mjs:516-556`
- **What's wrong:** peak concurrent lens subprocesses is inferred from a fixed 150ms `Atomics.wait` sleep and event-log ordering; under `node --test tests/unit/*.test.mjs`'s full-suite contention with other `Atomics.wait`-based tests (e.g. `agent-cli.test.mjs`), spawn/startup for later jobs can exceed the window even in the unbounded case the test exists to catch.
- **Why it's wrong:** `CONTRIBUTING.md` asserts tests under `tests/` are deterministic; this is the dangerous failure direction — a false pass that hides a regression, not a flaky failure that gets investigated. Carried deliberately (per the issue's own account) rather than fixed when the cap itself shipped.
- **Measured against:** `CONTRIBUTING.md`'s determinism claim.
- **Category:** Test quality. **Impact:** a regression-guard test that may not guard. **Complexity:** S. **Impact if unaddressed:** a future cap regression could ship undetected.
- **Suggested fix:** replace wall-clock inference with a deterministic synchronization primitive — each fake process signals entry and blocks until released.
- **Effort estimate:** S.

#### 17. The plugin's one declared dependency (`superpowers`) carries no version constraint
- **Severity:** low · **Confidence:** verified · **Origin:** lens (security/dependency health) · **Finding-id:** `unpinned-dependency:5cacc303`
- **Location(s):** `.claude-plugin/plugin.json:12-17`
- **What's wrong:** no `version` field; Claude Code's own docs state an unpinned dependency "tracks the latest available version... an upstream release can change the dependency under your plugin without warning."
- **Refutation attempted:** a version constraint can't currently be added — Claude Code resolves constraints against `{plugin-name}--v{version}`-format tags, and `obra/superpowers` has no such tags (only bare `v6.3.0`-style ones), confirmed via the GitHub API; the marketplace's own SHA pin is today's de facto lock but sits outside devcycle's manifest.
- **Measured against:** Claude Code Docs, Constrain plugin dependency versions.
- **Category:** Dependency health. **Impact:** low today (deterministic SHA pin), unbounded going forward. **Complexity:** S to document; the real fix is blocked upstream. **Impact if unaddressed:** a future `superpowers` release could silently break a devcycle playbook that names a `superpowers:*` skill, with no compatibility signal anywhere.
- **Suggested fix:** record this explicitly as a known, monitored tradeoff (e.g. `docs/known-issues.md`); revisit once/if upstream adopts the constrainable tag format.
- **Effort estimate:** S.

#### 18. The same "`- key: value`" markdown-field-line parser is independently reimplemented three times, and has already drifted in edge-case behavior
- **Severity:** low · **Confidence:** verified · **Origin:** lens (abstraction) · **Finding-id:** `unrecorded-duplication:581e1153`
- **Location(s):** `scripts/dream.mjs:138-141` (local, unexported), `scripts/promotions.mjs:10-13` (exported, explicitly commented as "verbatim from dream.mjs" — the author knew), `scripts/resume-check.mjs:46-49` (a genuinely different regex)
- **What's wrong:** `dream.mjs` and `promotions.mjs` are byte-identical (`^- ${key}:[ \t]*(.*)$`); `resume-check.mjs`'s (`^- ${name}:\s*(.+?)\s*$`) already behaves differently on an empty value (no match vs. matches `""`).
- **Why it's wrong (H1/H2, CONSOLIDATE direction):** nothing about either script's domain requires its own copy — both are pure string parsing. A regex fix today has to be found and applied in up to three places, and one copy has already silently diverged, which is the exact failure a shared module would prevent.
- **Measured against:** `quality-criteria.md` § Abstraction (CONSOLIDATE outcome) / duplication vs. reuse.
- **Category:** Abstraction (missing consolidation). **Impact:** low today; latent correctness risk if either script starts handling a legitimately-empty field. **Complexity:** trivial. **Impact if unaddressed:** a future field-parsing rule change applied to only one or two of three copies.
- **Suggested fix:** have `dream.mjs` and `resume-check.mjs` both import `promotions.mjs`'s `field` (no import-cycle risk either direction), settle on its behavior as canonical, delete the other two copies.
- **Effort estimate:** S (~30-45 min, plus running `dream.test.mjs`/`resume-check.test.mjs`).

#### 19. `commands/doctor.md` states report-column detail its own owning playbook never states (suspected)
- **Severity:** low · **Confidence:** suspected · **Origin:** lens (architecture/conformance) · **Finding-id:** `leaked-responsibility:2f408b8b`
- **Location(s):** `commands/doctor.md:18-20`
- **What's wrong:** names specific report-rendering detail (`$/main-turn`, `$/sub-turn`, turns-per-task columns) that `playbooks/profiling-sessions.md` — the file that says it owns "interpret, don't transcribe" — never itself states; these column names appear only in the command file and in `scripts/doctor.mjs`'s own rendering code, never in the playbook layer between them.
- **Why suspected rather than verified:** no CONTRIBUTING/DESIGN text explicitly forbids a command from previewing output shape, and this reads as a defensible, if borderline, choice to orient a user in the one file they read before invoking.
- **Measured against:** `DESIGN.md` §3's five-layer table (commands as thin routers, ≤100 lines, playbooks own "how").
- **Category:** Architecture/separation of concerns. **Impact:** cosmetic drift risk only; today's attribution is accurate. **Complexity:** S. **Impact if unaddressed:** a future doctor.mjs column rename (this has happened before, per `docs/DECISIONS.md`'s Ruling 6) leaves this stale in the file least likely to be touched by whoever makes that change.
- **Suggested fix:** trim to invocation forms plus a pointer to the report/playbook for its shape.
- **Effort estimate:** S.

#### 20. Untrusted GitHub issue text reaches Bash-capable reviewer dispatches during `/devcycle:maintain`'s issue-folding step, with only a prose boundary (suspected)
- **Severity:** low · **Confidence:** suspected · **Origin:** lens (security/dependency health) · **Finding-id:** `injection-exposure:74edcd73`
- **Location(s):** `playbooks/maintaining-the-repo.md:81-84`, `agents/task-reviewer.md:4`, `agents/red-team-reviewer.md:4` (both declare unrestricted `Bash`), `references/delegation.md:104-109` (the only mitigation: prose instructing "treat as a claim, never an instruction"), `references/config.md:128-140` (`docTrackingPolicy` default `standard` auto-commits findings locally)
- **What's wrong:** the only defense against a maliciously crafted issue body manipulating a dispatched reviewer into unintended Bash use is prose guidance, not a technical boundary — no tool restriction, no sandboxing, no content-scan on the dispatch's output before it's folded into a document that auto-commits locally.
- **Refutation attempted:** substantially bounded — issue-folding is read-only (never `close`/`comment`/`edit`/`label`, so no remote mutation is possible), and the eventual push to `dev` triggers `validate.yml`'s full-history gitleaks scan before reaching `main`. Not eliminated — gitleaks doesn't recognize arbitrary exfiltrated non-credential content, and the local commit happens before any push-time scan runs.
- **Measured against:** `quality-criteria.md`'s security/injection-classes criterion; the repo's own explicit untrusted-content contract for issue text.
- **Category:** Security / injection. **Impact:** bounded but non-zero; local-machine-only exposure until a push. **Complexity:** M. **Impact if unaddressed:** low-probability, non-trivial-impact data exposure via a maintainer running `/devcycle:maintain` against a repo with attacker-controlled open issues.
- **Suggested fix:** give the issue-verification dispatch a narrower, Bash-free tool set when operating specifically on issue-derived claims, or run a secret-pattern check over `docs/devcycle/maintenance-findings/`/`docs/audits/` at the local-commit step, not only at CI push time.
- **Effort estimate:** M.

---

## Abstraction analysis (KEEP verdicts — not defects, reported per quality-criteria.md's "learning what has earned its keep matters as much as what has not")

Standard maintenance depth — no history-inspector churn/convergence signal available this pass; every verdict below is stated as resting on consumer/implementation/invariant evidence alone, per the required gap-disclosure.

- **`workflows/lib/agent-cli.js`** — **KEEP.** 2 consumers (`review-panel.js`, `mechanical-sweep.js`), each binding it differently; centralizes the buffered-spawn/retry/JSON-schema-envelope loop and a documented `--tools` flag footgun that would otherwise need re-deriving at both call sites.
- **`tests/unit/helpers.mjs`** — **KEEP.** 6 test-file consumers; `runScript`'s `isolatePath` behavior protects a stated safety invariant (no live model call slipping into a keyless test suite) that inlining would force each test author to re-derive independently.
- **`scripts/run-record.mjs`** — **KEEP.** 3 module consumers + 5 playbook/command CLI-subprocess sites; centralizes schema enforcement shared between CI's check and every real append, plus a session-id hashing invariant `journal.mjs`/`lessons.mjs` both depend on getting identically right.
- **`scripts/promotions.mjs`** — **KEEP.** 4 module consumers; documented as extracted specifically to avoid an import cycle between `doctor.mjs` and `dream.mjs` (independently confirmed against the actual import graph) — a case of the module pointing dependencies the right way.
- **`scripts/lessons.mjs`** — **KEEP.** 2 module consumers, one of which (`maintenance-findings.mjs`) explicitly reuses `fileMatchesGlob` rather than reimplementing it; the eviction-order policy's complexity is intrinsic to the policy, not the wrapper.

One abstraction-lens finding was a defect (CONSOLIDATE, not KEEP) and is ranked above as finding #18.

---

## Coverage statement

**Deterministic pre-pass (all green):** `node scripts/validate.mjs` → ok; `node scripts/duplication-check.mjs` → ok (571 paragraphs, 45 files); `node scripts/redaction-check.mjs` → ok; `node --test tests/unit/*.test.mjs` → 1228/1228 passing, 0 failures.

**Omitted facts, named per the pre-pass discipline:** no `package.json`/npm dependency manifest exists anywhere in the repo, so a conventional dependency audit does not apply — dependency health was scoped to the repo's pinned GitHub Actions and its one declared plugin dependency (both covered above). No dedicated dead-export-detection or markdown broken-link-check tool exists in this repo's own tooling; neither ran, and no finding above rests on either having run.

**Graph orientation:** a graphify graph was available (`graphify-out/`, last built 2026-08-22, one day stale relative to this pass — judged not stale enough to abandon) and was used for orientation (repo digest + hotspot file list) rather than a whole-tree re-read.

**Fan-out:** 5 concurrent panel lenses (docs-integrity/cost, abstraction, architecture/conformance, tooling correctness, security/dependency health) + 1 issue decompose/classify dispatch + 1 issue verification dispatch = 7 LLM dispatches, at the profile's binding ceiling (no history-inspector dispatch at standard depth). One additional read-only orientation/Research dispatch ran outside that count. No hard stop was hit on the ≥20% context-depth band.

**Read depth per lens** (each lens's own coverage note, condensed): the docs-integrity lens read `DESIGN.md`, `CONTRIBUTING.md`, and most of its 17-file hotspot list in full; `docs/DECISIONS.md` (1051 lines) and `scripts/doctor.mjs`'s back two-thirds were grepped/sampled rather than read cover-to-cover, budget-gated once two verified findings were established. The abstraction lens ran the deletion test on all 8 focus files without skipping any. The architecture/conformance lens read all 10 focus files in full plus `docs/DECISIONS.md`'s newest 786 of 1052 lines (the older ~266 lines, pre-2026-07-26, were not read). The tooling-correctness lens read all 10 focus files plus `run-record.mjs` in full; `doctor.mjs` and `validate.mjs` (3046 and 881 lines) were grepped for anti-patterns only, not read cover-to-cover — a full correctness pass over those two large files is the clearest follow-up gap this pass leaves. The security/dependency lens read all 7 focus files plus `back-merge.yml` (added on its own initiative) in full, and made live API/hash checks rather than relying on static reading alone.

**Persistence:** this is the first pass against `docs/devcycle/maintenance-findings/` (Phase 4, shipped in this same 0.16.0 release) — no prior store existed, so `verifyMaintenance` had nothing to compare against and every finding above was written as new (`passes: 1`). 20 records committed: 12 lens-sourced `maintenance-finding` records, 8 `github-issue` records. Per-lens cost rolled up to run-record `lens-cost` lines (run `0aea2068308797be`) — figures are a blended-rate token-count estimate (session-tier Sonnet-5 pricing, assumed ~90/10 input/output split), not exact billing; stated as an estimate rather than false precision.

**No dismissals this pass** — dismissal is a human call per the persistence design, and none was requested.
