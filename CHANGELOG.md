# Changelog

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
