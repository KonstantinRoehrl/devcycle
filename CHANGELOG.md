# Changelog

## 0.4.0

- feat: auto model selection, first-run config walkthrough, and pipeline composition fixes (#7)

## 0.3.0

- ci: push branch before tag in release job and guard existing tags (#6)
- docs: rewrite README for comprehension (#5)
- feat: harden pipeline guardrails and pin execution strategy (#4)

## 0.2.3

- chore(deps): bump actions/checkout (#1)

## 0.2.2

- docs: add e2e dry-run report and complete install instructions (#3)

## 0.2.1

- docs: fold unreleased 0.1.0 section into the 0.2.0 release notes (#2)

## 0.2.0

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
