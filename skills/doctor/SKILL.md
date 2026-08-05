---
name: doctor
description: Use when a Claude Code session or transcript history needs profiling for token cost, context depth, model routing, or agent startup cost — running the analyzer and ranking what it finds by dollar impact, each with the concrete lever that changes it.
---

# Doctor

## Announce

State which scope this run covers: "I'm using the doctor skill to profile <every
devcycle-tagged session | every transcript, tagged or not | the window>."

## Run the script

Never re-implement its analysis — run it and read its output:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" [--all] [--since <date>] [--until <date>]
```

Add `--json` for machine output, `--depth` for the bare depth probe. Do not walk transcripts
yourself.

## Interpret, don't transcribe

The deliverable is a ranked list, not the raw tables the script prints. Rank entries by dollar
impact, and give each one its concrete lever:

- a mispriced or unpriced model,
- a stage running deep,
- an agent type with an oversized startup floor,
- dispatches omitting a model,
- a content class with high carry-weighted cost.

## Report the price vintage and unpriced models

Carry forward the script's `prices as of` line. If it emitted any `UNPRICED MODEL` lines,
report them by name: an unpriced model means `scripts/pricing.mjs` needs an entry, and until
it has one, that model's requests are excluded from every dollar figure in the report.

## Carry the script's disclosures forward

The script's own two caveats belong in the report verbatim, not smoothed over:

- skill attribution is forward-filled within each transcript from the last explicit skill
  invocation through to that transcript's end (or the next invocation) — genuinely
  unrelated work with no further skill call in the same transcript is still counted under
  the earlier skill;
- the context-budget bands are a fraction-based approximation, not a measurement of absolute
  cache-read cost.

Hiding either in the interpretation would make the report read as more certain than it is.

## Severity, ranking, and systemic recommendations

`scripts/doctor.mjs`'s candidate-finding signals (`emitCandidates()`'s
`{type, skill, version_from, version_to, delta_pct, dollars, sessions_sampled}` objects)
carry no severity — assigning it is this skill's job, using
`${CLAUDE_PLUGIN_ROOT}/references/findings.md`'s vocabulary **verbatim**
(critical/high/medium/low; blocking is derived as critical-or-high, never redefined
here). The dollar figure rides along per finding as a supporting field, never the sort
key.

**Rank severity desc, impact desc** — the same ordering `references/findings.md`
specifies for the audit stage's document form, reused rather than invented fresh.

**Systemic recommendations.** After the per-finding list, run a synthesis pass: group
findings that share a root cause (the same skill regressing across two unrelated
signals, the same missing pricing entry surfacing on multiple sessions) and propose one
structural fix per cluster — a new skill, consolidating existing skills, extracting a
shared reference — applying the one-owner discipline proactively rather than only
patching each finding individually.

**Previously promoted — did it hold.** After the systemic recommendations, render this
appendix from the latest `.devcycle/dreaming/<date>-dream.md` artifact's recurrence
section — written by `dreaming-across-sessions`' own `--check-recurrence` step, never by
doctor. Report each hit as its own finding, ranked by the same severity vocabulary and
dollar-impact ordering as everything above — a reappearance means the promotion did not
fix the pattern, and it is a new finding rather than a reason to re-promote the same fix.

Render the artifact's `capped` value alongside the hits: an empty result and a
cap-truncated one otherwise render identically, and past 100 sessions truncation is the
normal case rather than the exception, so a capped run's empty appendix is a
possibly-incomplete answer, not a clean bill of health.

Render the appendix present-but-empty when the artifact's recurrence section carries no
hits and the artifact's own `Profile:` line reads `standard` or `thorough`. When that line
reads `lean`, the recurrence check never ran — render the appendix as
**empty-not-checked** instead of a plain empty result; doctor still resolves no profile of
its own, it only renders the distinction the artifact already carries. Omit the appendix
entirely when no artifact exists at all.

This skill reads that artifact and never invokes `devcycle:dreaming-across-sessions`
itself — doctor stays runnable standalone and pays none of a dream's cost.

## Persisted artifact

Every run with at least one finding writes `.devcycle/doctor/YYYY-MM-DD-report.md`
(`.devcycle/` is already repo-wide gitignored, so this is a safe default with no new
ignore rule needed) — **not** `docs/doctor/`, unlike `auditing-a-repo`'s
`docs/audits/YYYY-MM-DD-<topic>.md`: an audit's findings are about the target repo's
code and belong committed alongside it; a doctor report contains the user's own session
cost/usage data and should not default to being committed into whatever repo it happens
to run in. A run with zero findings need not write this file — there is nothing for a
later `distilling-learnings` run or a GitHub issue draft to reference.

## Actionability (optional)

Every step in this section is skippable — the ranked report and its overview/benchmark
value stand alone. If findings exist and are worth acting on, offer one batched
`AskUserQuestion` (multi-select) letting the user choose, per finding, among:

- **skip** — no action;
- **draft a GitHub issue** — rendered inline for review; only actually posted via
  `gh issue create` on a further, separate explicit confirmation, never automatic;
- **get a `/devcycle:cycle` entry point** — a one-line request string handed back for
  the user to run themselves. This skill never invokes `/devcycle:cycle` on its own —
  the same chaining-entry-point precedent `/devcycle:audit` follows (DESIGN.md §15.3 /
  §4.4): an entry point that chains onward takes the selection decision away from the
  user.

Always include an explicit "just the overview, no action" choice in the same batch —
the follow-up question is itself skippable, never a forced gate on finishing the
command.

## Config-drift mode

`/devcycle:doctor drift <path>` (internally `--drift <path>`) skips the cost-analysis
machinery entirely. Run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --drift <path>
```

Report each finding it prints as an exact `file:line` reference with the changelog's
recorded replacement, per `${CLAUDE_PLUGIN_ROOT}/references/config-changelog.md` (this
is the same engine `devcycle:distilling-learnings` calls into — one engine, two
callers). Never re-parse the changelog or re-grep the target file yourself; the script
already did both.

## Standalone

This run starts no cycle, writes no `.devcycle/state.md`, and emits no handoff block.

Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.
