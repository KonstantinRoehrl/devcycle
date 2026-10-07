# Lessons

## execution
- Bash sandbox blocks mkdtemp on default TMPDIR -- point TMPDIR at an out-of-repo directory for tests (repo-local trips git-aware fixtures). [novel:tmpdir-sandbox-blocks-mkdtemp]
- Instruct the implementer to verify the brief against the code rather than trust it; three consecutive dispatches caught a coordinator error that way. [novel:implementer-verifies-brief-against-code]
- Review against the source docs, not the plan's or brief's framing of them. [first-round-clean-accept]
- Have the task reviewer re-run the whole gate, recompute reported counts and mutation-test the fix instead of trusting the report; re-execution caught what reading it did not. [novel:reviewer-reexecutes-claims-instead-of-trusting-report]
- When a task replaces what a probe, gate or helper runs, or adds an importer to a shared helper, grep docs, CONTRIBUTING and source comments for the old name before finishing. [novel:replaced-mechanism-leaves-stale-name-in-docs-and-comments]
- Keep checkout, worktree add, apply and the shelve verb out of implementer briefs (the dispatch is denied them); for a revert-and-restore, say read git show HEAD:<path> and write it back. [novel:hook-denied-git-verbs-in-dispatch-briefs]
- When a brief forbids staging, have the coordinator stage a tracked-file deletion (git rm) before the after-capture; an implementer cannot stage, and tests that list tracked files read the missing path. [novel:tracked-deletion-by-no-stage-brief-reds-git-ls-files-test]
