# Profiling Sessions

## Run the script

Never re-implement its analysis — run it and read its output:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" [--all] [--since <date>] [--until <date>]
```

Add `--json` for machine output, `--depth` for the bare depth probe — the probe ignores the
window flags and exits non-zero with a one-line reason when it cannot resolve a depth. Do not
walk transcripts yourself.

## Scope — what the script actually covers, and announce it

With no flags the script scans **every transcript under `~/.claude/projects`** — not this
session — and keeps the sessions whose records carry a `devcycle:`-prefixed attribution id,
which every devcycle slash command records. `--all` widens it to every transcript, tagged or
not.

`--since`/`--until` narrow what is measured within each kept session and drop sessions with no
records in the window; membership itself is still decided over each session's whole transcript,
window or not.

State the scope the run actually used — "every `devcycle:`-tagged transcript", "every
transcript, tagged or not", or the window — in the announce and again in the report. Every
number below is only as wide as that corpus.

## Interpret, don't transcribe

The deliverable is a ranked list, not the raw tables the script prints. Rank entries by dollar
impact, and give each one its concrete lever:

- a mispriced or unpriced model,
- a stage running deep,
- an agent type with an oversized startup floor,
- dispatches omitting a model,
- a content class with high carry-weighted cost.
- whether the plugin got cheaper or more expensive across versions, and by how much.

The sixth is corpus-level rather than per-finding, and the report must state its **direction of
travel** explicitly — down, up, or flat — with the per-version cohort table behind it. A report that
lists regressions without saying which way the whole corpus moved is the failure issue #44 recorded:
the real split was 21 worse / 18 better / 5 flat, aggregate direction down, and the report stated
the opposite.

## Report the price vintage and unpriced models

Carry forward the script's `prices as of` line. If it emitted any `UNPRICED MODEL` lines,
report them by name: an unpriced model means `scripts/pricing.mjs` needs an entry, and until it
has one, that model's requests are excluded from every dollar figure in the report.

## Carry the script's disclosure forward

The report prints one `note:` line — skill attribution is forward-filled within each transcript
from the last explicit skill invocation through to that transcript's end, so unrelated work
with no further skill call is still counted under the earlier skill. Reproduce it rather than
smoothing it over. The context-depth bands are a fraction-of-window approximation the script
does not disclose in its output: say so yourself wherever the report leans on them.

## Severity, ranking, and systemic recommendations

The script's `CANDIDATE:` lines carry no severity — assigning it is this playbook's job, using
`${CLAUDE_PLUGIN_ROOT}/references/findings.md`'s vocabulary **verbatim** and ranking the list
in that file's document-form order. The dollar figure rides along per finding as a supporting
field, never the sort key.

**Systemic recommendations.** After the per-finding list, group findings that share a root
cause and propose one structural fix per cluster — consolidating playbooks, extracting a shared
reference — rather than only patching each finding individually.

**Previously promoted — did it hold.** After the systemic recommendations, render an appendix
from the recurrence section of the latest `.devcycle/dreaming/<date>-dream.md` artifact,
written by `${CLAUDE_PLUGIN_ROOT}/playbooks/learning-from-sessions.md`'s own
`--check-recurrence` step, never by this run — this playbook reads that artifact and never
invokes that loop, so it stays runnable standalone and pays none of the mining cost. Each hit
is its own finding, ranked like everything above: a reappearance means the promotion did not
fix the pattern, not a reason to re-promote it.

- Render the artifact's `capped` value alongside the hits: past 100 sessions truncation is the
  normal case, so a capped run's empty appendix is a possibly-incomplete answer, not a clean
  bill of health.
- No hits and the artifact's `Profile:` line reads `standard` or `thorough` → render the
  appendix present-but-empty. `Profile: lean` → the recurrence check never ran, so render it
  **empty-not-checked**; doctor resolves no profile of its own, it only renders the
  distinction the artifact already carries.
- No artifact at all → omit the appendix entirely.

## Persisted artifact

Every run with at least one finding writes `.devcycle/doctor/YYYY-MM-DD-report.md` — never
`docs/doctor/`, where a repo-scoped audit goes: a doctor report holds the user's own session
cost data and must not default to being committed into whatever repo it ran in. A run with
zero findings need not write the file.

## Actionability (optional)

Every step here is skippable — the ranked report stands alone. If findings exist and are worth
acting on, offer one batched `AskUserQuestion` (multi-select), letting the user choose, per
finding, among:

- **skip** — no action;
- **draft a GitHub issue** — rendered inline for review; posted via `gh issue create` only on a
  further, separate explicit confirmation, never automatically;
- **get a `/devcycle:cycle` entry point** — a one-line request string handed back for the user
  to run themselves. This run never invokes `/devcycle:cycle` itself: an entry point that
  chains onward takes the selection decision away from the user.

Always include an explicit "just the overview, no action" choice in the same batch — the
follow-up is itself skippable, never a forced gate on finishing the command.

## Config-drift mode

`/devcycle:doctor drift <path>` (internally `--drift <path>`) skips the cost-analysis machinery
entirely and takes precedence over every other flag:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --drift <path>
```

It resolves the changelog at `${CLAUDE_PLUGIN_ROOT}/references/config-changelog.md` — the same
engine `${CLAUDE_PLUGIN_ROOT}/playbooks/learning-from-sessions.md` calls into, one engine, two
callers — and prints each finding as a `file:line` reference with the changelog's recorded
replacement. Report them as printed; never re-parse the changelog or re-grep the target file
yourself.

## Standalone

This run starts no cycle, writes no `.devcycle/state.md`, and emits no handoff block.

Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.
