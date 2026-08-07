# The ledger — where progress is written

The single owner of the ledger's own *write* format: its preamble records and its per-event line.
No existing reference fits — `${CLAUDE_PLUGIN_ROOT}/references/resume.md` owns reading position back *out* of the
ledger, `${CLAUDE_PLUGIN_ROOT}/references/evidence.md` owns report and verdict shapes, and neither owns how the file
itself is written, which `resume.md`, `${CLAUDE_PLUGIN_ROOT}/references/handoff.md` and the stage skills all point at.

Single source of truth for progress, at `.devcycle/ledger.md` — one ledger, never a second.
`${CLAUDE_PLUGIN_ROOT}/playbooks/executing-waves.md` creates the file, before any per-event line, with these three
records at the top, each written once, in this order:

```
Plan: `<the plan path this stage was handed>`
Branch: `<topic branch>` (cut from `<integration or default branch>`)
Profile: `<resolved profile>` (evidence tail <N> lines)
```

`Branch:` is recorded once that skill's pre-flight has the topic branch, `Profile:` from its own
resolved profile, and its commit-convention pre-flight step appends a fourth line,
`Commit-convention:`, after these three once its derivation runs —
`${CLAUDE_PLUGIN_ROOT}/references/commit-convention.md` owns that line's format. Then one
appended line per event, all four fields REQUIRED, exactly this shape:

```
- [<ISO-8601 UTC>] task=<id> event=<dispatched|report-received|review-round|review-verdict|committed|user-decision> outcome=<short> ref=<commit-sha|file|none>
```

After any compaction or resume, trust the ledger and `git log` over conversation memory.
