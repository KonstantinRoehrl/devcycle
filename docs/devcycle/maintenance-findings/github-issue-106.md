# Wave planning enforces file disjointness but not content coupling between same-wave tasks
- finding-kind: github-issue
- finding-id: github-issue:106
- issue: 106
- severity: high
- confidence: verified
- affected-files: scripts/wave-disjointness-check.mjs, playbooks/planning-waves.md
- first-seen: 2026-08-23
- last-seen: 2026-08-23
- passes: 1
- origin: github-issue #106
- verify: 
- lifecycle: 
- dismissed-reason: 

## Resolution

Resolved in cycle run `9d661cd3e5a9bfe3`: a new `scripts/content-coupling-check.mjs` flags a
same-wave task whose brief names a file another same-wave task edits — the content coupling
`wave-disjointness-check.mjs` (literal Files-block overlap only) cannot see — cleared by a
dependency or a `- Content-coupling override: Task B → <file> (Task A) — <reason>` line. The
planning self-review (`playbooks/planning-waves.md`) now runs it as a self-review item and as a
pre-handoff gate on the `## Dispatch Map` alongside `wave-disjointness-check.mjs`. The same cycle
also extended `blast-radius-check.mjs` to hard-fail on any referencer (test or non-test) of a
task's changed file that sits in no Files block, cleared by adding the file or a `- Blast-radius
override:` line.
