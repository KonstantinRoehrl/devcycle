# The ledger — where progress is written

The single owner of the ledger's own *write* format: its preamble records and its per-event line.
No existing reference fits — `${CLAUDE_PLUGIN_ROOT}/references/resume.md` owns reading position back *out* of the
ledger, `${CLAUDE_PLUGIN_ROOT}/references/evidence.md` owns report and verdict shapes, and neither owns how the file
itself is written, which `resume.md`, `${CLAUDE_PLUGIN_ROOT}/references/handoff.md` and the stage playbooks all point at.

Single source of truth for progress, at `.devcycle/ledger.md` — one ledger, never a second.
`${CLAUDE_PLUGIN_ROOT}/playbooks/executing-waves.md` creates the file, before any per-event line, with these three
records at the top, each written once, in this order:

```
Plan: `<the plan path this stage was handed>`
Branch: `<topic branch>` (cut from `<integration or default branch>`)
Profile: `<resolved profile>` (evidence tail <N> lines)
```

`Branch:` is recorded once that playbook's pre-flight has the topic branch, `Profile:` from its own
resolved profile, and its commit-convention pre-flight step appends a fourth line,
`Commit-convention:`, after these three once its derivation runs —
`${CLAUDE_PLUGIN_ROOT}/references/commit-convention.md` owns that line's format. Then one
appended line per event, all four fields REQUIRED, exactly this shape:

```
- [<ISO-8601 UTC>] task=<id> event=<dispatched|report-received|review-round|review-verdict|committed|user-decision> outcome=<short> ref=<commit-sha|file|none>
```

The leading `[<ISO-8601 UTC>]` bracket is the output of `node "${CLAUDE_PLUGIN_ROOT}/scripts/stamp.mjs" now`,
taken when the entry is appended — never a narrated or estimated time.

After any compaction or resume, trust the ledger and `git log` over conversation memory.

## The run record

A second, machine-readable log of the same run — `scripts/run-record.mjs`'s append-only JSONL,
never read by this file's own reader (`references/resume.md`) and never reading the ledger back.
`references/evidence.md` § Why the evidence lives in files gives the same reasoning for why these
two logs never merge. One row per write site, not a restatement of `tests/fixtures/run-record.schema.json`'s field shapes:

| kind | written | by |
| --- | --- | --- |
| `run` | once, after config resolution, before the first confirmation | `commands/cycle.md` |
| `session` | once per real Claude Code session — cycle start, and the top of every `/devcycle:continue` | `commands/cycle.md`, `commands/continue.md` |
| `stage` | at every stage boundary | `references/handoff.md` |
| `dispatch` | once per implementer dispatch, at step 4 (report received) — never at step 3 (dispatch), since `endedAt`/`outcome`/round/retry are unknown until the envelope returns | `playbooks/executing-waves.md` |
| `verdict` | once per review round, at step 5 (after `event=review-verdict`) — never at step 4, since `round`/`blockingCount`/`conformance` are unknown until review runs | `playbooks/executing-waves.md` |
| `commit` | once per task commit, at step 7 | `playbooks/executing-waves.md` |
| `event` | `gate-fail` / `gate-pass-clean` once per green-gate run, at step 6; `user-correction-at-gate` at any AskUserQuestion the user answers via "Other" — the stage only, never the typed text. **A gate appends it exactly when a run record exists at that moment.** Everything else follows: a run-bearing command's stages append (`commands/cycle.md` mints the record, `commands/continue.md` resumes it), a standalone command's gates have no run to append to, a gate reached before the mint has none yet, and a surface reachable both ways appends only on the entry where the run exists — so a run carrying no `user-correction-at-gate` event says nothing about gates outside that boundary | `playbooks/executing-waves.md`, and every in-cycle surface that asks |
