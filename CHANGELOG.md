# Changelog

## 0.1.0
- Initial scaffold
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
