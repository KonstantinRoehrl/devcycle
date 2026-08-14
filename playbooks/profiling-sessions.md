# Profiling Sessions

## Run the script

Never re-implement its analysis — run it and read its output:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" [--all] [--since <date>] [--until <date>]
```

Add `--json` for machine output, `--depth` for the bare depth probe — the probe ignores the window
flags and exits non-zero with a one-line reason when it cannot resolve a depth. Do not walk
transcripts yourself. What it prints is the finished report: a markdown document whose section
order, glosses, tables, caveats, disclosures and price vintage are fixed and owned by
`scripts/doctor.mjs`. Read it, splice the two sections below into it, and retype none of it.

## Scope — what the script actually covers, and announce it

With no flags the script scans **every transcript under `~/.claude/projects`** — not this
session — and keeps the sessions whose records carry a `devcycle:`-prefixed attribution id, which
every devcycle slash command records. `--all` widens it to every transcript, tagged or not.

`--since`/`--until` narrow what is measured within each kept session and drop sessions with no
records in the window; membership itself is still decided over each session's whole transcript,
window or not.

State the scope the run actually used — "every `devcycle:`-tagged transcript", "every
transcript, tagged or not", or the window — in the announce. The report states it again in its
own header line, which the script writes. Every number in it is only as wide as that corpus.

## The splice rule

The report leaves exactly two lines for this playbook to fill, and they are the only two it may
replace: `<!-- devcycle:highlights -->` takes the Highlights prose, `<!-- devcycle:findings -->`
the ranked findings and the systemic recommendations. Change nothing else in the rendered
document, apart from the one placeholder line under `## Previously promoted — did it hold`, which
states its own rule; every other heading, gloss, table and caveat carries through byte for byte.

## Interpret, don't transcribe

Highlights is what a reader who reads no further needs: the corpus's direction of travel, the
findings with the most money behind them, and whatever the caveats qualify. Rank the findings by
dollar impact, and give each one its concrete lever:

- a mispriced or unpriced model,
- a stage running deep,
- an agent type with an oversized startup floor,
- dispatches omitting a model,
- a content class with high carry-weighted cost.
- whether the plugin got cheaper or more expensive across versions, and by how much.

The sixth is corpus-level rather than per-finding, and the Highlights prose must state its
**direction of travel** explicitly — down, up, or flat — carrying forward the line the script
renders under the per-version cohort table. A report that lists regressions without saying which
way the whole corpus moved is the failure issue #44 recorded: the split was 21 worse / 18 better /
5 flat, direction down, and the report stated the opposite.

Carry forward the script's `prices as of` line into the announce. If it emitted any
`UNPRICED MODEL` lines, report them by name in the Highlights prose: an unpriced model means
`scripts/pricing.mjs` needs an entry, and until it has one, that model's requests sit outside
every dollar figure the report shows.

## Severity, ranking, and systemic recommendations

The script's candidate lines carry no severity — assigning it is this playbook's job, using
`${CLAUDE_PLUGIN_ROOT}/references/findings.md`'s vocabulary **verbatim** and ranking the list
in that file's document-form order. The dollar figure rides along per finding as a supporting
field, never the sort key: quote the figure the report already carries, scored by
`${CLAUDE_PLUGIN_ROOT}/references/impact-scoring.md`'s formula, and never recompute it. Name a
culprit by its slug in `${CLAUDE_PLUGIN_ROOT}/references/culprits.json`, the vocabulary the
report's culprit table renders from.

**Systemic recommendations.** After the per-finding list, group findings that share a root
cause and propose one structural fix per cluster — consolidating playbooks, extracting a shared
reference — rather than only patching each finding individually.

**Previously promoted — did it hold.** The report's own section of that name is rendered from the
recurrence section of the latest `.devcycle/dreaming/<date>-dream.md` artifact, written by
`${CLAUDE_PLUGIN_ROOT}/playbooks/learning-from-sessions.md`'s own `--check-recurrence` step, never
by this run — this playbook reads that artifact and never invokes that loop, so it stays runnable
standalone and pays none of the mining cost. Each hit is its own finding, ranked like everything
above: a reappearance means the promotion did not fix the pattern, not a reason to re-promote it.

- Render the artifact's `capped` value alongside the hits: past 100 sessions truncation is the
  normal case, so a capped run's empty appendix is a possibly-incomplete answer, not a clean
  bill of health.
- No hits and the artifact's `Profile:` line reads `standard` or `thorough` → render the section
  present-but-empty. `Profile: lean` → the recurrence check never ran, so render it
  **empty-not-checked**; doctor resolves no profile of its own, it only renders the distinction
  the artifact already carries.
- No artifact at all → delete the section, heading and all.

## Persisted artifact

Every run with at least one finding writes `.devcycle/doctor/YYYY-MM-DD-report.md` — never
`docs/doctor/`, where a repo-scoped audit goes: a doctor report holds the user's own session
cost data and must not default to being committed into whatever repo it ran in. A run with
zero findings need not write the file.

## Actionability (optional)

Every step here is skippable — the ranked report stands alone. If findings exist and are worth
acting on, offer one batched `AskUserQuestion` (multi-select), letting the user choose, per finding:

- **skip** — no action;
- **draft a GitHub issue** — drafted and shown for review, never filed by this run;
- **get a `/devcycle:cycle` entry point** — a one-line request string handed back for the user
  to run themselves. This run never invokes `/devcycle:cycle` itself: an entry point that
  chains onward takes the selection decision away from the user.

Always include an explicit "just the overview, no action" choice in the same batch — the
follow-up is itself skippable, never a forced gate on finishing the command.

**Drafting an issue: two gates, and nothing posted.** That selection is the first gate. For each
finding it chose:

1. Take the draft from the script, never hand-composed — it prints a title, labels and a body
   quoting the rows the report already rendered:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --issue-body <culprit-slug>`.
2. Screen it before anyone sees it: write it to a file, then run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/redaction-check.mjs" --file <draft>`. A draft that fails
   the screen is not shown at all — name the class that failed and stop there.
3. Show the screened draft. The second gate is a separate explicit confirmation that this one is
   the user's to file. Filing is theirs to do, in their own tracker: this run posts nothing and
   runs no command that could.
4. Only after that confirmation, append the draft's title to the persisted report, prefixed with
   `Drafted: `, on a line of its own:

   ```
   Drafted: [culprit:<slug>] <title>
   ```

   That marker is the only record of a draft: the Outer loop section counts these lines out of
   `.devcycle/doctor/`, and `scripts/doctor.mjs` parses exactly this form, which this file owns.

## Config-drift mode

`/devcycle:doctor drift <path>` (internally `--drift <path>`) skips the cost-analysis machinery
entirely and takes precedence over every other flag:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --drift <path>
```

It resolves the changelog at `${CLAUDE_PLUGIN_ROOT}/references/config-changelog.md` — the same
engine `${CLAUDE_PLUGIN_ROOT}/playbooks/learning-from-sessions.md` calls into, one engine, two
callers — and prints each finding as a `file:line` reference with the changelog's recorded
replacement. Report them as printed; never re-parse the changelog or re-grep the target file yourself.

## Standalone

This run starts no cycle, writes no `.devcycle/state.md`, and emits no handoff block.

Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.
