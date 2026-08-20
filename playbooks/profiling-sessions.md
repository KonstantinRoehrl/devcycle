# Profiling Sessions

## Run the script

Never re-implement its analysis — run it and read its output:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" [--all] [--since <date>] [--until <date>]
```

Add `--json` for machine output, `--depth` for the bare depth probe — the probe ignores the window
flags and exits non-zero with a one-line reason when it cannot resolve a depth. Do not walk
transcripts yourself. What it prints is the finished report, owned end to end by
`scripts/doctor.mjs`: read it, splice the two sections below into it, and retype none of it.

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
document: every other heading, gloss, table and caveat — including the whole
`## Previously promoted — did it hold` section, now rendered end to end by the verification engine —
carries through byte for byte.

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

**Previously promoted — did it hold.** The report's own section of that name is rendered by the
shared verification engine directly from the run-record journal, never from a dream artifact and
never by re-running the mining loop — so this playbook stays runnable standalone and pays none of
the mining cost. The engine scores each promotion and the section carries one line per scored
promotion — `<culprit-id> (<rung>): <verdict>` — with its verdict one of: `held` (runs observed,
no recurrence), `recurred` (the pattern came back), `errored` (the check itself failed to run to
completion — a timeout, an output overflow, or a spawn failure; a broken harness, never a verdict
on the lesson), `unmeasurable` (zero runs observed, never read
as `held`), or `broken` (an r3 check that now fails). Each `recurred` hit is its own finding,
ranked like everything above: a reappearance means the promotion did not fix the pattern, not a
reason to re-promote it. With nothing scored yet, the section renders the single line
`_No promoted lesson has been measured against a run yet._`.

- Beneath the verdicts come the `resolved-in` lines — `<culprit-id>: resolved in <version> —
  <verdict>` — one per culprit whose vocabulary entry claims a `resolved-in` version, verdict
  `unmeasurable` until the installed version reaches that mark and a run is observed against it.

An r3 lesson's `verify:` check is not executed by a report: `node scripts/doctor.mjs` and
`node scripts/dream.mjs --check-recurrence` both need an explicit `--run-checks` to run it, and
without the flag the row reads `unmeasurable — <check> (not run: pass --run-checks)`. Promotion
records are committed markdown, so running one is a deliberate act rather than a side effect of
asking for a report.

- A `recurred` r2 culprit also renders an escalation entry point in the same section —
  `Actionability — /devcycle:cycle re-address <culprit-id> (recurred N×; escalate from r2)` — and,
  being its own finding, its `/devcycle:cycle` entry point is also offered through the Actionability
  menu below.
- The report run also writes the cost-driven revert sidecar `.devcycle/doctor/revert-candidates.json`
  (same-profile, stage-scoped; the undo is an edit, never `git revert`) that the learning loop's
  Confirm step reads — a promotion whose own profile-and-stage cost regressed after it landed.

## Persisted artifact

Every run with at least one finding writes `.devcycle/doctor/YYYY-MM-DD-report.md` — never
`docs/doctor/`, where a repo-scoped audit goes: a doctor report holds the user's own session
cost data and must not default to being committed into whatever repo it ran in. A run with
zero findings need not write the file.

## Actionability (optional)

Every step here is skippable — the ranked report stands alone. If findings exist and are worth
acting on, offer one batched `AskUserQuestion` (multi-select), letting the user choose, per finding:

- **skip** — no action;
- **draft a GitHub issue** — drafted, screened, shown for review, filed only on two confirmations;
- **get a `/devcycle:cycle` entry point** — a one-line request string handed back for the user
  to run themselves. This run never invokes `/devcycle:cycle` itself: an entry point that
  chains onward takes the selection decision away from the user.

A `recurred` r2 escalation candidate from the scoreboard is itself one of these findings: its
`/devcycle:cycle` entry point re-addresses the culprit the promotion failed to fix, the same
escalation the scoreboard already rendered inline as an `Actionability — /devcycle:cycle re-address`
line.

Always include an explicit "just the overview, no action" choice in the same batch — the
follow-up is itself skippable, never a forced gate on finishing the command.

**Drafting an issue: two gates before anything is posted.** The selection above only chooses what
to draft. For each finding it chose:

1. Take the draft from the script, never hand-composed:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --issue-body <culprit-slug>`. Its `repo:` line
   names the repo every command below targets — read the slug from there, never from this file.
2. Screen it before anyone sees it: write it to a file, then run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/redaction-check.mjs" --file <draft>`. A draft that fails
   the screen is not shown at all — name the class that failed and stop there.
3. Record it as drafted now, before either gate — the marker records drafting, not posting, so a
   draft declined below still counts: append the draft's title to the persisted report, prefixed
   with `Drafted: `, on a line of its own:

   ```
   Drafted: [culprit:<slug>] <title>
   ```

   That marker is the only record of a draft: the Outer loop section counts the issues out of
   `.devcycle/doctor/`, and `scripts/doctor.mjs` parses exactly this form, which this file owns.
4. Show the screened draft and ask whether it is right. That is the first gate, and it asks about
   the draft's content only.
5. Ask separately whether to post it — the second gate, never inferred from the first. Nothing is
   ever auto-posted, and the script itself still posts nothing.
6. Only after that second confirmation, file it against the repo the draft's `repo:` line named —
   never the repo the run happened in, which is what a bare `gh issue create` resolves to. Carry
   the title and body exactly as `--issue-body` printed them: the title is its `title:` line, the
   body everything below the blank line under `labels:`, written to its own file.

   ```
   gh issue create --repo <repo> --title "<title>" --body-file <body-file>
   ```

   Pass no `--label`, and create none. Labelling that repo needs push access, so a filer who is
   not a collaborator gets a 403 — after both gates, with the draft already recorded — and GitHub
   drops labels such a filer supplies anyway. The draft's `labels:` line says what the maintainer
   applies at triage; the Outer loop section counts by the `[culprit:<slug>]` title prefix, which
   every filer can set.

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
