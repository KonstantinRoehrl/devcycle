# Changelog

## 0.17.2 — 2026-08-28

- fix(workload): make doctor missing-workload collection progressive and audit-safe (#139)

## Unreleased

- fix(doctor): collect workload progressively via a commit-sensor hook (#139)

**Progressive workload collection (#139).** A new `PostToolUse(Bash)` hook,
`hooks/workload-sensor.mjs`, re-derives each run's `workload` record from `.devcycle/state.md` and
git on every commit in an active cycle, replacing the single finish-stage write that only fired when
the finish stage was reached. The finish-stage append is kept as a belt-and-suspenders final
refresh, harmless because the last-wins join collapses it onto what the sensor already wrote.
`scripts/doctor.mjs` now parses the commit and triage run-record lines and flags a committed cycle
that recorded no workload — never an audit-only or no-commit cycle, where a missing record stays
*workload-unknown*.

## 0.17.1 — 2026-08-27

- fix(config): use manifest type "number" so the plugin loads on update

**Patch — 0.17.0 could not load on update.** The 0.17.0 manifest declared
`userConfig.learnStalenessSessions` and `learnStalenessDays` with type `"integer"`, which
Claude Code's manifest validator rejects (it allows only `string` | `number` | `boolean` |
`directory` | `file`), so the plugin failed to load for anyone who updated. Both knobs are now
typed `"number"`. `scripts/validate.mjs` is hardened to reject any `userConfig` type outside the
allowed set, so an out-of-range type is caught in CI rather than at plugin-load time.

## 0.17.0 — 2026-08-27

- feat(devcycle): add the reconcile command and harden the learn/doctor loop

**`/devcycle:reconcile` (#132).** A new command surface plus the `receiving-review` playbook —
a stage that triages, fixes, and replies to PR review comments, backed by
`scripts/pr-review-intake.mjs`. Resolved-thread lookups correlate to REST ids rather than
guessing from position.

**Learning/doctor loop hardening (#133).** Eight items across four dependency-ordered waves,
per `docs/audits/2026-08-26-learning-doctor-loop-audit.md`:

- **#103** — script-stamp all three coordinator-written timestamps from the system clock
  instead of estimating them.
- **#104** — canonicalize the run-record toplevel across worktrees so a worktree cycle's
  records stop splitting across two repo slugs.
- **#127** — normalize "direction of travel" for profile/turn-count and stop anchoring on an
  n<3 cohort.
- **#128** — carry a session count on compliance candidates, matching version-regression
  candidates in the same report.
- **L1** — add a staleness nudge for `/devcycle:learn` (5 unmined sessions or 14 days,
  whichever comes first; configurable per repo).
- **L2** — add a `win` observation kind so the miner can file successes, not only culprits,
  with journal-reinforcement verification.
- **D1** — cite the changelog when explaining a non-promotion regression.
- **D2** — attribute and action detected wins in the doctor report.

## 0.16.1 — 2026-08-26

- fix(resume): find a gitignored .devcycle/state.md on first resume

## 0.16.0 — 2026-08-23

- feat(maintain): add read-only repo maintenance command (Phases 1-4)

Adds `/devcycle:maintain`, a read-only repo-maintenance avenue: an eighth command that assesses
a repo against today's quality criteria and stops — it never starts a cycle. Shipped in four
phases, each independently gated and merged (#120, #121, #123, #124).

**Phase 1 — command surface + reuse wiring.** `commands/maintain.md`, a routing entry
disambiguated from the other seven commands with its own scenario test, and
`playbooks/maintaining-the-repo.md` wrapping the existing review engine rather than a second one.

**Phase 2 — longitudinal lenses, graph-first orientation, gated depth.** An `abstraction`
review-charter lens judging whether existing complexity still earns its keep, a `history-inspector`
agent reading git history read-only, graph-first orientation with a deterministic pre-pass and
hotspot-scoped `--match`, a profile-gated depth ladder, and enforced fan-out ceilings (≤5 lenses /
≤6 dispatches, hard-stop at 20% depth).

**Phase 3 — GitHub issues as a second input.** `scripts/issue-intake.mjs` folds a repo's own open
issues into the same ranked-findings pipeline the lenses feed: decompose-before-classify (a bundled
issue splits into independently-true-or-false fragments), `[culprit:]`/`[doctor:]`-titled issues
excluded before decomposition, third-party text screened via redaction, and an `Origin` field
(`lens` / `github-issue #<n>`) that's provenance-only and never affects rank. Strictly read-only —
no `close`/`comment`/`edit`/`label` call anywhere in the code path, enforced as a code invariant.

**Phase 4 — persistence across runs.** Findings from both lenses and issues now persist in
`docs/devcycle/maintenance-findings/`, tracked per `docTrackingPolicy`, with lifecycle derived from
pass re-detection: `new` → `persisting` → `resolved`, or `regressed` on reappearance. A repo-local
identity scheme (known limitation: not resilient to a file rename between passes, verified to fail
loud rather than silently, not solved in v1) backs a `verifyMaintenance` sibling of the existing
`verify()`, a `lens-cost` run-record kind rolling per-lens spend into `doctor`'s workload-independent
cost views, and `--match` extended so a file with a persisting finding surfaces it on
`/devcycle:review`.

**Deliberately out of scope for v1:** a content-based identity scheme resilient to renames, and
charter-upgrading the five pre-existing quality-criteria lenses (dead-code, test-health,
architecture, docs, dependency) — gated on real-use evidence that their current charters
under-carry, not queued by default.

## 0.15.0 — 2026-08-21

- feat(doctor): trustworthy version-scoped candidates and workload-adjusted cost comparison

Makes `doctor`'s version and cost reporting trustworthy at face value, closing two issues where
the comparison methodology produced misleading conclusions (#113, #114).

**Version-scoped candidates with a temporal lifecycle (#113).** Candidates and issue-drafts now
carry the version range they were observed in, so a problem already fixed in a later version stops
generating fresh issues and a stale-issue guard marks existing drafts against the version they
belong to. Low-confidence, current-version culprits are scoped and labelled rather than surfaced as
if settled.

**Workload-adjusted cohort comparison (#114).** Version- and stage-cost comparisons now match
cohorts by workload signature (a diff-stat captured at cycle close) instead of comparing raw
per-session cost, removing the confound where a longer user-driven session read as devcycle being
less efficient. A new `workload` run-record kind and its diff-stat writer feed run-level
aggregation, a recency band, and the workload join in `doctor.mjs`.

**Report-layer honesty.** Every report metric is now tagged observed vs. derived, the raw observed
metric families are rendered, and the Cost-by-stage caption reflects the derived medians it actually
reports.

## 0.14.3 — 2026-08-21

- fix(pipeline): close the remaining audit batches — reuse, surface, robustness, instruction cost, and vocabulary

The last three of five batches remediating a 54-finding whole-repo audit. With this release **all
eleven remediation cycles are complete and no audit finding remains open.**

**Batch 3 — surface drift and script reuse.** The documented surface is reconciled with the shipped
one: the config table, the Use section, the delete-vs-close guidance, and a raft of stale
command/agent/hook references now describe what actually ships, not what an earlier version did
(F11, F12, F14–F18, F21, F22, F25, F44). Separately, five script components that had been
re-implemented beside an existing one are collapsed onto a single owner — plan-file parsing (written
three times), the schema validator copied into `validate.mjs`, per-script CLI flag parsing (now
`scripts/cli-flags.mjs`), and `doctor.mjs`'s duplicated cache-band sentence and `median` helper
(F31, F32, F37, F38, F39). Behaviour is unchanged; the duplication is gone.

**Batch 4 — robustness and instruction economy.** Five failure modes in devcycle's own scripts are
hardened — flag parsing that swallowed the next bare token, extension-less path handling, the
`.worktrees` walk, and more (F47, F50, F52, F53, F54, F55). The instruction surface is cut where it
had grown redundant, and several one-owner violations — two files describing the same rule — are
resolved so each rule has exactly one home (F40, F34, F35, F41, F42, F45, F27).

**Batch 5 — vocabulary.** Eight reference files and two playbooks still called a devcycle pipeline
*stage* a "skill", though devcycle has shipped none since 0.12.0, when `skills/` was dissolved into
`playbooks/`. The devcycle-stage sense of the word is swept to "playbook" across the live surface,
per-occurrence rather than globally — the same files use "skill" correctly in its upstream Claude
Code sense in adjacent sentences, and every such use is left intact (F46).

## 0.14.2 — 2026-08-20

- fix(pipeline): close the second audit batch — the browser guard and four unreachable pieces of machinery

The second of five batches remediating a 54-finding whole-repo audit. **The browser guard**
shipped in 0.14.1 denying everything, including the one agent it exists to admit: it compared
`agent_type` against the bare `"on-device-driver"` while the harness sends the plugin-namespaced
`"devcycle:on-device-driver"`, so the comparison could never match and the on-device stage could
not run at all. Both spellings are now pinned — not a prefix strip, which would widen the guard
to another plugin's same-named agent — and the guard fails closed on every stdin shape it can
receive, where a `null` body or a non-string `agent_type` used to exit 1 with no decision at all.
`hooks/hooks.json` is inside `validate`'s surface walk, and new assertions tie the allowlist
literal to the agent's frontmatter `name:` and to the plugin id, so a rename in any one of those
three files can no longer disarm the guard while the suite stays green. The fix was verified on
the running harness rather than deduced: under it the driver reaches the extension while the main
thread and a general-purpose subagent are both denied with their origins named, and with 0.14.1
restored the same driver making the same call is denied. **Four unreachable pieces of machinery**
are wired up or removed — the audit's headline class, code that ships, is tested, and is called by
nothing. `model-pool.mjs` gains a CLI and a caller; `dream --record-lifecycle` and
`--render-report`'s verification argument are named by the playbook that should invoke them;
`lessons.mjs`'s `planLanding` is exposed as `--plan-landing`, and the never-called `applyLanding`
is deleted along with the prose rule it implemented. **A reachability gate** stops the class from
returning: six golden-path legs assert that every shipped engine, subcommand, script, workflow and
agent is named or read by at least one surface file in its `${CLAUDE_PLUGIN_ROOT}` form — checking
importers rather than text, since being *named* is what let `model-pool.mjs` look reachable for the
whole period it had no caller. Each leg states its own boundary instead of implying an airtight
guarantee; the agent leg took three review rounds because the first two fixes closed the reported
instance rather than the class, which a mutually-naming pair of orphaned agents defeats.

## 0.14.1 — 2026-08-20

- fix(pipeline): close the first audit batch — verification engine, silent gates, release path, and workflow engines

The first of five batches remediating a 54-finding whole-repo audit, plus the last of the
learn-loop issue closeout. **The verification engine** stops executing authored shell: every r3
promotion's `- verify:` line used to run through `/bin/sh -c` on any `doctor` report or
`dream --check-recurrence`, so asking for a report over a freshly cloned repo ran that repo's
committed markdown — the audit's only critical finding. Execution is now opt-in behind an
explicit `--run-checks` flag and bounded by a timeout and a max buffer, a new `errored` verdict
keeps a broken harness from reading as a clean bill of health, and verification windows are
scored honestly with culprit ids matched as bare slugs. **Three silent gates** now check
something: the evidence-completeness gate was dispatched by a repo-relative path that resolves
to nothing from an installed plugin, so it never ran for any user; the plan linter discarded the
path it was handed and linted a default; and resume-check never performed the `root:` ownership
check it documented. A new `validate` check bans the repo-relative dispatch form across the
surface directories so the first class cannot return. **The release path** makes `!` the sole
major-bump trigger — the `BREAKING CHANGE:` trailer branch was unreachable, so a release PR
announcing a breaking change shipped a patch — and pins the tag and back-merge workflows against
a permissions widening or a lost retry cap. **The workflow engines** share one subprocess layer,
restoring a `--tools=` invariant lost between two copies, and cap stage-1 lens fan-out at four so
a chunked oversize diff no longer spawns lenses x chunks processes at once. **Pipeline guards**
close six learn-loop issues: a `PreToolUse` hook denies browser calls from anywhere but the
on-device driver, and the surface line and per-file byte budgets gain reviewed headroom.

## 0.14.0 — 2026-08-19

- feat(pipeline): learn-loop issue closeout — script fixes, mechanics hardening, and methodology gates

Closes the backlog of issues devcycle's own learn loop raised against itself, in three batches.
**Script fixes** repair seven learn-loop bugs in `scripts/*.mjs`: verification no longer records
an unmeasurable gate as held, observations dedupe by quote-hash and timestamp, the run record
gains a `partial` outcome, redaction offers a scoped, visible `--auto-redact`, and doctor
attribution and just-me scope filters are corrected. **Mechanics hardening** makes the pipeline
safer under load: the branch-review panel auto-chunks oversize diffs at file and hunk boundaries
instead of hitting a per-reviewer cap, the on-device driver batches its reads and saves evidence
to disk, before/after gate evidence must carry an `(exit N)` token, and implementer and reviewer
agents are barred from git commands that could clobber a sibling's working tree. **Methodology
gates** add three pre-flight checks: an authored-claims contract with a discriminating red-green
rule (so facts stated in plans and reviews are verified against source), a blast-radius gate that
greps a changed symbol's consumers and tests into the dispatch brief, and a brief-completeness
gate that enforces the required dispatch fields.

## 0.13.1 — 2026-08-16

- perf(lessons): deliver r2 lessons on demand and add a doc-tracking policy

Lessons a past cycle recorded are now fetched only when they actually apply to the diff at hand,
instead of never or always: `dream.mjs --match/--lesson` scores changed files against stored
lessons, and matched lessons ride into implementer briefs and the branch/audit reviewers as
return envelopes. A new `docTrackingPolicy` option and a `validate` guard also settle which
devcycle artifacts belong in git — lessons (and optionally promotions) are tracked for their
long-term value, while single-run plans and specs stay out of the repo to avoid bloat.

## 0.13.0 — 2026-08-15

- feat(learn): add the cross-session learning loop with verification and lifecycle

devcycle now learns from its own past runs. Every cycle journals the friction it hits against a
shared culprit vocabulary; `/devcycle:learn` mines that journal across sessions, dedups and
clusters recurring friction, and promotes a fix up a graduated ladder that a human Confirms before
anything lands. `/devcycle:doctor` renders the result as a document — a per-profile write-up with
its top culprit filed as an issue draft, and a verification scoreboard that measures whether each
promoted lesson actually held. Nothing is written without an explicit Confirm.

### The loop

- **Journaled friction, shared vocabulary.** Cycles record friction events keyed by a stable
  culprit-id drawn from one vocabulary, so the same problem is recognised across sessions and
  scored by impact rather than counted twice.
- **Journal-first mining with dedup and a Confirm ladder.** `/devcycle:learn` reads the journal,
  dedups by culprit-id, and walks candidates up an r0–r3 promotion ladder; a landed culprit-id is
  never re-proposed, and each run renders a report of what it found.
- **The profile as a document.** `/devcycle:doctor` renders the measured session profile as prose
  and files its top culprit as a ready-to-paste issue draft.
- **Verification and lifecycle.** A shared verification engine scores every promoted lesson as
  held / recurred / unmeasurable against real runs and routes candidates to escalation,
  retirement, or revert. Retirement and revert persist as lifecycle records that suppress
  re-proposal; a `resolved-in:` check watches whether a fix holds past the release that shipped it;
  and an always-loaded byte budget refuses lesson growth past an aggregate ceiling without a
  same-run retirement.

### Foundations

- **Trustworthy instrumentation.** A verifiable run-record captures per-run cost, model routing,
  and stage timings — the measured substrate the loop and the doctor read.

## 0.12.0 — 2026-08-07

- feat(surface): collapse to seven commands and rename audit, dream and distill

devcycle's command surface is now seven verbs, and the plugin ships no skill ids at all —
playbooks are loaded by path from the command that runs them. Three entry points were renamed.
Pre-1.0, so there are no aliases and no deprecation period: **update any saved prompt, wrapper
skill or repo `CLAUDE.md` that names an old id before upgrading.**

### Breaking — renamed commands

| Was | Now | What changed |
| --- | --- | --- |
| `/devcycle:audit` | `/devcycle:review` | Takes three scopes: `branch:<name>` (with an optional `base:<name>`), this whole repository, or a file set. A bare argument is now the *concern* to review, never guessed to be a branch. |
| `/devcycle:dream` + `/devcycle:distill` | `/devcycle:learn` | `distill` already ran `dream` as its step 0, so the two collapse into one. The single behaviour that differed — previewing without committing — is now `/devcycle:learn --preview`. |

The other five keep their names and their arguments: `/devcycle:cycle`, `/devcycle:continue`,
`/devcycle:verify`, `/devcycle:doctor`, `/devcycle:onboard`.

### Breaking — every `devcycle:*` skill id is gone

devcycle ships no skills. Fourteen `SKILL.md` files became twelve `playbooks/*.md` files (two
pairs merged), loaded by path from the command that runs them and listed in no roster — so
anything that invoked one by id must call the owning command instead. These ids no longer
resolve:

`devcycle:auditing-a-repo`, `devcycle:distilling-learnings`, `devcycle:doctor`,
`devcycle:dreaming-across-sessions`, `devcycle:executing-waves`, `devcycle:fast-path`,
`devcycle:finishing-the-cycle`, `devcycle:onboarding-a-repo`, `devcycle:planning-waves`,
`devcycle:reviewing-code`, `devcycle:reviewing-the-branch`, `devcycle:scoping-interview`,
`devcycle:sweeping-mechanical-changes`, `devcycle:verifying-on-device`.

Five changed identity in the move rather than just location: `scoping-interview` →
`playbooks/scoping-the-request.md`, `fast-path` → `playbooks/taking-the-fast-path.md`, `doctor` →
`playbooks/profiling-sessions.md`, `auditing-a-repo` merged into `playbooks/reviewing-code.md`,
and `dreaming-across-sessions` + `distilling-learnings` merged into
`playbooks/learning-from-sessions.md`.

### Also in this release

- refactor(surface): dissolve `skills/` into path-loaded `playbooks/`
- refactor(commands): collapse the command surface from eight verbs to seven
- refactor(routing): give the command surface one owner (`references/routing.md`) and a gate
- refactor(references): dedup the single-owner reference layer
- test(golden-path): assert the pipeline's wiring across every stage
- ci(workflows): pin runners, gate commit subjects, and scope checkout credentials
- docs: rewrite `DESIGN.md`, `README.md` and `CONTRIBUTING.md` to the shipped surface

This is the first of three cycles restructuring devcycle; the two that follow build on this
surface rather than changing it again.

Entries for 0.11.1 and earlier name the surface as it stood at the time and are left as
written.

## 0.11.1 — 2026-08-05

- ci(release): make main changeable only by checked pull request

## 0.11.0 — 2026-08-05

- feat(dream): add dreaming across sessions (#36)

## 0.10.1 — 2026-08-03

- fix(doctor): forward-fill skill attribution and correct scope docs

## 0.10.0 — 2026-08-03

- feat(devcycle): add onboarding-a-repo and distilling-learnings skills (#31)

## 0.9.2 — 2026-08-01

- perf(devcycle): act on the token audit's cost model, routing, and depth-gate findings (#29)

## 0.9.1 — 2026-07-31

- perf(devcycle): cut orchestrator context depth and delegate inline tool work to subagents (#27)

## 0.9.0 — 2026-07-29

- feat: unify every review surface on shared criteria and one review engine (#25)

## 0.8.1 — 2026-07-29

- docs(changelog): drop Unreleased entries already shipped in 0.8.0 (#24)

## 0.8.0 — 2026-07-28

- feat: add branch-scoped audits, a compact profile-driven pipeline, and sweep routing

## 0.7.0 — 2026-07-25

- feat: add trivial-change fast path plus audit-round triage and review improvements (#18)

## 0.6.1 — 2026-07-24

- fix(cycle): make the command model-invocable and halt for compact/clear at boundaries (#11)

## 0.6.0 — 2026-07-24

- feat(verifying-on-device): drive on-device structural checks with claude-in-chrome (#10)

## 0.5.0 — 2026-07-24

- feat: discover repo/implementation-scoped context docs via graphify-first, index-then-fetch fallback

## 0.4.1 — 2026-07-23

- fix: gitPolicy respects permission and branch push restrictions

## 0.4.0 — 2026-07-23

- feat: auto model selection, first-run config walkthrough, and pipeline composition fixes (#7)

## 0.3.0 — 2026-07-23

- ci: push branch before tag in release job and guard existing tags (#6)
- docs: rewrite README for comprehension (#5)
- feat: harden pipeline guardrails and pin execution strategy (#4)

## 0.2.3 — 2026-07-23

- chore(deps): bump actions/checkout (#1)

## 0.2.2 — 2026-07-23

- docs: add e2e dry-run report and complete install instructions (#3)

## 0.2.1 — 2026-07-22

- docs: fold unreleased 0.1.0 section into the 0.2.0 release notes (#2)

## 0.2.0 — 2026-07-22

- chore: ignore local execution artifacts and Finder metadata
- docs: finalize README and design appendix
- test: full scenario regression pass
- fix(scoping-interview): pin fallback batch shape and handoff stage naming
- docs: add coordinator-added binding checks to plan task 12
- feat: add review-panel and mechanical-sweep workflow scripts
- feat: add executing-waves skill with scenarios and upstream comparison
- feat: add reviewing-the-branch skill with scenarios and upstream comparison
- feat: add scoping-interview skill and cycle/continue commands
- feat: add verifying-on-device skill with scenarios and upstream comparison
- feat: add planning-waves skill with scenarios and upstream comparison
- docs: amend plan interfaces P6/P7/P9 per platform findings
- docs: record platform verification findings
- ci: add validation workflow, redaction guard, and dependabot
- feat: add implementer and read-only reviewer agents
- ci: add release automation (version bump, changelog, tag, GitHub release)
- feat: scaffold plugin and marketplace manifests
- fix: keep plan text clear of the redaction guard's own patterns
- docs: add v1 implementation plan (16 tasks, 8 waves, pinned interfaces)
- docs: add founding design docs and approved implementation spec

### Shipped components

- Skills: `scoping-interview`, `planning-waves`, `executing-waves`, `reviewing-the-branch`,
  `verifying-on-device` (each shipped with a superpowers upstream-comparison memo and a
  scenario-test suite under `tests/scenarios/`)
- Commands: `/devcycle:cycle`, `/devcycle:continue`
- Agents: `devcycle:implementer`, `devcycle:task-reviewer`, `devcycle:red-team-reviewer`
  (read-only tool allowlists on both reviewer agents)
- Workflows: `review-panel.js` (multi-lens branch review), `mechanical-sweep.js` (pilot-first
  bulk edits)
- CI: `validate.yml` (manifest/frontmatter/description-budget/redaction checks on PRs and
  `main`), `bump-version.yml` (conventional-commit-driven semver bump, changelog append, tag,
  and GitHub Release on merge to `main`)
