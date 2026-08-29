# redaction-check's finish-stage gate can't pass on legitimate .devcycle content (over-broad patterns)
- finding-kind: github-issue
- finding-id: github-issue:105
- issue: 105
- severity: high
- confidence: verified
- affected-files: scripts/redaction-check.mjs, playbooks/finishing-the-cycle.md
- first-seen: 2026-08-23
- last-seen: 2026-08-23
- passes: 1
- origin: github-issue #105
- verify: 
- lifecycle: 
- dismissed-reason: 

## Resolution

Resolved in cycle run `9d661cd3e5a9bfe3`: `redaction-check.mjs` gained a valueless
`--advisory-identity` flag that downgrades the three machine-identity classes (absolute
home-directory path, session id, local project directory) to an advisory stderr report with
exit 0, and an inline `redaction-allow` line marker that exempts a single line from those same
three classes. Deny-listed terms stay an unconditional hard fail under both. The finish
playbook's `.devcycle` scan (`playbooks/finishing-the-cycle.md`) now passes
`--advisory-identity`; the run-record-store scan is unchanged and stays the hard privacy gate.
