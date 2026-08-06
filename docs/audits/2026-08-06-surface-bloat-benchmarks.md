# Audit — devcycle surface, bloat, benchmarks (2026-08-06)

## Provenance

- **Audited:** branch `dev` at sha `3b31ad1` (full-codebase mode; working tree identical to
  the `dev` tip at audit start).
- **Findings land on:** topic branch `overhaul/audit`, cut from `dev` at `3b31ad1`. No PR yet.
- **Engine:** `panel` (5 lenses over 60 files — `surface-taxonomy`, `bloat-duplication`,
  `layering-loops-dispatch`, `measurement`, `enforcement-leaks-ci` — adversarial verification
  ran: 75 raw findings, 71 confirmed, 4 marked unverified), supplemented by four
  evidence dispatches — a **repo research map** (inventories, line counts, cross-reference and
  dispatch-site map, graph-oriented), **criterion-6 benchmark evidence** (synthetic JSONL
  fixtures executed against `scripts/doctor.mjs --dir`), **criterion-8 leak evidence**
  (adversarial bypass harness against `scripts/redaction-check.mjs`, full-history scan,
  gitleaks), **criterion-9 CI evidence** (`gh` run history, live ruleset state, trigger
  matrix) — and one **cross-model dispatch** (Claude Opus 5, independently re-auditing
  criteria 1 and 6 from the repo alone, with its own execution harness).
- **Charter:** `docs/overhaul/01-audit-brief.md` (9 criteria). Finding shape per
  `references/findings.md`. Findings only: this run changed no source file.

## How to read this

One flat list, ranked across all nine criteria: grouped by severity tier, ordered Severity
desc → Impact desc → Complexity asc, so the quickest high-value wins surface first inside
each tier. Every finding carries a stable id (`A1`…), the brief criterion it answers
(`C1`…`C9`), and a `Sources:` line naming which engine(s) produced it — duplicates across
sources were folded into one finding, keeping the strongest evidence. Pre-confirmed entries
from `docs/known-issues.md` keep their identity: they are cited by id (`F1`…`F6` plus the
two unlabeled Doctor/dreaming entries), classified and ranked, never restated.

**Caveat 1 — devcycle audited devcycle.** The structure under suspicion did the auditing:
the panel engine, the finding contract, and the dispatch conventions being judged are the
ones that produced this document. That is why an independent second model (Opus 5) re-ran
criteria 1 and 6 from scratch. Where the two models disagreed — on findings, on severities,
or on claims one made that the other missed — the disagreement is reported in a dedicated
section below, not resolved silently. Disagreement is signal.

**Caveat 2 — findings not verified by execution.** The following are reading- or
design-based and carry Confidence `suspected` (everything else marked `verified` is backed
by an executed harness, a captured command output, or a fully traced code path):

- **A47** (forward-looking leak surfaces — run records, cross-repo store, Loop B public
  issues): no code exists yet; assessed from `docs/overhaul/02-cycle-request.md` only.
- **A53** (`superpowers:brainstorming` out-triggers `scoping-interview`): description-based
  model selection is probabilistic; the string asymmetry is verified, the selection outcome
  is not.
- **A54** (direct stage-skill entry bypasses cycle Step 0): contested between the two
  models — the panel's adversarial verifier refuted it at one cited location; see the
  disagreement section.
- Partial-confidence components inside otherwise-verified findings: the dollar **magnitude**
  of the cache confound on the 2026-08-03 report's deltas (A39 — mechanism verified, effect
  size not recomputable); the true **split** of the $2,443 `unattributed` bucket between A8's
  two mechanisms; the effect of manual mid-run edits (invisible to transcripts by
  construction, A39/A43); the correctness of the harness's own `attributionSkill` stamping
  (an upstream input outside this repo); whether historical transcripts carry dated model
  ids that `priceFor` would silently zero-price (A17); whether the pre-2026-08-05
  unprotected window on `main` was ever exploited (A5 — only the absence of a blocking
  mechanism is verifiable); which Node version any past CI run used (A51); and whether
  gitleaks/doctor were actually run for historical PRs beyond the ledger's self-report (A11).

---

## Ranked findings

### Critical

#### A1 — A credential, session id, internal URL, or transcript excerpt reaches the public repo with CI green: the redaction gate detects one of five sensitive classes
`critical · C8/C9 leak surface · Impact high · Complexity M (1 script + 1 workflow step)`
- **Location:** `scripts/redaction-check.mjs:14,21-23`; `scripts/redaction-hashes.txt` (2
  entries); `.github/workflows/validate.yml:24-25` (no other scanner).
- **What's wrong:** the repo's only content gate has exactly two mechanisms — a regex
  matching only macOS-form home paths (`Users/<name>` with a leading slash) and a sha256
  deny-list of individual word-tokens, currently 2 hashes. An adversarial harness (real
  `node scripts/redaction-check.mjs` in a temp repo, one class per fixture, exits captured)
  proved: a session UUID tied to a project dir, a GitHub-PAT-shaped token, an internal-looking
  URL, and a 10-line fake transcript excerpt all pass with exit 0; only the macOS host path
  fails. Linux- and Windows-form home paths also pass — and a Linux-form path (user `dev`)
  sits in HEAD right now at `tests/unit/doctor.test.mjs:512`, gate green (fabricated CI
  placeholder, so low content risk, but a live proof of the blind spot). The tokenizer
  (`[a-z][a-z0-9_-]{3,}` over lowercased text) structurally cannot match digit-initial UUIDs
  or anything containing `.`, `:`, `/`, `@`, `+`, `=`. gitleaks exists locally but runs in no
  workflow (zero hits for it across `.github/`), and it is a *secret* scanner — structurally
  blind to host paths, session ids, and excerpts even when run.
- **Why:** the brief's hard boundary names five data classes; the gate is a known-terms
  filter that by construction cannot see the four unknown-in-advance ones. Secrets are
  precisely the class you cannot deny-list ahead of time.
- **Confidence:** verified (harness outputs and exit codes captured). — **Measured
  against:** the brief's criterion-8 data classes; the gate's own stated purpose. —
  **Sources:** C8-evidence F1/F3, C9-evidence F4/F6, panel:enforcement-leaks-ci (×2).
- **If unaddressed:** every future data-carrying surface (per-run records, cross-repo store,
  Loop B public issues) inherits a screen that passes the exact classes it must stop; one
  quoted excerpt or session id ships publicly with every check green.
- **Verify:** re-run the fixture classes against `scripts/redaction-check.mjs`; grep HEAD
  for the Linux-form path in `tests/unit/doctor.test.mjs:512`.
- **Fix direction:** add a real secret scanner (gitleaks) as a CI step; extend the path
  regex to Linux/Windows/UNC forms; add shape-based detectors (UUID-near-path, URL,
  transcript-turn markers) rather than growing the deny-list.

#### A2 — Git history is never scanned, so a leaked secret survives every green build forever
`critical · C8/C9 leak surface · Impact high · Complexity S (1 scheduled workflow)`
- **Location:** `scripts/redaction-check.mjs:15` (`git ls-files` = current tree only);
  `CONTRIBUTING.md:74` (the manual gitleaks invocation is a `main...HEAD` three-dot diff).
- **What's wrong:** nothing in CI or in any documented local command re-scans history. A
  term present in commit N and removed in N+1 is invisible to every subsequent check, while
  the blob remains fetchable from the public repo indefinitely (raw at that sha, blame,
  API, forks). The one full-history gitleaks run on record (41 commits, in a gitignored
  ledger) was a one-off manual action. This audit's own full-history gitleaks pass (268
  commits) found no credential-shaped leaks — but that covers only the credential class;
  no history scan for the other four classes exists or is repeatable.
- **Why:** the brief's own "highest-value question": diff scanning is not sufficient; CI
  green at HEAD says nothing about what history serves.
- **Confidence:** verified (script traced; captured gitleaks history run). — **Measured
  against:** brief criterion 9, "green while a leak walks past it". — **Sources:**
  C9-evidence F5, panel:enforcement-leaks-ci, C8-evidence F6.
- **If unaddressed:** the first mistake that lands is permanent and unaudited; every later
  green build actively launders it.
- **Verify:** commit a canary term, remove it in the next commit, observe every check pass
  while the blob stays fetchable.
- **Fix direction:** scheduled full-history gitleaks in CI plus a one-time full-history
  pass with the extended class detectors from A1; document history rewrite as the response
  path.

### High

#### A3 — The auto-fire guard sits on the wrong layer: every guarded command's skill is model-invocable, and three commands lack the guard outright
`high · C1 surface taxonomy · Impact high · Complexity S (frontmatter edits)`
- **Location:** `commands/audit.md:2`, `commands/verify.md`, `commands/doctor.md` (no
  `disable-model-invocation`); `skills/distilling-learnings/SKILL.md:3`,
  `skills/onboarding-a-repo/SKILL.md:3`, `skills/dreaming-across-sessions/SKILL.md:3` (no
  skill anywhere carries the guard — repo-wide grep).
- **What's wrong:** DESIGN.md §4 amendment 4 says entry points cannot auto-fire (except
  `/cycle`, intentionally) and side-effectful skills carry the guard. Reality: `audit`
  (writes a tracked findings file), `verify`, and `doctor` are model-invocable; and all four
  deliberately user-typed-only commands (`dream`/`distill`/`onboard`/`continue`) delegate to
  skills that sit on the model's roster with no guard, stating "invoke only via
  /devcycle:distill" as prose *inside the trigger string whose job is to attract
  invocation*. The model can reach the exact entry the author blocked.
- **Why:** the guard exists because these surfaces write and delete files; a rule written
  into a selection trigger is not a guard. The authorization model is defeated, not leaky.
- **Confidence:** verified (grep; cross-model pass confirmed all three skills on its live
  session roster with those descriptions). — **Measured against:** DESIGN.md §4 amendment
  4. — **Sources:** panel:surface-taxonomy (×2), cross-model A2.
- **If unaddressed:** a matching user phrase can silently start a memory-deleting distill or
  a file-writing onboard; the restructure inherits an exposure model that contradicts its
  own design doc.
- **Verify:** grep `disable-model-invocation` across `commands/` and `skills/`; compare
  with DESIGN.md:121-124.
- **Fix direction:** whatever surface owns a side effect carries the structural guard;
  skills that must never self-fire need a platform-level exposure control, not prose (a
  restructure design question the brief reserves — direction only).

#### A4 — "Resume after /clear" routes to `executing-waves`, bypassing every safety check `/devcycle:continue` owns
`high · C1/C3 surface taxonomy · Impact high · Complexity S (2 description edits)`
- **Location:** `skills/executing-waves/SKILL.md:3` ("resuming one after /clear") vs
  `commands/continue.md:2-3` (`disable-model-invocation: true`).
- **What's wrong:** the only surface that owns resumption — continue.md, with its `root:`
  ownership check (:21-27), depth gate (:48-58), and stage→skill resume table (:62-74) — is
  the one surface the model cannot select. The surface the model *will* select on any
  non-slash phrasing of "resume" is `executing-waves`, whose trigger string claims that
  exact job verbatim. All three safety mechanisms are skipped on that path: a state file
  belonging to another checkout is trusted, an over-budget session resumes anyway, and a
  cycle parked at branch-review or on-device resumes as if mid-execution.
- **Why:** the guard applied to `continue` (to stop spontaneous resumption) hands
  resumption to the unguarded skill instead — the guard inverts its own purpose.
- **Confidence:** verified (both strings; guard absence traced). — **Measured against:**
  `commands/continue.md:21-74`. — **Sources:** cross-model A4; corroborated by
  panel:surface-taxonomy trigger-overlap evidence.
- **If unaddressed:** the file-based-resumability guarantee — the pipeline's load-bearing
  promise — is only as strong as the user's habit of typing the literal slash command.
- **Verify:** compare the two description strings; grep executing-waves for any of
  continue.md's three checks.
- **Fix direction:** remove the resume claim from executing-waves' trigger; route all
  resume phrasing to the continue flow.

#### A5 — The operating identity can force-push or delete `main` today, and the Release job runs no checks of its own
`high · C9 release path · Impact high · Complexity S (ruleset + 1 workflow condition)`
- **Location:** GitHub ruleset "no deletion, no force-push" for `main` (admin-role
  `bypass_actors`, `current_user_can_bypass: always` — live API state);
  `.github/workflows/bump-version.yml:5` (triggers on any push to `main`; sole gate is
  tag-existence at :34-37, no dependency on Validate).
- **What's wrong:** the force-push/deletion ruleset exempts the Admin role — i.e. the one
  identity that operates this repo daily (and whose credentials every Claude session here
  runs under). The "never force-push, never push main directly" invariant is enforced by
  GitHub for everyone *except* the only actor who could actually do it. Separately, the
  Release workflow tags and publishes whatever version `main` carries, with no check of its
  own and no dependency on `validate` having passed. Historical context, dated precisely:
  from repo creation (2026-07-22) to 2026-08-05T21:15 UTC, `main` had **no** protection at
  all — a direct push reached the tag-and-publish path unchecked for ~2 weeks. The
  PR-required + required-checks ruleset (bypass "never") closed that on 2026-08-05.
- **Why:** the release path's integrity currently rests on one ruleset (see A48 for its
  non-codification) plus session discipline for the admin actor.
- **Confidence:** verified (live ruleset API output; workflow file; merged-PR dates). —
  **Measured against:** brief criterion 9 trigger/privilege questions; the repo's own
  branch-discipline convention. — **Sources:** C9-evidence F1/F3, panel:enforcement-leaks-ci.
- **If unaddressed:** a single misfired command in any session with the owner's
  credentials can rewrite or delete the release branch; a malformed push event can publish.
- **Verify:** query the repo rulesets API; read bump-version.yml's trigger and gate.
- **Fix direction:** drop the admin bypass from the force-push/deletion ruleset; make the
  Release job verify its ref's check-suite conclusion before tagging.

#### A6 — No per-run metadata exists: version is scraped from install paths (dev-checkout sessions silently dropped), and sha/profile/knobs/model-routing are recorded nowhere
`high · C6 measurement · Impact high · Complexity M (a run-record schema + emit points)`
- **Location:** `scripts/doctor.mjs:12-18` (path regex, first match latched per session),
  `:191` (`if (!s.pluginVersion) continue;` — null-version sessions dropped from cohorts,
  no count emitted), `:383-471` (summary shape: no sha, no profile, no knobs, no
  stage×model join); `.devcycle/state.md` (profile as prose only, untracked).
- **What's wrong:** plugin version is inferred by regexing a versioned install path out of
  each record's JSON — a marketplace install yields a version, a dev checkout yields `null`
  (executed both ways), so the sessions where a skill actually changed are systematically
  invisible to the version-regression signal. Git sha, profile, resolved knob values, and
  intended model-per-dispatch appear nowhere machine-readable (`dispatches.withoutModel` is
  only a count: 354 of 666, 53%). `costByStage` and `costByModel` are disjoint maps, so
  "which model ran this stage" is unrecoverable. Doctor's own script version and
  attribution rule are absent from its reports, so the 2026-08-03 report's per-stage
  numbers cannot be reproduced by the current script. Plainly, as the brief demands: **no
  cross-version or cross-model comparison is currently possible.** The hand-written
  benchmark files *do* record branch/commit/profile — proving the schema is known — but in
  prose, with no session id, joinable to nothing.
- **Confidence:** verified (executed marketplace-vs-checkout fixture; absence confirmed by
  search over the script, report, ledger, state file). — **Measured against:** brief
  criterion 6's explicit metadata list; `.claude-plugin/plugin.json` `userConfig`. —
  **Sources:** C6-evidence F3, panel:measurement, cross-model B5/B6/B13.
- **If unaddressed:** the restructure has no before/after instrument; a cost delta between
  two dates is equally explained by a profile change and a code change, and any "the
  restructure reduced cost" claim will be unfalsifiable.
- **Verify:** run doctor on a dev-checkout transcript fixture; observe `null` version and
  silent cohort exclusion.
- **Fix direction:** a per-run record (run id, version, sha, profile, resolved knobs,
  model per dispatch, session ids + window) written by the pipeline itself, not scraped
  from transcripts.

#### A7 — `attributeForwardFill()` charges unbounded trailing spend to the last-tagged skill: 834× overstatement executed, stage-ordering not trustworthy
`high · C6 measurement · Impact high · Complexity M (attribution redesign)`
- **Location:** `scripts/doctor.mjs:350-366` (fill), `:342-344` (`transcriptOf` ignores
  `isSidechain`), `:409` (bucketing).
- **What's wrong:** every untagged turn after a skill tag — related or not — is charged to
  that skill until the next tag or transcript end. Executed fixtures: a stage truly costing
  $0.003 reported at $2.50 (834×); a one-turn interleaved sidebar skill captured 99.85% of
  the surrounding stage's cost, inverting which stage looks expensive; a child skill
  invoked mid-stage permanently steals its parent's remainder (108:1 measured — the
  mechanism by which `reviewing-code`, which no user ever invokes, appears as the
  4th-most-expensive "stage" at $179.17 in the 2026-08-03 report, and the likelier cause of
  `continue`'s $282.53 and its 2,500%+ "outliers" than the report's stated cause); and a
  sidechain record lacking `agentId` shares the main transcript's fill key, so even the
  transcript boundary leaks. The design doc accepted "a bounded overcount"; the bound is
  the session's entire remaining spend. Unit tests assert the trailing fill as intended
  behavior and cover none of these cases.
- **Confidence:** verified (all four shapes executed, two independent harnesses). —
  **Measured against:** fixture ground truths; the 2026-08-03 report's per-stage table. —
  **Sources:** C6-evidence F1/F5 §2, cross-model B4/B.1, panel:measurement.
- **If unaddressed:** per-stage cost — the load-bearing number for every regression
  candidate and restructure priority — carries unbounded error; stage orderings within ~2×
  of each other are noise.
- **Verify:** rebuild the fixture corpus per the C6-evidence method note and run
  `node scripts/doctor.mjs --dir <fixtures>`.
- **Fix direction:** attribute only explicitly tagged turns plus a bounded window; emit an
  attribution-coverage ratio with every report; key subagent transcripts to their
  dispatching stage (A8).

#### A8 — The 59% `unattributed` bucket has two verified drivers — untagged subagents and whole-session recruitment — and the measurement record's own #1 finding misstates the mechanism, so its recommended fix is a no-op
`high · C6 measurement · Impact high · Complexity M`
- **Location:** `scripts/doctor.mjs:350-366` (fill never crosses transcripts), `:50-67` +
  `:639` (`isDevcycleSession` recruits a whole session off any single devcycle record);
  `.devcycle/doctor/2026-08-03-report.md:34-46, 218-221` (the misstatement).
- **What's wrong:** (1) a subagent transcript with no tag of its own lands 100% in
  `unattributed` even though the orchestrator knows which stage dispatched it — executed:
  $3.00 of implementer work under an executing-waves dispatch reported unattributed; real
  corpus: 68% of subagent assistant turns (13,300 of 19,483) carry no tag. (2) one devcycle
  turn in a 500-turn session recruits the other 499, which — being before the first tag —
  land unattributed. Meanwhile the 2026-08-03 report's Finding 1 claims the bucket is
  "turns after the last skill invocation" — executed evidence shows the exact opposite
  (post-tag turns are *attributed*; pre-tag turns are not) — and its fix direction ("extend
  attribution through session end") describes behavior that already shipped and is asserted
  by `tests/unit/doctor.test.mjs:95`. The script's own DISCLOSURE text states the behavior
  correctly; the report misread it while claiming to carry it verbatim.
- **Why:** this is the #1 finding of the only measurement artifact the restructure has,
  owning 59% of measured spend ($2,443.20 of $4,131.44); acting on it changes nothing while
  the real drivers stay unnamed. The relative split between the two drivers is not
  computable from the report (see Caveat 2).
- **Confidence:** verified (both mechanisms executed; the report/code contradiction is a
  direct text-vs-execution comparison, independently confirmed by both harnesses). —
  **Measured against:** `scripts/doctor.mjs:350-366, 473-477`;
  `tests/unit/doctor.test.mjs:95`. — **Sources:** cross-model B1/B7, C6-evidence F4,
  panel:measurement.
- **If unaddressed:** the restructure's largest apparent cost lever is spent on a no-op;
  stage costs stay biased toward main-thread work, understating exactly the fan-out-heavy
  stages that most need measuring.
- **Verify:** run the pre-tag/post-tag fixture pair; diff the result against the report's
  Finding 1 text.
- **Fix direction:** propagate the dispatching stage onto subagent transcripts; scope
  session membership to tagged spans; correct the report's finding before anything cites it.

#### A9 — There is no run identity: doctor measures sessions while devcycle deliberately spans runs across sessions, so "cost of a devcycle run" is not a quantity the instrument can produce
`high · C6 measurement · Impact high · Complexity L (schema + pipeline emit points)`
- **Location:** `scripts/doctor.mjs:399,409` (join = forward-filled `attributionSkill`
  string, scoped to one session file); `commands/cycle.md:48-63` (state-file schema: no
  session or run identifier).
- **What's wrong:** the only key linking a pipeline stage to token counts is a per-turn
  skill-name string. It names a skill, not a stage (superpowers skills appear as "stages");
  it pools standalone and in-cycle invocations of the same skill; two cycles in one session
  merge into one bucket; and no run id, cycle id, wave id, or task id exists anywhere in
  the join. `.devcycle/state.md` and `ledger.md` — the artifacts that know which run is in
  flight — carry no session id, so the pipeline's own state and doctor's corpus share no
  key at all. devcycle's core guarantee (a run survives `/clear`, spanning N sessions)
  makes the measurement unit contradict the execution unit by construction. Two runs are
  comparable only if corpus, window, script version, price table, and cache state all
  match — none of which is recorded with the output.
- **Confidence:** verified (code path + state-file schema; the repo's own second dreaming
  benchmark had to bracket by wall clock and concedes its figures are "an upper bound…,
  not the dream cost"). — **Measured against:** `commands/cycle.md:7-9,48-63`; the
  benchmark's own concession. — **Sources:** panel:measurement, cross-model B3,
  C6-evidence §4. — **Severity contested:** the cross-model pass rated this critical; the
  panel and the C6 evidence dispatch rated it high; listed high per the severity
  vocabulary (no data loss, security hole, or broken release path today) — see the
  disagreement section.
- **If unaddressed:** every dollar or percentage devcycle publishes about itself remains a
  per-session fragment of an unknown number of runs; every downstream criterion that
  depends on measured cost inherits this.
- **Verify:** search the state file and ledger for any session identifier; trace the join
  in `summarize`.
- **Fix direction:** mint a run id at cycle Step 0, stamp it into the state file, ledger,
  and every dispatch, and record it per-run alongside A6's metadata.

#### A10 — F1 + F2 (cited): both dream→distill feedback metrics are structurally dead, so "the promotions held" and "never re-propose landed work" are unverifiable promises
`high · C5 dreaming/distilling · Impact high · Complexity L (matching redesign)`
- **Cited:** `docs/known-issues.md` **F1** (`--check-recurrence` structurally near-incapable
  of firing — 0/26 signatures matched; blocking, design) and **F2** (reduce not
  reproducible on identical input — 30 vs 12 candidates, 1 signature in common; blocking,
  correctness). Classification and rank only; content not restated here.
- **Classification:** both metrics key on exact normalized signature text
  (`scripts/dream.mjs:335,354` and the landed-signature suppression at :329-360), which
  F1/F2 jointly show is lexically unstable — so the suppression promise and the recurrence
  check fail from the same root cause. Ranked high (the known-issues file marks both
  blocking) with high impact: the loop's entire self-evaluation rests on them.
- **Confidence:** verified (pre-confirmed with located causes and measured runs). —
  **Measured against:** the two real-conditions runs recorded in the known-issues entries.
  — **Sources:** docs/known-issues.md F1/F2; panel:measurement (classification).
- **Fix direction (from the entries' own analysis):** semantic or normalized-token
  matching, and pinned cluster granularity, before any metric built on signatures is
  trusted. **Effort:** L.

#### A11 — Every criterion-7 behavioral invariant is enforced by prose alone: the scenario suite (78% of tests/) runs nowhere, and per-commit conventional commits are checked by nothing
`high · C7/C9 invariants · Impact high · Complexity L (CI-checkable invariant redesign)`
- **Location:** `CONTRIBUTING.md:48-52` ("not a merge gate… Nothing in CI runs these…
  Skipping them… is fine"); `.github/workflows/validate.yml` (no scenario step — grep
  confirms zero references to `tests/scenarios`); `validate.yml:30-42` (`pr-title` checks
  only the PR title, never individual commit subjects, and nothing checks direct `dev`
  pushes — which `prepare-release.yml` itself performs).
- **What's wrong:** of the brief's named invariants — file-based resumability, the green
  gate, evidence-before-claims, redaction screening, conventional commits, no direct push
  to the release branch, batched questions — only redaction screening (hollow per A1) and,
  since 2026-08-05, no-direct-push-to-main (A5, live ruleset only) have anything mechanical
  behind them. The scenario tests that *do* cover resumability, the green gate,
  file-backed evidence, and batched questions (9,733 lines, 57 files) are best-effort
  prose specs no workflow executes. The ledger's "gitleaks clean… green gate passed"
  entries are session self-reports nothing outside the session verifies.
- **Confidence:** verified (the repo's own documentation states it; workflows confirm). —
  **Measured against:** brief criterion 7 ("anything enforced only by prose… is a
  finding"); `CONTRIBUTING.md`'s own claims. — **Sources:** panel:enforcement-leaks-ci,
  C9-evidence F7/F8, panel low (commit-convention).
- **If unaddressed:** a rule enforced only in a session is not enforced; every invariant
  survives the restructure only if each rewritten skill happens to restate it.
- **Verify:** grep workflows for `scenarios`; read CONTRIBUTING.md:48-52 and 96-104.
- **Fix direction:** identify which invariants can be made mechanically checkable (state-file
  shape, ledger grammar, commit subjects on push, evidence-file existence) and gate those;
  say plainly which remain prose.

#### A12 — Lexicographic version sort will fabricate wrong-direction regressions in the next doctor report: 0.10.x/0.11.x sort before 0.2.0
`high · C6 measurement · Impact medium · Complexity S (one comparator)`
- **Location:** `scripts/doctor.mjs:198` (`[...byVersion.keys()].sort()`).
- **What's wrong:** version cohorts are ordered as strings. Executed: a 90% cost
  *improvement* from 0.9.0→0.10.0 was reported as `version-regression … 0.10.0->0.9.0
  delta=900.0%`. The repo is at 0.11.1, so with the real release history the adjacent-pair
  comparisons become 0.10.x → 0.11.x → 0.2.0 → … — false regressions and masked real ones
  for every future report.
- **Confidence:** verified (executed; CANDIDATE line captured). — **Measured against:**
  semver ordering; the repo's own CHANGELOG version set. — **Sources:** C6-evidence F2,
  panel:measurement.
- **If unaddressed:** the flagship benchmark signal (behind report findings 2/3/5/8/10-13)
  is corrupted from the next run onward.
- **Verify:** two-cohort fixture spanning 0.9→0.10. — **Fix direction:** semver-aware
  compare. **Effort:** one line plus a test.

#### A13 — Version-regression candidates fire on cohorts of one, and the baseline cohort's sample size is computed then discarded
`high · C6 measurement · Impact medium · Complexity S`
- **Location:** `scripts/doctor.mjs:199-223`, esp. `:209` (only an exactly-zero median is
  rejected) and `:219` (`sessions_sampled` = to-cohort only).
- **What's wrong:** executed: two single-session cohorts ($0.0017 → $0.19) emit
  `delta_pct: 11076.47, sessions_sampled: 1` — indistinguishable in printed form from the
  2026-08-03 report's headline 10,944% finding. A reader cannot tell whether a delta rests
  on 6-vs-6 or 6-vs-1; the from-cohort n is never emitted.
- **Confidence:** verified (executed). — **Measured against:** the report's findings
  2/3/5/8/10-13; brief criterion 6's error-bar rule. — **Sources:** cross-model B2,
  panel:measurement. — **Severity contested:** cross-model critical, panel medium; listed
  high — see the disagreement section.
- **If unaddressed:** the proposed release-time cost gate would block releases on noise.
- **Verify:** single-session cohort fixture. — **Fix direction:** minimum cohort size,
  emit both n's, refuse a delta when either is below it. **Effort:** hours.

#### A14 — The `doctor` skill is unreachable: the command of the same name occupies the `devcycle:doctor` namespace, and the validator is structurally unable to notice
`high · C1 surface taxonomy · Impact medium · Complexity S (rename)`
- **Location:** `skills/doctor/SKILL.md:1-4` vs `commands/doctor.md:1-3`;
  `scripts/validate.mjs:119-121` (resolves a `devcycle:<name>` reference against skills,
  agents, *or* commands — first hit passes, so the collision is invisible to it).
- **What's wrong:** both surfaces resolve to `devcycle:doctor`. On a live session roster
  the identifier appears once, carrying the command's description; the skill's 145 lines —
  the actual analyzer contract, including the disclosure-carry rules the 2026-08-03 report
  leans on — are dead weight unless the model reads the file by path.
  `commands/doctor.md:18`'s "Use the `devcycle:doctor` skill" resolves back to itself.
  Both names also break DESIGN §13's verb-first-gerund skill-naming rule (as does
  `fast-path`).
- **Confidence:** verified (cross-model pass inspected its own live roster — the same
  mechanism a user session uses; 17 of 18 expected entries present, `skills/doctor` the
  one missing). — **Measured against:** the plugin's own roster; `scripts/validate.mjs`;
  DESIGN §13. — **Sources:** cross-model A1, panel:surface-taxonomy (naming).
- **If unaddressed:** every doctor invocation runs without its contract; the restructure
  can reintroduce the same collision for any new surface since the validator passes it.
- **Verify:** list the session's skill roster; count devcycle entries. — **Fix
  direction:** rename the skill (gerund form) and make validate.mjs reject cross-layer
  name collisions.

#### A15 — Five skills state invocation preconditions the platform cannot honor — `reviewing-code` says "never directly by a user" while listed to users — and the repo's own validator forces engine skills to be phrased as selection triggers
`high · C1 surface taxonomy · Impact medium · Complexity S`
- **Location:** `skills/reviewing-code/SKILL.md:3`; `skills/fast-path/SKILL.md:3` and
  `skills/sweeping-mechanical-changes/SKILL.md:3` ("Use when devcycle triage has
  confirmed…" — a precondition the selecting model cannot check, inside the very string
  that decides selection); `skills/distilling-learnings/SKILL.md:3`,
  `skills/onboarding-a-repo/SKILL.md:3`; `scripts/validate.mjs:56-59` (requires every
  skill description to start "Use when").
- **What's wrong:** the brief names `reviewing-code` as the example; it is the general
  case. A skill's only exposure control is whether the file exists, so "never directly by a
  user" in a description is a wish. CI then *enforces* the taxonomy defect: the validator
  makes every skill — including engines that must never be selected — advertise itself as a
  model-selection trigger.
- **Confidence:** verified. — **Measured against:** brief criterion 1; DESIGN §4.4;
  `scripts/validate.mjs:56-59`. — **Sources:** panel:surface-taxonomy, cross-model A3.
- **If unaddressed:** selection stays nondeterministic across the whole roster (see the
  routing table: three review-named surfaces, none the right answer for "review my
  branch").
- **Verify:** read the five descriptions; run validate.mjs against a description not
  starting "Use when". — **Fix direction:** an explicit engine class exempt from
  trigger-phrasing, or removal of engines from the roster.

#### A16 — `skills/doctor` instructs rendering the dead recurrence metric as a clean bill of health, the exact reading F1 forbids
`high · C5/C6 dreaming/distilling · Impact medium · Complexity S (one section edit)`
- **Location:** `skills/doctor/SKILL.md:86-91` (an empty recurrence appendix rendered as
  "ran and found nothing" at standard/thorough).
- **What's wrong:** F1 established that a 0-hit recurrence result is what the matcher
  returns almost regardless of whether promotions held, and "must never be reported as
  evidence that they held". The consumer surface was never updated: doctor reports will
  present a structurally meaningless zero as verification.
- **Confidence:** verified (both texts directly comparable; `scripts/dream.mjs:354` still
  literal-substring matches). — **Measured against:** `docs/known-issues.md` F1. —
  **Sources:** panel:measurement.
- **If unaddressed:** the one place users see the metric actively launders it.
- **Verify:** read the two texts side by side. — **Fix direction:** carry F1's caveat in
  the rendering, or drop the appendix until the matcher is redesigned.

#### A17 — Silent data loss on three read paths, none counted: `readRecords` (cited) swallows filesystem errors, torn JSONL lines are skipped, unpriced models are excluded from cost but not from counts
`high · C6 measurement · Impact medium · Complexity S`
- **Cited:** `docs/known-issues.md` § Doctor — "`readRecords` swallows every filesystem
  error" (high; `scripts/doctor.mjs:590`): a permission-denied or oversized transcript
  vanishes and `--extract` exits 0 empty. The fix-freeze that protected it has lifted.
- **Extends:** `scripts/doctor.mjs:601-604` (malformed line silently skipped, no counter);
  `:404-406` + `scripts/pricing.mjs:17-20` (a turn whose model misses the 5-entry
  exact-match price table contributes zero dollars while still counting in
  turns/models/bands — and only one table entry is a dated id, so dated ids in old
  transcripts silently zero-price). The report's "no UNPRICED MODEL lines" completeness
  claim covers none of these paths. A related executed case: byte-identical duplicated
  records double-count (no uuid/requestId dedup) — mechanism verified, real corpus
  currently clean.
- **Confidence:** verified (paths traced; duplicate case executed); magnitude of the
  omission unmeasurable by design — which is the finding. — **Measured against:**
  known-issues §Doctor; the report's own completeness claim. — **Sources:**
  docs/known-issues.md; cross-model B12; C6-evidence F10.
- **Fix direction:** count and report every skipped line, failed file, and unpriced
  dollar; dedup by uuid. **Effort:** hours.

#### A18 — A stale `fixes-required, cap reached` verdict sits on disk contradicting the true round-3 outcome (PASS), because the branch-review report has no pinned path and nothing overwrites the old one
`high · C3 layering/loops · Impact medium · Complexity S (pin one path)`
- **Location:** `.devcycle/findings/branch-review-final.md:6` (previous cycle's verdict)
  vs `.devcycle/ledger.md:182` and `.devcycle/findings/branch-round-3.md:6` (current
  cycle: PASS, no blocking findings); `skills/reviewing-the-branch/SKILL.md:148-197`
  (report shape mandated, write path never specified).
- **What's wrong:** this resolves the brief's required-input question — **the truth is
  PASS with residue carried over**; the `fixes-required, 3 of 3 cap` file is the
  *previous* (2026-08-04, engine `single`/cap-3) cycle's final report left stale, while
  the current cycle (engine `panel`/cap-5) recorded PASS in the ledger and round-3 file.
  Mechanism: the skill mandates the report's shape but pins no on-disk path, so the
  current verdict lives in a ledger one-liner and a scrolled-away handoff block while the
  only file named "final" on disk is the stale opposite. A `/clear` at this boundary loses
  the verdict; a resumed session or reader deciding release status from
  `.devcycle/findings/` gets the opposite of the truth — exactly the mechanism by which a
  user is wrongly held in, or released from, a review loop.
- **Confidence:** verified (all four artifacts inspected; engine/cap fingerprints match). —
  **Measured against:** `references/handoff.md` (files are the state); brief criterion 3.
  — **Sources:** panel:layering-loops-dispatch (×2).
- **Verify:** compare the two findings files' Engine/cap headers against the ledger. —
  **Fix direction:** pin a canonical report path per cycle and overwrite/archive it at
  verdict time.

#### A19 — The one review outcome guaranteed to leave a `fixes-required` report behind is the one path that never archives it
`high · C3 layering/loops · Impact medium · Complexity S`
- **Location:** `skills/finishing-the-cycle/SKILL.md:60-72` (archiving lives only in
  finish); `skills/reviewing-the-branch/SKILL.md:137-139, 189-197` (fixes-required at cap
  keeps `stage: branch-review` and stops — never reaches finish).
- **What's wrong:** the next cycle then inherits colliding stale artifacts at fixed
  task-id paths; the ledger records this happening (wave-1 implementers tripping over
  prior-cycle reports/evidence). Directly feeds A18.
- **Confidence:** verified (repo-wide grep: archiving exists nowhere else; ledger
  incident recorded). — **Measured against:** brief criterion 3; the skill's own terminal
  states. — **Sources:** panel:layering-loops-dispatch.
- **Fix direction:** archive on every terminal state, not only on finish. **Effort:** hours.

#### A20 — Three loops have no cap and no defined exhaustion outcome: the per-task implementer↔reviewer loop, both short-path review loops, and the dream map's self-verification retry
`high · C3 layering/loops · Impact medium · Complexity S (state caps + outcomes)`
- **Location:** `skills/executing-waves/SKILL.md:161-162` (re-review after fixes,
  unbounded; the ledger's observed "fix round 1 of 5" cap has no owner anywhere — grep
  confirms `references/config.md:51` caps only branch-review rounds);
  `skills/fast-path/SKILL.md:53` and `skills/sweeping-mechanical-changes/SKILL.md:151`
  ("re-dispatch until accept", no cap, no exhaustion outcome, neither referencing the
  generic stage budget as its bound); `skills/dreaming-across-sessions/SKILL.md:95-96`
  ("redo the write before reporting", no retry limit, no outcome when redoing keeps
  failing).
- **Why:** the brief requires every bounded loop to state cap, exhaustion behavior, and
  unambiguous user reporting; an implementer that cannot satisfy its reviewer loops
  forever with nothing reported. (Round counts that *are* capped — branch review —
  measured at their caps in the real ledger, which is how A18's contradiction arose.)
- **Confidence:** verified (texts + grep). — **Measured against:** the repo's own
  branch-review cap-and-terminal-states discipline; brief criterion 3. — **Sources:**
  panel:layering-loops-dispatch (×3, folded).
- **Fix direction:** every loop states its cap and a terminal state that is reported to
  the user, per the branch-review precedent. **Effort:** hours per loop.

#### A21 — The fast path's exit statuses cross a stage boundary in-context only, so a `/clear` makes the reviewer's mandatory check impossible
`high · C3 layering/loops · Impact medium · Complexity S`
- **Location:** `skills/fast-path/SKILL.md:34-35, 46-52` (statuses "cannot be recovered
  from the file afterwards", handed to the reviewer in step 5);
  `references/evidence.md:74-82` (an exit-status contradiction is a mandatory rejection
  condition).
- **What's wrong:** a `/clear` between implement and review resumes at `stage: fast-path`
  with the before/after statuses gone; the dispatched reviewer cannot run the check it is
  explicitly required to run. The brief classes any state crossing a stage boundary
  in-context as at least high.
- **Confidence:** verified. — **Measured against:** brief criterion 3; references/evidence.md.
  — **Sources:** panel:layering-loops-dispatch.
- **Fix direction:** write the statuses into the evidence file the reviewer already reads.
  **Effort:** hours.

#### A22 — Omitting `DEVCYCLE_PANEL_MODEL` for the session tier silently runs the panel on the CLI's default model, defeating session-tier escalation — and no artifact records which model actually reviewed the branch
`high · C4 dispatch · Impact medium · Complexity S`
- **Location:** `skills/reviewing-code/SKILL.md:72` (omit the env var when
  `branchReviewModel` resolves to session tier) vs `workflows/review-panel.js:35,129,509`
  (unset env var → lens/verifier/reconciler subagents spawn with no `--model`, resolving
  to the CLI's configured default, not the coordinator's session model);
  `skills/reviewing-the-branch/SKILL.md:78-84` + `.devcycle/ledger.md` (all three real
  panel rounds log no model, though `references/config.md` requires every dispatch's
  ledger event to record the model decision).
- **What's wrong:** the same defeats-escalation class as the removed implementer
  frontmatter pin, via a different execution path — and `sweeping-mechanical-changes`
  documents this exact env-var-cannot-inherit limitation for its own var while
  reviewing-code implies omission *is* the session tier. Verified by execution path, as
  the brief demands, not by reading the rule.
- **Confidence:** verified (path traced through the workflow's spawn sites; ledger rounds
  inspected). — **Measured against:** `references/config.md` §Model tiers; the sweep
  skill's documented departure. — **Sources:** panel:layering-loops-dispatch (×2, folded).
- **If unaddressed:** every panel review silently runs on whatever the CLI default is,
  and no one can reconstruct which model produced a verdict.
- **Fix direction:** always export the resolved model; log it in the round's ledger event.
  **Effort:** hours.

#### A23 — DESIGN.md carries a full drifted copy of the handoff context-action table, producing two contradictory normative statements of one convention
`high · C2 bloat/duplication · Impact medium · Complexity S (delete + pointer)`
- **Location:** `DESIGN.md:149-167` (full copy of `references/handoff.md`'s table and
  softening test — missing the `on-device → finish` row handoff.md:60 gained on
  2026-08-05, which exists nowhere else) vs `DESIGN.md:147` (which itself names
  handoff.md as owner).
- **Confidence:** verified. — **Measured against:** DESIGN §15.1 (a pointer beside a
  retained restatement leaves two owners); the 2026-08-05 profile-matrix precedent. —
  **Sources:** panel:bloat-duplication.
- **If unaddressed:** the exact failure §15.1 predicts — a contributor follows whichever
  copy they find first. — **Fix direction:** replace the copy with the pointer, per the
  repo's own precedent. **Effort:** minutes.

#### A24 — F3 (cited): `standard`-depth dreaming cannot see user turns at all
`high · C5 dreaming/distilling · Impact medium · Complexity M`
- **Cited:** `docs/known-issues.md` **F3** (high) — extraction keeps only text blocks,
  discards roles/timestamps, strips `AskUserQuestion` answers; at the depth whose slice is
  *user-correction turns*, dispatches cannot distinguish user from assistant. Classified
  under criterion 5 (correctness of the mining input); ranked high per its entry. Content
  not restated. — **Sources:** docs/known-issues.md F3.

#### A25 — "Review my branch" is unguessable: three review-named surfaces are all wrong answers, the right one is spelled `audit`, and its argument grammar silently misroutes a branch name into a concern
`high · C1 surface taxonomy · Impact medium · Complexity M (naming/regrouping)`
- **Location:** `commands/audit.md:17-30` (the only entry point for branch review is
  `branch:<name>`; ":24-26 makes a bare argument *always* the concern — so
  `/devcycle:audit my-branch` runs a whole-repo audit for the concern "my-branch");
  `README.md:319,334`; the three review-named skills' descriptions.
- **What's wrong:** the most common pre-merge intent in any repo has no `review` entry
  point; `reviewing-the-branch` presumes a plan/spec/ledger that don't exist standalone,
  `reviewing-code` forbids direct use, `/devcycle:verify` is UI-only. Internally
  consistent, externally unguessable. For uncommitted in-session work there is no entry
  point at all (routing rows 7/8/22).
- **Confidence:** verified. — **Measured against:** brief criterion 1's confusable-pair
  mandate. — **Sources:** panel:surface-taxonomy, cross-model A5.
- **Fix direction:** a user-facing review entry (or an audit alias) whose name matches
  the intent; make a bare branch-shaped argument ask rather than silently reinterpret.
  **Effort:** days (naming is restructure scope).

### Medium

#### A26 — The dream/distill surface is four overlapping entry points, and the load-bearing fact — distill runs the dream as its step 0 — is absent from the command doc that a user and the model actually load
`medium · C1/C5 · Impact medium · Complexity S`
- **Location:** `commands/dream.md:2`, `commands/distill.md:8-15` (never mentions the
  dream), `skills/dreaming-across-sessions/SKILL.md:3`,
  `skills/distilling-learnings/SKILL.md:34` (step 0 runs the dream), `README.md:326`
  (says so — the command doc and README disagree).
- **Why:** a newcomer concludes they are alternatives and runs both, paying the mining
  pass — the costliest artifact family in the repo — twice.
- **Confidence:** verified. — **Measured against:** the three documents' own text; brief
  criterion 1. — **Sources:** panel:surface-taxonomy, cross-model A6.
- **Fix direction:** state the subsumption in `commands/distill.md`; differentiate the
  four trigger strings. **Effort:** hours.

#### A27 — `verifying-on-device`'s description claims `/devcycle:verify`'s whole territory, silently losing the command's refuse-to-guess branch guard
`medium · C1 · Impact medium · Complexity S`
- **Location:** `skills/verifying-on-device/SKILL.md:3` ("when a branch must be verified
  on-device without a plan — including code this session did not write") vs
  `commands/verify.md:17` (empty argument → stop and ask, never guess the checked-out
  branch).
- **Why:** invoking the skill directly *is* the guessing path the command was written to
  prevent — the command exists to supply the two facts the skill cannot derive.
- **Confidence:** verified. — **Measured against:** commands/verify.md; DESIGN §17. —
  **Sources:** panel:surface-taxonomy, cross-model pair resolution.
- **Fix direction:** narrow the skill's trigger to in-cycle use. **Effort:** minutes.

#### A28 — `/devcycle:continue` silently resumes the single state slot: with two cycles ever in flight, one is orphaned with no resume pointer
`medium · C3 · Impact medium · Complexity M`
- **Location:** `commands/continue.md:15-20` (reads exactly one fixed path);
  `commands/cycle.md:39-45` (Step 0 resets the slot to start a second cycle — preserving
  only `configured:`, no pointer to the orphan; archive runs only at finish, A19).
- **Why:** the brief's criterion-3 question answered: continue cannot identify *which*
  cycle — it silently picks the slot. A branch review parked at its cap awaiting a user
  decision becomes unreachable while its artifacts masquerade as current (the reviewed
  corpus records exactly this sequence, A18).
- **Confidence:** verified. — **Measured against:** brief criterion 3 bullet 4. —
  **Sources:** panel:layering-loops-dispatch; cross-model routing row 21.
- **Fix direction:** cycle-scoped state (id-keyed), or refuse to reset a live slot
  without archiving it. **Effort:** days.

#### A29 — ~150 of `commands/cycle.md`'s 368 lines are first-run/upgrade prose that every configured user pays on every start
`medium · C2 · Impact medium · Complexity S`
- **Location:** `commands/cycle.md:87-241`; path 1 at :96 dismisses the whole section in
  one line; rationale paragraphs at :105-126 and :169-177 fail the deletion test outright.
- **Confidence:** verified. — **Measured against:** `references/quality-criteria.md`
  token-and-context-cost criterion. — **Sources:** panel:bloat-duplication.
- **Fix direction:** move first-run/upgrade flow behind a reference loaded only on that
  path. **Effort:** hours.

#### A30 — The duplication gate never scans `commands/` or `agents/` (19% of the runtime surface, including its largest file), skips same-file duplicates, and cannot see sub-threshold paraphrase — where nearly all real duplication found by this audit lives
`medium · C2 · Impact medium · Complexity S`
- **Location:** `scripts/duplication-check.mjs:34-46` (file set), `:88` (same-file skip);
  whole-paragraph 0.8-Jaccard threshold.
- **Why:** the brief asked what the checker misses; the answer is: every finding in A31.
- **Confidence:** verified. — **Measured against:** DESIGN §15.1; CONTRIBUTING's billing
  of it as the duplication gate. — **Sources:** panel:bloat-duplication.
- **Fix direction:** extend the file set; add sentence-level shingles; drop the same-file
  skip. **Effort:** hours.

#### A31 — Concepts with more than one owner (the criterion-2 inventory): eight rules restated 2–12 times each, all invisible to the checker
`medium · C2 · Impact medium · Complexity M (consolidation sweep)`
- **The inventory (each with the owner it contradicts by existing elsewhere):**
  - knob-wins-over-profile rule: owned by `references/config.md:12` ("stated only here"),
    restated ×3 inside `commands/cycle.md:124-126,198-201,206-210`, ×2 in README, ×1 in
    DESIGN §7.
  - standalone-runs contract (no cycle, no state file, no handoff): ~12 restatements
    across six command files and six skills' Standalone sections (e.g.
    `commands/doctor.md:2,18`, `skills/doctor/SKILL.md:143`).
  - config-knob documentation: a conceded three-way hand-kept copy
    (`CONTRIBUTING.md:91-94`; plugin.json userConfig, README table + byte-identical
    profile matrix at README:374-382, the owning skill) with no consistency check
    (`validate.mjs` checks key existence only).
  - short-path exemption rule: `references/delegation.md:147-152` owner, restated beside
    pointers in `fast-path:93-97` and `sweeping:249-253`.
  - per-commit branch re-check: `references/branch.md:29-34` owner ("none of them
    restate"), restated at `executing-waves:172` and twice in `sweeping:135-139,156-163`.
  - wave-formation invariants: `planning-waves:241` and `executing-waves:62-67`,
    near-identical.
  - state-file ownership check: near-verbatim in `cycle.md:31-37` and
    `continue.md:21-27` (both in commands/, entirely outside the checker's file set).
  - never-profile-conditional list: three near-verbatim copies (`config.md:64-67` owner,
    README:391-395, DESIGN:423-427 — minor wording drift already visible).
  - twin blocks across `fast-path`/`sweeping` (opening guardrails paragraph, verbatim
    "No review panel, no cross-model lens, no red-team" sentence, parallel State-file and
    Delegation sections), diluted below the checker's paragraph threshold.
- **Confidence:** verified (each instance read at the cited lines). — **Measured
  against:** DESIGN §15.1 one-owner convention. — **Sources:** panel:bloat-duplication
  (×9, folded).
- **Fix direction:** pointer-only consolidation per §15.1; A30's checker extension keeps
  it fixed. **Effort:** days (mechanical-sweep shaped).

#### A32 — DESIGN.md teaches a taxonomy 3 commands and 1 skill smaller than what ships
`medium · C2 · Impact medium · Complexity S`
- **Location:** `DESIGN.md:62-67` (§3) and `:324-325` (§13) list 5 of 8 commands —
  dream/distill/onboard absent; zero mentions of "dream" anywhere in the file.
- **Confidence:** verified. — **Measured against:** the shipped `commands/` and `skills/`
  trees. — **Sources:** panel:surface-taxonomy.
- **Fix direction:** update or explicitly scope DESIGN's inventory sections. **Effort:** hours.

#### A33 — Prose-density deletion-test failures: the artifact contracts hardest to execute are written as 14–17-line single sentences, and runtime skills carry changelog content
`medium · C2 · Impact medium · Complexity S`
- **Locations (each verified by reading):** `skills/dreaming-across-sessions/SKILL.md:195-211`
  (§Write-and-checkpoint: one ~13-line sentence with four nested em-dash digressions
  carrying the entire artifact contract — the brief's named example, confirmed) and
  `:36-49` (Plan-the-corpus: one 14-line paragraph mixing schema, budgeting, freshness,
  checkpoint); `:108-117` (release-notes-style history, deletion changes no behavior;
  self-seeding rationale stated twice at :132-134 and :187-189);
  `skills/reviewing-the-branch/SKILL.md:78-114` (37 lines for a round counter whose
  operative rule is 3 lines); rationale-only restatements at `references/evidence.md:84-88`,
  `references/delegation.md:95-98`, `references/handoff.md:91-97`.
- **Confidence:** verified. — **Measured against:** brief criterion 2's deletion test. —
  **Sources:** panel:bloat-duplication (×4, folded).
- **Fix direction:** rewrite the two artifact contracts as numbered steps; delete the
  rationale that changes no behavior. **Effort:** hours.

#### A34 — 78% of `tests/` (9,733 lines of scenario prose) is churn cost under a restructure: keyed to current skill names and exact pass-criteria, executed by nothing
`medium · C2 · Impact medium · Complexity L`
- **Location:** `tests/scenarios/` (57 files, 16 dirs) vs `tests/unit/` (2,814 lines,
  every deterministic script covered, runs in CI).
- **Why:** the brief's coverage-vs-churn split, answered: the unit layer survives intact;
  every renamed or merged skill orphans its scenario directory. (CI coverage of the
  scenario layer is A11's finding; this one is the restructure-cost classification.)
- **Confidence:** verified (line counts exact; sampled scenarios name a "Skill under
  test"). — **Measured against:** brief criterion 2. — **Sources:**
  panel:bloat-duplication, research map §5.
- **Fix direction:** decide per family before the restructure which scenarios are
  contracts worth porting and which are churn. **Effort:** planning-scope.

#### A35 — The improvement loop is open at both ends: doctor reports have no wired consumer, and nothing routes devcycle-improvement candidates home from a consumer repo
`medium · C5 · Impact medium · Complexity L (the restructure's stated gap)`
- **Location:** `skills/doctor/SKILL.md:104-105` (report written "for a later
  distilling-learnings run… to reference" — repo-wide grep finds no reader of
  `.devcycle/doctor/`; the dream's slice table has no doctor-report source);
  `scripts/dream.mjs:12,202,495` (dream/promotion/memory dirs all rooted in the current
  repo); no cross-repo store, issue channel, or promotion path exists.
- **Why:** precisely what is missing for the loop to feed devcycle's own improvement (the
  brief's criterion-5 question): a consumer for doctor's cost findings, and a transport
  for candidates whose target paths (`skills/*/SKILL.md`, `references/*.md`) exist only in
  the plugin repo. Every confirmed promotion to date targets this repo's own files.
- **Confidence:** verified (greps; benchmark promotion table). — **Measured against:**
  brief criterion 5. — **Sources:** panel:measurement (×2, folded).
- **Fix direction:** name the missing pieces explicitly in the restructure: a doctor→dream
  join (A9's run id) and a screened cross-repo/issue channel (A47 governs its risk).

#### A36 — `artifactFresh` skips "self" sessions at whole-session granularity, so a session mixing real work with one doctor run is never mined — and the skill then reports "fresh, nothing to do"
`medium · C5 · Impact medium · Complexity S`
- **Location:** `scripts/dream.mjs:134-138` (unconditional skip), `:307` (`SELF_SKILL_RE`
  includes `devcycle:doctor`), `:459` (self marked from a single matching record).
- **Confidence:** verified. — **Measured against:**
  `skills/dreaming-across-sessions/SKILL.md` stop-on-fresh rule. — **Sources:**
  panel:measurement.
- **Fix direction:** span-level rather than session-level self exclusion. **Effort:** hours.

#### A37 — The dreaming benchmark record cannot support the claims built on it: the precision improvement is self-reported against an adversarially-verified baseline, and the lean/thorough cost-staging promise has zero datapoints
`medium · C5/C6 · Impact medium · Complexity M (rerun with controls)`
- **Location:** second-run benchmark §self-report ("not independently re-verified by an
  adversarial pass") vs first-run Phase 3 (the 4/29 embellishment baseline *was* checked
  by four refuting subagents) — the two measurements are not comparable;
  `references/config.md:53` (profile matrix promises cost staging) vs both benchmarks'
  "Profile resolved: standard" — lean and thorough have never been measured, and the §10
  gate's threshold awaits a datapoint that does not exist.
- **Confidence:** verified (the record's own text). — **Measured against:** the first
  run's verification standard; the profile matrix's promise. — **Sources:**
  panel:measurement (×2, folded).
- **Fix direction:** re-verify precision adversarially each run; one lean and one
  thorough measured run before the matrix's cost claims are cited. **Effort:** one run each.

#### A38 — F4, F5, and the observation-validation entry (cited)
`medium · C5 · Impact medium`
- **Cited, classified, ranked — content not restated:**
  - **F4** (medium): corpus `totalBytes` overstates model-visible input ~34× — the
    budgeting number users are told to plan runs with. Rank: medium, S fix.
  - **F5** (medium): slice granularity permanently loses within-session growth — the flip
    side of cheap marginal runs. Rank: medium, M fix (slice ids need offsets/hashes).
  - **§ Observation files validated only on the happy path** (medium): an interrupted map
    dispatch — the exact failure the validation exists for — never reaches
    `--check-observations`; a truncated file counts as mined forever. Rank: medium, M fix
    (the entry itself notes the resume semantics must be reworded).
- **Sources:** docs/known-issues.md F4, F5, § Observation files.

#### A39 — Cache-state and price-vintage confounds sit uncontrolled inside every dollar figure, and the TTL fallback contradicts the code's own measurement two lines above it
`medium · C6 · Impact medium · Complexity S`
- **Location:** `scripts/doctor.mjs:83-86` (no-breakdown cache writes billed at the 5m
  rate 1.25× while the comment above records 39% of observed writes as 1h at 2.0× — a
  systematic underestimate correlated with transcript-format *date*, exactly the axis
  version cohorts are drawn along); `:90` (cache reads at 0.1× — identical work costs
  ~10–20× more or less with cache warmth, uncontrolled in any cohort);
  `scripts/pricing.mjs` (one "as of 2026-08-01" table repriced over all history,
  including an introductory price — totals are counterfactuals, not spend).
- **Confidence:** verified for the code paths; suspected for the magnitude on the
  historical deltas (no per-cohort cache-hit breakdown is emitted — see Caveat 2). —
  **Measured against:** the script's own comment; the cache multipliers it encodes. —
  **Sources:** C6-evidence F8, panel:measurement, cross-model B9/confound table.
- **Fix direction:** apply the measured TTL mix; emit per-cohort cache ratios; record
  price-table vintage per run. **Effort:** hours.

#### A40 — The "1.35B tokens of startup" headline is a causal heuristic whose unit is token·turns, mislabeled as tokens, with post-compaction regrowth double-counted
`medium · C6 · Impact medium · Complexity S`
- **Location:** `scripts/doctor.mjs:439-448` (`added × later / classes.length` — token
  delta × remaining-turn count, even-split causal attribution, no compaction detection),
  `:544` (labeled "carry-weighted tokens"); the 2026-08-03 report ranks content classes
  by it.
- **Why:** the three headline figures (startup 1.35B / Bash 1.13B / Read 0.98B) are
  internally rankable but are not token counts, are not comparable to any other number in
  the report, and cannot be converted to dollars; a reader overstates by roughly the mean
  remaining-turn count.
- **Confidence:** verified (arithmetic). — **Measured against:** the report's Finding 7
  usage. — **Sources:** panel:measurement, cross-model B8.
- **Fix direction:** either label and document the unit or report unweighted deltas.
  **Effort:** hours.

#### A41 — Windowed and unwindowed doctor runs are silently incomparable: a `--since` cut re-buckets attributed cost to `unattributed` and turns "startup floor" into a mid-session depth — and the human report never records the window
`medium · C6 · Impact medium · Complexity S`
- **Location:** `scripts/doctor.mjs:637-643` (records filtered before summarize),
  `:437-438` (floor from `seq[0]` of the windowed set, which `emitCandidates:230`
  compares depths against at 3×); `:528-561` (no window line in the human output —
  only `--json` carries it).
- **What's wrong:** executed both ways on an identical fixture corpus: the same tokens
  moved buckets between the full and windowed runs. Windowing by date is the natural way
  to compare releases; it silently changes attribution, confounding the comparison it
  exists to make. Both real dreaming benchmarks used `--since`.
- **Confidence:** verified (both outputs captured). — **Measured against:** the two
  captured runs; `commands/doctor.md:13`. — **Sources:** C6-evidence F6,
  panel:measurement, cross-model B10.
- **Fix direction:** attribute before windowing; print the window in every report.
  **Effort:** hours.

#### A42 — The measuring session is inside its own corpus: doctor has no self-exclusion, though `dream.mjs` solved the identical problem
`medium · C6 · Impact medium · Complexity S`
- **Location:** `scripts/doctor.mjs:636-644` (`run()` — no self-exclusion;
  `CLAUDE_CODE_SESSION_ID` consulted only in the `--depth` branch at :129-131); real
  corpus records tagged `devcycle:doctor` confirm doctor sessions qualify via
  `isDevcycleSession`. Contrast `scripts/dream.mjs:307` (`SELF_SKILL_RE`).
- **Why:** the corpus inflates monotonically with each measurement, the observation cost
  lands on the observing skill's own stage, and two consecutive runs over "the same
  history" differ without saying so. A known-missing control, not a design choice.
- **Confidence:** verified. — **Measured against:** dream.mjs's own precedent; the
  benchmark's self-measurement caveat. — **Sources:** C6-evidence F7, panel:measurement,
  cross-model B11.
- **Fix direction:** adopt the dream exclusion (span-level per A36). **Effort:** hours.

#### A43 — The 2026-08-03 report labels inferred numbers "verified", and not one number in it carries an error bar — for the per-stage and per-cohort figures none *can* under the current design
`medium · C6 · Impact medium · Complexity M`
- **Location:** `.devcycle/doctor/2026-08-03-report.md` (findings 2/3/5 "Confidence:
  verified" over n=2–6 regex-labeled cohorts and heuristic attribution);
  `skills/doctor/SKILL.md` (mandates carrying two disclosures, mandates no uncertainty
  quantification).
- **What's wrong:** the number-by-number classification (both evidence passes,
  independently): every `$` and every `%` in the report is inferred (price model +
  attribution rule + thresholds); only turn counts, token depths, tool/model/dispatch
  counts are measured. "Verified" is true of the arithmetic, not of the causal claims;
  the report also does not record which script version or attribution rule produced it,
  so its splits are not reproducible by the current script.
- **Confidence:** verified (the report text vs the executed evidence is a direct
  comparison). — **Measured against:** the brief's own rule — a number that cannot carry
  an error bar is a finding; `references/findings.md`'s confidence vocabulary. —
  **Sources:** C6-evidence F9/§6, cross-model B.5.
- **If unaddressed:** the restructure cites these as measurements; the confidence
  vocabulary itself becomes unreadable (a "verified" that means "the addition was
  correct").
- **Fix direction:** re-emit the report with measured/inferred labels per number; bars
  where computable, "no bar possible" where not. **Effort:** a rerun plus template edits.

#### A44 — Spec compliance has two owners in one stage, one of them the orchestrator doing review work its own delegation contract assigns to a dispatch
`medium · C3/C4 · Impact medium · Complexity S`
- **Location:** `skills/reviewing-the-branch/SKILL.md:60-74` (coordinator itself reads
  the spec and checks every requirement — no dispatch language) vs
  `references/delegation.md:7-27` (closed coordinator-duty list) and
  `skills/reviewing-code/SKILL.md:40,102-107` (the spec lens already performs this from
  the same specPath).
- **Confidence:** verified. — **Measured against:** delegation.md's closed list. —
  **Sources:** panel:layering-loops-dispatch.
- **Fix direction:** one owner — the engine's spec lens; the coordinator consumes its
  findings. **Effort:** hours.

#### A45 — `graphify-out/` (and `docs/overhaul/`) are untracked but not gitignored, and four graphify files carry the operator's real home path: one `git add -A` from staging, with the pre-push gate only catching the macOS-form subset
`medium · C8 · Impact medium · Complexity S (2 gitignore lines)`
- **Location:** `.gitignore` (no `graphify-out/` entry; `git check-ignore` returns
  nothing); `graphify-out/.graphify_root`, `.graphify_python`, `graph.html`,
  `cache/stat-index.json` (real username home paths + filesystem mtimes);
  `docs/overhaul/` likewise untracked-not-ignored (scanned clean).
- **Why:** the gate would catch these *only because* they happen to be macOS-form and
  *only* in CI after push (no pre-commit hook — the path is published to the remote
  before any gate objects); a Linux operator's equivalents sail through entirely (A1).
- **Confidence:** verified. — **Measured against:** brief criterion 8 (committable
  content check). — **Sources:** C8-evidence F4, panel:enforcement-leaks-ci.
- **Fix direction:** gitignore both; add a pre-push local check. **Effort:** minutes.

#### A46 — Excerpt-carrying artifact families are contained by a single `.gitignore` line with no content-level defense behind it, and the one committable family's "screened for secrets" claim is backed by model judgment alone
`medium · C8 · Impact medium · Complexity M`
- **Location:** `.gitignore:4` (`.devcycle/` — the only thing standing between the
  excerpt-dense dream artifacts and evidence captures and the public repo; those files
  contain verbatim quoted session lines and a session-dir id, and would pass
  `redaction-check.mjs` verbatim per A1's class-e proof);
  `docs/devcycle/promotions/README.md:25` (tracked family: "screened for secrets before…
  written" — but `recordPromotion`, `scripts/dream.mjs:243-268`, does structural
  validation only; the screen is a prose step in the skill). The 41 tracked promotion
  records scanned clean today.
- **Why:** the brief's named most-likely leak vector is the quoted excerpt; its entire
  defense is one ignore line plus in-session judgment.
- **Confidence:** verified. — **Measured against:** brief criterion 8. — **Sources:**
  C8-evidence F5, panel:enforcement-leaks-ci.
- **Fix direction:** a content-level screen on the write path of every excerpt-derived
  artifact, not only at commit time. **Effort:** days.

#### A47 — The three forward-looking surfaces would reuse today's hollow gate: run records and Loop B issues carry session ids by design, and the design's "same screening as a commit" is exactly the screen A1 defeats
`medium · C8 · Impact high · Complexity M · Confidence: suspected (design-time)`
- **Location:** `docs/overhaul/02-cycle-request.md` §E/§F (untracked design input).
- **What's wrong:** per-run records mandate session id + timestamp bounds as the join key
  — itself correlatable to a user's local project directory, and a class today's gate
  passes (A1 class b). The cross-repo store would aggregate private client-repo names,
  paths, and task descriptions across contexts — the highest-value target in the design,
  with location/retention undefined. Loop B files issue bodies against the *public* repo;
  the design says every body "passes the same screening as a commit" — which currently
  passes session ids, internal URLs, and excerpts. This is the sharpest forward risk.
- **Measured against:** brief criterion 8's forward-looking mandate; A1's executed class
  results. — **Sources:** C8-evidence §forward (analysis only — no code exists yet).
- **Fix direction:** the restructure must treat A1's class detectors as a prerequisite
  for any of the three surfaces, and keep the cross-repo store out of committable trees.

#### A48 — The branch-protection closure lives only in live GitHub API state: nothing in the repo re-creates it, and nothing would notice if it were removed
`medium · C9 · Impact medium · Complexity S`
- **Location:** GitHub ruleset config (not a tracked file); no CI/script references it.
- **Confidence:** verified. — **Measured against:** the repo's own everything-as-code
  convention. — **Sources:** C9-evidence F2.
- **Fix direction:** commit the ruleset definition (exported JSON + a CI assertion that
  live state matches). **Effort:** hours.

#### A49 — A compromised or malformed release-path run can push arbitrary commits to unprotected `dev`, move tags, and publish arbitrary release bodies
`medium · C9 · Impact medium · Complexity S`
- **Location:** `.github/workflows/bump-version.yml:16-17` (`contents: write`, persisted
  checkout token, runs repository code); `prepare-release.yml` (pushes to `dev` — which
  no ruleset covers — and opens PRs). Contained *from `main`* by A5's ruleset; the
  ephemeral `GITHUB_TOKEN` (no long-lived PAT anywhere) is a confirmed positive.
- **Confidence:** verified. — **Measured against:** brief criterion 9 blast-radius
  question. — **Sources:** panel:enforcement-leaks-ci, C9-evidence §4.
- **Fix direction:** a `dev` ruleset; environment protection on the release job.
  **Effort:** hours.

#### A50 — A PR title edited after the last push is never re-checked, so a non-conventional squash subject merges with green checks
`medium · C9 · Impact low · Complexity S`
- **Location:** `.github/workflows/validate.yml:3` (bare `pull_request:` — no `edited`
  type), `:30-42` (`pr-title` reads the event payload).
- **Why:** the squash subject is what version tooling parses; this contradicts
  CONTRIBUTING's "a malformed title fails CI".
- **Confidence:** verified. — **Measured against:** `CONTRIBUTING.md:96-104`. —
  **Sources:** panel:enforcement-leaks-ci.
- **Fix direction:** add `edited` to the trigger types. **Effort:** one line.

#### A51 — No job in any workflow sets a timeout, and Node plus the runner image are unpinned everywhere
`medium · C9 · Impact low · Complexity S`
- **Location:** all jobs in `validate.yml`, `bump-version.yml`, `prepare-release.yml`
  (grep: zero `timeout` hits — GitHub's 6-hour default applies; the riskiest step is
  prepare-release's network-dependent push-retry loop); no `setup-node`, no `.nvmrc`, no
  `package.json` at all (which also means no npm step — a confirmed reliability
  positive); `runs-on: ubuntu-latest` throughout. Real nondeterminism on record: two
  Release-path push-race failures (2026-07-23, exit 128 / failed push), since mitigated
  by the retry loop.
- **Confidence:** verified (grep + captured run history); which Node version past runs
  used is not recoverable (Caveat 2). — **Measured against:** brief criterion 9
  reliability list. — **Sources:** C9-evidence F9/F10/F11, panel:enforcement-leaks-ci (folded).
- **Fix direction:** `timeout-minutes` per job; pin the image and add `setup-node` with a
  pinned major. **Effort:** hours.

#### A52 — README still carries doctor's known-false scope claim after the command doc was corrected
`medium · C1/C2 · Impact medium · Complexity S`
- **Location:** `README.md:321` ("for this session, a date window, or the whole
  transcript history") — the 2026-08-03 report's Finding 9 established the no-arg path
  scans every devcycle-tagged transcript (111 sessions when one was asked for);
  `commands/doctor.md:11` was fixed, the more-read document was not.
- **Confidence:** verified. — **Measured against:** the report's Finding 9; the corrected
  command doc. — **Sources:** cross-model A8.
- **Fix direction:** align README:321 with commands/doctor.md:11. **Effort:** minutes.

#### A53 — `superpowers:brainstorming`'s imperative trigger out-competes `scoping-interview` on the exact intent devcycle needs scoped first
`medium · C1 · Impact medium · Complexity S · Confidence: suspected`
- **Location:** `skills/scoping-interview/SKILL.md:3` (descriptive trigger) vs the
  upstream description's "You MUST use this before any creative work…";
  `commands/cycle.md:329,346-355` (devcycle's order is scoping → brainstorm, delegating
  brainstorm upstream); `.claude-plugin/plugin.json` declares superpowers a dependency,
  so the interaction is inside devcycle's blast radius.
- **Why suspected:** the string asymmetry is verified; the probabilistic selection
  outcome is not (Caveat 2).
- **Measured against:** both descriptions; the declared dependency. — **Sources:**
  cross-model A9.
- **Fix direction:** scope-interview's trigger must state its precedence explicitly.

#### A54 — Whether direct stage-skill entry bypasses cycle Step 0's binding state-file creation is contested between the two models and unresolved for `fast-path`/`sweeping`
`medium · C1/C3 · Impact medium · Complexity S · Confidence: suspected`
- **The dispute:** the cross-model pass asserts direct invocation of `fast-path` or
  `sweeping-mechanical-changes` skips Step 0 (state file, "FIRST action, binding"),
  breaking resumability for that run. The panel's adversarial verifier *refuted* the same
  claim at `skills/scoping-interview/SKILL.md:41-50`, which has a stage-entry backstop
  that creates the state file when entered outside Step 0. Whether the two short-path
  skills carry an equivalent backstop was not established by either side.
- **Measured against:** `commands/cycle.md` Step 0; the scoping-interview backstop. —
  **Sources:** cross-model A3 vs panel:surface-taxonomy (unverified entry). See the
  disagreement section.
- **Fix direction:** verify per skill; add the backstop wherever missing. **Effort:** hours.

### Low

#### A55 — F6 (cited): observation filenames are never validated against the manifest
`low · C5` — `docs/known-issues.md` **F6**: rank low per its entry; S fix (validate the
written filename against the slice id). Content not restated. — **Sources:**
docs/known-issues.md F6.

#### A56 — Ledger timestamps are non-monotonic against file order, so any consumer ordering events by clock mis-derives a task's last event
`low · C3` — `.devcycle/ledger.md:89,158` (both inversions confirmed; the branch block
wall-clock-overlaps the execution stage). The line-count mechanisms happen to be
order-robust; the audit trail's clock is not. — **Measured against:** executing-waves'
resume rows. — **Sources:** panel:layering-loops-dispatch. Fix: derive order from file
position only; say so. **Effort:** minutes.

#### A57 — Distill's memory intake has two owners in one run with unspecified interaction
`low · C5` — `skills/distilling-learnings/SKILL.md:34-38` (dream candidates "replace raw
1:1 memory entries") vs `:44-46` (step 1 still unconditionally reads accumulated
memories); the same fact can arrive through both paths with no stated dedup. —
**Sources:** panel:measurement. Fix: state the precedence. **Effort:** minutes.

#### A58 — Most dispatch shapes are ad-hoc inline prompts re-sent on every run; only three are typed agents (the criterion-4 enumeration)
`low · C4` — Enumerated: typed — `implementer`, `task-reviewer`, `red-team-reviewer`
(scoped `tools:` allowlists, no `model:` frontmatter anywhere — session-tier by
default, correct post the removed-pin incident). Ad-hoc — the dreaming map (one per
slice) and reduce dispatches (`skills/dreaming-across-sessions/SKILL.md:53-125`),
research dispatches (`references/delegation.md:60-91`, the single canonical owner —
correctly pointed at, not restated, by its three consumers), panel
lens/verifier/reconciler prompts (`workflows/review-panel.js`), sweep editor prompts
(`workflows/mechanical-sweep.js`), checklist walkers. The red-team charter splice into
panel verifiers is the sole reuse of a typed definition by an ad-hoc shape. Each ad-hoc
prompt is a recurring per-run token cost with no single owner. — **Measured against:**
brief criterion 4; delegation.md. — **Sources:** panel:layering-loops-dispatch, research
map §7. Fix direction: type the recurring shapes (map/reduce, lens) as agents. **Effort:** days.

#### A59 — The brief's 20,436-line docs headline is ~8× overstated: 18,494 lines are a gitignored local mirror; the committed docs payload is ~2,400 lines, mostly live or append-only record
`low · C2 (informational)` — `docs/superpowers/` (gitignored, local-only comparison
material) dominates the count; committed docs split: live-adjacent
(`known-issues.md` 104, `platform-notes.md` 209) vs historical/append-only
(`DECISIONS.md` 706, `docs/comparisons/` 654, promotions ~290). The real live contract
is `README.md`/`DESIGN.md`/`CONTRIBUTING.md` at root. Also note the brief's 4,334-line
runtime figure excludes `workflows/` (895 lines): the loadable surface is 5,229 lines. —
**Sources:** panel:bloat-duplication, research map §2/§4. No fix; recalibrates the
restructure's docs scope.

#### A60 — The description budget is 87% consumed and allocated inversely to centrality
`low · C1/C2` — Measured: 5,207 of 6,000 hard-budget chars (`scripts/validate.mjs:7-8`)
across 22 surfaces; the four longest trigger strings belong to standalone side tools
(three of which say they should never be auto-selected), while `cycle` gets 138 chars and
`continue` 92. Trigger length is routing weight; any restructure adding a surface must
reclaim characters first. — **Sources:** cross-model A10. Fix direction: reallocate
during the restructure. **Effort:** hours.

#### A61 — Assorted CI hardening deviations (folded)
`low · C9` — Each verified: `validate.yml:21` checkout leaves `persist-credentials` at
default `true` in a read-only job; `bump-version.yml:19`'s pin comment says `# v5` for a
sha that is actually v7.0.1 (the pin itself is correct and identical across all three
workflows — confirmed against upstream tags); the repo-level "require sha-pinned
actions" setting is off (pins are convention-only); `prepare-release.yml:32` interpolates
`github.ref_name` directly into a run script while the same file passes other inputs via
env (injection-shaped, reachable only by write-access dispatchers);
`required_approving_review_count: 0` on the main ruleset (expected for a
single-maintainer repo; the PR gate guarantees CI ran, not review). Confirmed positives,
per the brief's confirm-don't-assume instruction: all `uses:` pinned to full shas;
top-level `permissions: contents: read` with per-job escalation; `concurrency` groups in
all three workflows; no long-lived PAT; no npm/network install step. — **Sources:**
C9-evidence F12-F15/§6, panel:enforcement-leaks-ci (folded). **Effort:** hours total.

#### A62 — Graph-first orientation is encoded for consumer repos but explicitly carved out for devcycle's own repo, so dogfooding runs orient by file reading
`low · C2/C3` — `references/delegation.md:69-72`: research dispatches use a graph when
the target repo has one — "(never this plugin's own repo)". When the target repo *is*
this repo (every dogfooding cycle, this audit), the carve-out forbids the graph that
exists here, contradicting the brief's standing rule that graph orientation is not
audit-specific. — **Confidence:** verified (grep + read). — **Measured against:** the
brief's standing rule ("if the audit finds devcycle does not encode it for its own
stages, that is itself a finding"). — **Sources:** this synthesis (grep-verified);
research map used the graph manually. Fix direction: scope the carve-out to the
installed-plugin directory, not to the repo when it is itself the target. **Effort:** minutes.

---

## Criterion-1 deliverable: intent → entry-point routing table

Merged from the panel's surface-taxonomy lens and the cross-model routing table. Where
the two sources differ, both readings are kept and the cell is marked ◐ (see the
disagreement section, D7). "Newcomer guess" = a user who has read only the slash-command
menu and skill roster. Ambiguous cells are the defects; each cites its finding.

| # | Intent | Correct entry point | Newcomer would guess | Also plausibly fires | Verdict |
|---|---|---|---|---|---|
| 1 | "Build feature X" | `/devcycle:cycle` | `/devcycle:cycle` | `superpowers:brainstorming`, `scoping-interview` | AMBIGUOUS (A53) |
| 2 | "Fix this bug" | `/devcycle:cycle` | `/devcycle:cycle` | `superpowers:systematic-debugging`, `fast-path` | AMBIGUOUS |
| 3 | "Fix this typo" | `/devcycle:cycle` (triage → fast path) | `fast-path` directly | skips triage + possibly Step 0 | AMBIGUOUS, wrong default (A15, A54) |
| 4 | "Rename X across 40 files" | `/devcycle:cycle` (triage → sweep) | `sweeping-mechanical-changes` directly | skips the blast-radius gate | AMBIGUOUS, wrong default (A15, A54) |
| 5 | "Resume after /clear" | `/devcycle:continue` | `executing-waves` (its trigger advertises this) | — | AMBIGUOUS, wrong default (A4) |
| 6 | "Audit this repo for security" | `/devcycle:audit security` | `/devcycle:audit` | `auditing-a-repo`, `reviewing-code` | AMBIGUOUS ◐ |
| 7 | "Review my branch before merge" | `/devcycle:audit branch:<name>` | `reviewing-the-branch` or `reviewing-code` | `/devcycle:verify` | AMBIGUOUS, answer unguessable (A25) ◐ |
| 8 | "Review this PR's code quality" | `/devcycle:audit branch:<name>` | `reviewing-code` | `reviewing-the-branch`, `auditing-a-repo` | AMBIGUOUS, answer unguessable (A25) ◐ |
| 9 | "Check my branch's UI works" | `/devcycle:verify <branch>` | either | `verifying-on-device` (no branch guard) | AMBIGUOUS (A27) |
| 10 | "Walk the on-device checklist" | skill if in-cycle; command if not | either | the skill's description names both modes | AMBIGUOUS by construction (A27) |
| 11 | "Why is devcycle so expensive?" | `/devcycle:doctor` | `/devcycle:doctor` | skill `doctor` unreachable (A14); third-party token skills | AMBIGUOUS (cross-plugin) |
| 12 | "Am I about to blow my context?" | `/devcycle:doctor --depth` | same | none | **CLEAR** |
| 13 | "Is my devcycle config stale?" | `/devcycle:doctor drift <path>` | `/devcycle:doctor` | `/devcycle:distill` also runs a drift check | AMBIGUOUS |
| 14 | "Turn what we learned into rules" | `/devcycle:distill` | `/devcycle:distill` | `/devcycle:dream`, both skills — 4-way | AMBIGUOUS (A26) |
| 15 | "Find recurring patterns in sessions" | `/devcycle:dream` | `/devcycle:dream` | `/devcycle:distill` (runs the dream as step 0), the skill | AMBIGUOUS + double-paid mining (A26) |
| 16 | "Set devcycle up in this repo" | `/devcycle:onboard` | `/devcycle:onboard` | `onboarding-a-repo` (unguarded, A3), global bootstrap skills | AMBIGUOUS |
| 17 | "Plan this into waves" | `planning-waves` (in-cycle only) | `planning-waves` | `superpowers:writing-plans` | AMBIGUOUS |
| 18 | "Scope this vague ticket" | `/devcycle:cycle` → scoping | `scoping-interview` | `superpowers:brainstorming` | AMBIGUOUS (A53) |
| 19 | "Ship it / open the PR" | `finishing-the-cycle` (in-cycle only) | same | `superpowers:finishing-a-development-branch` | AMBIGUOUS |
| 20 | "Approved spec, just build it" | `/devcycle:cycle` (triage → planning) | `planning-waves` | `executing-waves` | AMBIGUOUS |
| 21 | "Two cycles in flight — resume the *other* one" | — | `/devcycle:continue` | none: one fixed state slot | **NO ENTRY POINT** (A28) |
| 22 | "Review the code you just wrote in this session" | — | `reviewing-code` | branch review needs a plan; audit needs a committed branch | **NO ENTRY POINT** (A25) |

Cross-model score: 19 of 22 ambiguous, 2 with no entry point, 1 clean — and the one clean
cell is clean because it is a *flag on a command*, not a named surface. ◐-marked cells:
the panel's adversarial verifier found the three review-descriptions carry disambiguators
the cross-model table's truncated quotes omit (D7) — both readings retained.

**The four confusable pairs, resolved (what a newcomer would guess):**

- **`audit` / `review`** — truth: `/devcycle:audit` is the only user entry for both, and
  `branch:<name>` is what makes it a branch review; `reviewing-the-branch` is a pipeline
  gate presupposing a completed plan; `reviewing-code` is the engine both call. A newcomer
  guesses one of the two review-named skills — both wrong. Three surfaces carry "review"
  in the name and none is the answer to "review my branch"; the answer is spelled "audit".
  The worst naming inversion in the plugin (A25).
- **`dream` / `distill` / `distilling-learnings`** — truth: distill is a strict superset
  (the dream is its step 0). A newcomer guesses they are alternatives — neither
  description mentions the other, the command doc omits the subsumption, and README
  contradicts the command doc — and runs both, paying the mining pass twice (A26).
- **`verify` / `verifying-on-device`** — truth: same engine; the command exists to supply
  the standalone-ness and the branch, with a refuse-to-guess guard. A newcomer guesses at
  random; the skill path *is* the guessing path the command prevents (A27).
- **`cycle` / `continue`** — truth: correctly separated, and cycle.md handles the
  in-flight collision well. But `continue` is the guarded one while `executing-waves`
  advertises resume, so any non-slash phrasing routes around every check continue owns
  (A4). The pair is fine; its exposure inverts it.

---

## Cross-model disagreement report (criteria 1 and 6)

The independent Opus 5 pass and the panel + evidence dispatches disagreed as follows.
Reported, not resolved.

1. **Opus-only discovery, missed by the panel and the C6 evidence dispatch:** the
   2026-08-03 report's #1 finding describes the `unattributed` mechanism backwards and
   its recommended fix already shipped (A8). Both harnesses' executions *corroborate* the
   direction Opus claims; neither other source had checked the report's text against it.
2. **Opus-only discovery on criterion 1:** the `doctor` skill is unreachable via the
   command/skill namespace collision, verified against a live roster (A14). The panel saw
   only a low-severity naming-convention issue at the same location.
3. **Severity, no-run-identity (A9):** Opus critical ("no dollar devcycle has published
   is a measurement") vs panel and C6-evidence high. Listed high per the severity
   vocabulary; the Opus reading is retained here.
4. **Severity, cohort-of-one regressions (A13):** Opus critical vs panel medium — a
   two-tier gap on the same defect. Listed high (split the difference is *not* the rule;
   the high rating follows from "broken behavior" applying to the flagship signal).
5. **Direct contradiction — is unguarded `/devcycle:cycle` a defect?** Opus flags it
   (guard applied inversely to consequence: cycle creates branches, dispatches writers,
   can push). The panel's verification of the adjacent finding cites DESIGN §4 amendment
   4, which *sanctions* `/cycle` as the intentional exception. One model calls it a
   design bug, the other a design decision. Not listed as a finding; recorded here.
6. **Direct contradiction — Step 0 bypass (A54):** Opus asserts direct skill entry skips
   the binding state-file creation; the panel's adversarial verifier refuted this at
   scoping-interview (a stage-entry backstop exists) and the panel's own lens claim was
   marked unverified. Unresolved for `fast-path`/`sweeping-mechanical-changes`.
7. **Extent of routing ambiguity:** Opus scores 19/22 intents ambiguous; the panel's
   verifier, checking the overlapping-trigger claims, found the three review-skill
   descriptions carry disambiguating clauses ("invoked by other skills…", "triage has
   confirmed…") that make model selection more determined than the truncated quotes
   suggest — while the panel's *own* confirmed findings (A15) hold that those clauses are
   unenforceable prose. Both positions are in the table (◐ cells).
8. **Primary driver of the 59% unattributed bucket:** the C6 evidence dispatch names
   untagged subagent transcripts "the single largest identified mechanism" (68% of
   subagent turns untagged); Opus names whole-session recruitment of non-devcycle work.
   Both mechanisms are execution-verified; their relative magnitude is not computable
   from the report (Caveat 2). A8 carries both.
9. **One-sided claims (each unrebutted by the other side):** Opus alone found the
   token·turns unit error (A40's unit component), the brainstorming trigger competition
   (A53), the description-budget inversion (A60), and the sidechain `agentId` fill-key
   leak (folded into A7); the C6 evidence dispatch alone executed the window re-bucketing
   comparison (A41) and the retry double-count (A17); the panel alone produced the
   duplication, loop-termination, and CI findings outside Opus's two-criteria charter
   (not a disagreement — different scope — but noted so absence is not read as dissent).

**Count: 9 disagreement items** (2 missed-discovery, 2 severity, 2 direct contradictions,
1 extent dispute, 1 competing-mechanism dispute, 1 one-sided-claims roll-up).

---

## Coverage statement

**Read in full / executed against:**
- The entire runtime surface — `commands/` (8), `skills/` (14), `references/` (12),
  `agents/` (3), `workflows/` (2) — by the panel's five lenses over 60 files, with
  adversarial verification of all 75 raw findings.
- `scripts/` — doctor.mjs, dream.mjs, redaction-check.mjs, duplication-check.mjs,
  validate.mjs, pricing.mjs, bump-version.mjs — read line-by-line where cited, and
  *executed*: doctor against 9 synthetic fixture sessions plus a second independent
  export-level harness; redaction-check against per-class bypass fixtures; gitleaks over
  full history (268 commits).
- `.github/` workflows plus the live GitHub state (rulesets, actions permissions, run
  history and failed-job logs via `gh`).
- The measurement record: the 2026-08-03 doctor report (number-by-number, twice
  independently), both dreaming benchmark files, `benchmark-17-measurements.md`,
  `.devcycle/` ledger/state/findings for the verdict question.
- `docs/known-issues.md` (all entries classified), `README.md`, `DESIGN.md`,
  `CONTRIBUTING.md`, `docs/devcycle/promotions/` (all 41 files scanned for leak classes).
- Git history for criterion 8 (all refs, path/credential/UUID classes).

**Skimmed or sampled only, with reasons:**
- `docs/superpowers/` (18,494 lines): counted and classified only — gitignored local
  mirror of upstream comparison material, shipped to no user (A59).
- `tests/scenarios/` (9,733 lines, 57 files): inventoried and sampled for structure;
  not read in full — prose specs executed by nothing (A11, A34), audited as a class.
- `docs/DECISIONS.md` (706 lines): consulted for the precedents findings cite
  (one-owner, profile-matrix pointer, archiving); not audited line-by-line — the brief
  scopes it as the record the restructure must not reverse, not an audit target.
- `docs/comparisons/` (654 lines): classified as historical record only.
- `.devcycle/` dream artifacts and evidence captures: scanned structurally for leak
  classes; per-line sensitivity of individual quoted excerpts deliberately not judged
  (their risk is containment-structural, A46).
- The real transcript corpus (84 session files, 469 subagent files): probed read-only by
  scan for tag rates, uuid duplication, and record shapes to ground fixture design;
  transcripts were not read as content.
- `scripts/dream.mjs` beyond the cited functions: covered via known-issues F1–F6 and the
  panel's measurement lens rather than a fresh line-by-line pass — the known-issues
  entries pre-locate the causes.

**Not used:** live web sourcing — measured-against sources are repo conventions, the
brief, and two named externals only (semver ordering; the GitHub Actions security
hardening guidance already cited by the repo's own CI conventions). The graphify graph
(built at this same commit) was used for orientation by the research-map dispatch;
structural claims were confirmed against the working tree, and the graph was not rebuilt.
Thin areas flagged by sources: the panel marked 4 of 75 findings unverifiable (three
retired here after refutation, one carried as A54); the C6 dispatch could not
re-summarize the 111-session historical corpus without changing its scope (Caveat 2).
