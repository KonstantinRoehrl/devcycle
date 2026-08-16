# Learning from sessions

Observe → propose → confirm → land. One loop. `--preview` stops after the proposal and lands
nothing.

## Modes

- default — the whole loop; every promotion is batched for confirmation before it lands.
- `--preview` — mine and propose, write the dated artifact, land nothing, delete no memory.

Announce the mode and the scope this run covers; report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.

## Profile, instructions, checkpoints

Resolve `profile` per `${CLAUDE_PLUGIN_ROOT}/references/config.md` (learn depth row); the slice
table below carries which slices each profile admits, `lean` — the memory store alone — included, so
the checkpoint always advances. A free-text `instructions` argument steers *what the run looks for*:
a synthesis pass, not an editor, so a line-targeted imperative is a no-op.

Two checkpoints, both file-based; neither is the pipeline's `.devcycle/state.md`, which this
standalone playbook never creates, reads-modifies, or writes. The engine owns the corpus checkpoint,
advanced by `--commit-checkpoint` below; the other is this playbook's own
`.devcycle/distilling-state.md`, read (or initialized) on a default run, holding `last-run:`
(ISO-8601 UTC, or `never`) and `last-reviewed-devcycle-version:` (semver, or `none`).

## Plan the corpus

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/dream.mjs" --plan`; never walk transcripts directly. It
prints the manifest as JSON. Every stage's work list is its own slice ids minus the manifest's
`observations`, and `capped: true` is reported as a bounded run, never a failure.

**The journal is the first corpus and is never mined.** `journal.events` counts the run-record
events since the checkpoint; read them with
`node "${CLAUDE_PLUGIN_ROOT}/scripts/dream.mjs" --journal-events --since <checkpoint>`, which
returns them already grouped by culprit-id. They cost no dispatch — they are structured.

`journal.empty: true` means this repo has never written a run record. That is a normal cold start,
not a failure and not "nothing found": report it as *journal empty* and fall through to the memory
store and mining. `journal.empty: false` with `journal.events: 0` is the opposite case — the
journal was read and held nothing in this window — and is reported as such. Every later report
carries the distinction; collapsing the two hides a cold start behind a clean bill.

`orphanObservations` names any observation file the manifest cannot address; report the list rather
than silently re-mining its slice. Budget the run from `extractBytes`, the model-visible sum, never
from `totalBytes`, which is JSONL on disk.

If `artifactFresh` is true, read `artifactPath` and report it — no mining, screening, recurrence
check, artifact rewrite, and above all no checkpoint advance, since this run mined none of the
sessions `--plan` just enumerated. **`--preview` stops there**, landing nothing and deleting no
memory; a default run carries that artifact straight to **Confirm**.

## Mine each slice

One dispatch per unmined slice the profile admits, per
`${CLAUDE_PLUGIN_ROOT}/references/delegation.md`, **each pinned to the fast tier in the dispatch
itself, never inheriting the caller's model**. A session-sourced slice reads its text through the
engine (`--extract <session-id>`). Each dispatch writes its slice's records to
`.devcycle/dreaming/observations/<slice-id>.json` as an array of objects carrying
`session`, `ts`, `kind` (`friction | correction | rule-violation | decision | contradiction-side`),
`subject`, `target` (a repo-relative path or `null`), `quote` and `confidence`. `subject` is the
normalized phrase the next stage clusters on across sessions; `quote` is a short verbatim excerpt
and the grounding anchor — **an observation may state only what its quote shows**. A dispatch
**returns a count, not content**, and a slice that already has an observation file is never re-mined —
which is what makes an interrupted run resumable.

Each dispatch then verifies its own write with `--check-observations <slice-id>` rather than by
re-reading the file. A nonzero exit means the write is missing, truncated, or malformed; redo the
write and re-run the check. **Cap: 2 rounds.** One round is one rewrite plus its re-check. Still
nonzero at the cap: stop that slice, record status `exhausted-unresolved` per
`${CLAUDE_PLUGIN_ROOT}/references/loops.md`, and surface the slice id as a decision point — an
unverified slice is never reported as mined.

| stage | slice source | `<slice-id>` | admitted at |
| --- | --- | --- | --- |
| memory store | the manifest's `memoryDir` — `MEMORY.md` and its linked entry files | `memory` | every profile, `lean` included |
| archives / findings / ledgers | each manifest `archives[]` entry, via its `ledger.glob` + `index` and its `evidenceFiles` | `archive-<entry id>` | `standard`, `thorough` |
| user-correction turns | each manifest session via `--extract`, filtered to correction turns | `<session-id>-corrections` | `standard`, `thorough` |
| raw transcripts | each manifest session, read in full via `--extract` | `<session-id>` | `thorough` only |

## Cluster, screen, check recurrence

A **single** dispatch reads the **full** observation store and the journal's grouped events at the
caller's tier — the only stage where cross-session evidence and contradiction detection are
possible at all. **It assigns every candidate a culprit-id before it clusters**: the nearest
`${CLAUDE_PLUGIN_ROOT}/references/culprits.json` slug, or a minted `novel:<slug>` under D1's
canonicalization rule. Identity is the id; clustering only groups what already has one.

Dedup the minted ids against
`node "${CLAUDE_PLUGIN_ROOT}/scripts/dream.mjs" --novel-slugs` before proposing any of them: two
independently-worded `novel:` slugs for one pattern merge here, with the absorbed forms recorded as
`aliases`, or the taxonomy never consolidates.

Suppress with `--check-suppressed "<culprit-id>"`, which answers `{"suppressed": true|false}` — read
that key, never the absence of it. **Ids may be printed freely.** Matching is equality inside
structured stores, never against transcript text, so echoing one cannot seed a later hit; the
never-echo rules this section used to carry are deleted along with the prose matcher they protected.

A record that predates culprit-ids cannot be matched this way. Run
`--legacy-similar "<candidate title>"` and carry any hits into Confirm as a **duplicate hint** for a
human to judge. A hint never suppresses: signature matching measured 0/26 and 1/30 on real corpora,
so an automatic fallback would read as coverage it does not provide.

**Contradictions are never resolved by recency** — "latest" can reintroduce a corrected mistake. Each
pair becomes a `contradiction-resolution` candidate, both sides kept, resolved by a human at Confirm.

**Screen** every candidate's content for anything resembling a credential, an internal URL, or a
proprietary snippet, and flag it for human attention. Then partition candidates into
**bulk** (ordinary `doc-edit`, `skill-edit`, `enforcement-gap`) and **explicit** (every
sensitive-flagged candidate and every `contradiction-resolution`). The partition is **written here,
not chosen by the reader**: no candidate moves into the bulk to avoid a per-item decision.

**Recurrence** is skipped at `lean`. At `standard` or `thorough`, run `--check-recurrence`: each
promotion carrying `verify: journal-recurrence` is checked by counting journal events with its
culprit-id dated after it landed. Three verdicts, and the third is load-bearing — `held` (N runs
observed, no recurrence), `recurred`, and `unmeasurable` (zero runs observed). **Never report
`unmeasurable` as `held`**: a matcher that could not fire is not a clean bill of health.

## Write the candidate file, then render the report

Write `.devcycle/dreaming/<YYYY-MM-DD>-candidates.json` in exactly this shape — the renderer, the
recurrence check and the promotion writer all read it, and a second shape breaks all three:

    { repo, generatedAt, profile,
      corpus: { sessions, from, to, capped, journalEvents, journalEmpty },
      checkpoint: { before, after },
      attribution: { vocabulary, novel },
      candidates: [ { title, culpritId, aliases, disposition, partition, rung, whyNotHigher,
                      locations, fault, scope, impact, occurrences, trend, priorOccurrences,
                      evidenceSessions, verify, sourcedFromMemory, sensitive, legacyDuplicateOf,
                      declineReason } ],
      contradictions: [ { culpritId, sideA, sideB, chosen } ],
      evictions: [ { culpritId, section, reason } ] }

`disposition` ∈ `landed | declined | deferred`; `partition` ∈ `bulk | explicit`; `rung` ∈
`r0 | r1 | r2 | r3`; `fault` ∈ `repo | pipeline`; `scope` ∈ `repo-devs | just-me | null` — null
whenever `fault` is `pipeline`, which never lands locally. `whyNotHigher` is **required** on every
landed candidate: it is what makes ladder-first checkable rather than claimed.

Then render the proposal:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/dream.mjs" --render-report .devcycle/dreaming/<date>-candidates.json`,
writing it to `.devcycle/dreaming/<YYYY-MM-DD>-dream.md`. `${CLAUDE_PLUGIN_ROOT}/references/impact-scoring.md`
owns how each candidate's `impact` is computed; do not restate the formula here. Advance the corpus
checkpoint with `--commit-checkpoint <now, ISO-8601 UTC>`.

**`--preview` stops here**, the loop's other exit: report the artifact path and stop, promoting
nothing, deleting no memory, starting no cycle, emitting no handoff block.

## Confirm

1. **Read the memory entries accumulated since `last-run:`** — `MEMORY.md` and its linked files under
   `~/.claude/projects/<escaped-cwd>/memory/` (absolute cwd, every `/` replaced with `-`), filtered
   by modification time where the memory system exposes it, or all of them on first run.
2. **Check for devcycle config drift.** When the installed `plugin.json` `version` is newer than
   `last-reviewed-devcycle-version:`, run doctor's drift engine — never a second stale-key detector —
   against the user's global `CLAUDE.md` and any repo-level devcycle-wrapper skills:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --drift <path>`. Drift findings are not
   candidates: they keep their own per-item `AskUserQuestion` batching, 1–4 at a time.
3. **Dispose of the artifact in two tiers.** **Bulk**: one reviewed decision covers the whole part —
   adopt, discard, or adopt-with-exclusions expressed by editing the artifact itself. **Requires
   explicit decision**: per-item `AskUserQuestion`, 1–4 at a time; no candidate leaves this set to
   skip its round, and a `contradiction-resolution` needs an explicit human choice between its two
   preserved sides. Granularity changes; nothing is ever auto-applied. Name the side effects
   **before** asking: how many promotion records will be written, how many memories deleted.
4. **Route every candidate, and get both routings confirmed.**
   - **fault** — `repo` (the repo's own defect) or `pipeline` (devcycle's own). A pipeline-fault
     candidate never lands locally: render it as a D4 issue draft and file it only on per-item
     consent.
   - **scope**, for repo-fault candidates only — `repo-devs` (written to `docs/devcycle/lessons.md`,
     committed per `${user_config.docTrackingPolicy}` (default `standard`) and subject to the host
     repo's `.gitignore`) or `just-me` (the user's own store). Decide by the skill-placement
     test: if the lesson still reads correctly with every repo-specific noun replaced by "the
     project", it is also mirrored to the user's global store.
   - A `legacyDuplicateOf` hint is shown to the user as a hint and never acted on automatically.
5. **Resolve every eviction before landing.** A landing into a full section arrives with an
   `evictions[]` entry naming the line it would displace, least-recently-recurred first — the
   oldest `landed` date breaks the tie when the journal is cold. Show it as "landing X evicts Y".
   **The edit cannot land unresolved**: either the user approves the eviction or the landing is
   deferred.
6. **Surface any retirement or revert candidates** raised since the last run, proposed exactly like
   fresh candidates — this runs live. A **retirement** candidate is a `held` r1/r2 lesson past 10
   runs or 90 days; it proposes deleting the line and writing a **retirement** lifecycle record. A
   **revert** candidate, read from `.devcycle/doctor/revert-candidates.json`, proposes the undo
   *edit* and a **revert** lifecycle record — never `git revert`, since recorded `commit:` shas
   predate squash-merging and often do not resolve on the integration branch. Both carry the
   prior-lifecycle hint: a lifecycle record surfaces here as advice, never a hard suppression (the
   D-5 hint pattern), so re-proposing a retired or reverted lesson stays a human call.

   The rendered report's summary carries an `Always-loaded budget: <n> bytes (within budget)` line —
   the net bytes this run adds to the always-loaded surfaces — which reads `over budget — a same-run
   retirement is required` once growth crosses the aggregate ceiling. `--render-report` refuses that
   over-ceiling run outright unless the same run also reclaims room, printing `dream: always-loaded
   budget exceeded — this run adds <n> net bytes, past the <ceiling>-byte ceiling; retire a lesson
   in the same run to make room` to stderr and exiting non-zero, with no report written.

If the engine errors, times out, or leaves its corpus unreadable, report that and continue with raw
1:1 memory-entry batching: mining never blocks landing, and its failure is never silently swallowed.

## Land, ladder-first

Follow `${CLAUDE_PLUGIN_ROOT}/references/branch.md`'s Committing rule first (a topic branch off any
default or integration branch), minus its `branch:`-line write. Every landing names the **highest
mechanizable rung** and records `whyNotHigher`:

- **r3 mechanical** — a check in the repo's own infrastructure. `verify:` is its path or the command
  that runs it, and `--record-promotion` refuses the record if it resolves to neither.
- **r2 digest line** — one line in `docs/devcycle/lessons.md`, stage-sectioned, cap 15 lines per
  section, format `- <imperative lesson> [<culprit-id>]`.
- **r1 always-loaded prose** — allowed only with a recorded justification in `whyNotHigher`.
- **r0 memory** — unchanged.

`just-me` scope uses the same ladder against `~/.claude/devcycle/learnings/<repo-slug>/lessons.md`
and, where the lesson passes the skill-placement test, `~/.claude/devcycle/learnings/global/lessons.md`.
**Screen every line with `node "${CLAUDE_PLUGIN_ROOT}/scripts/redaction-check.mjs" --file <path>`
before writing either**: these files sit outside the repo, where no commit hook or CI gate will ever
see them.

Then, per adopted candidate:

1. **Apply the edit.** An r1/r3 edit lands in tracked plugin/repo source and is committed, scoped per
   `${CLAUDE_PLUGIN_ROOT}/references/commit-convention.md`'s "Scoping the commit" — any playbook file
   touched here is checked first against `tests/unit/golden-path.test.mjs`, `scripts/validate.mjs`,
   `scripts/redaction-check.mjs`, and `scripts/duplication-check.mjs`. An r2 edit lands in
   `docs/devcycle/lessons.md`, committed per `${user_config.docTrackingPolicy}` (default `standard`)
   and subject to the host repo's `.gitignore` by the commit-prompt step below; its promotion record
   is written before that commit and so carries no `commit` sha.
2. **Record the promotion**, for an r1/r3 edit once that commit lands, for an r2 edit once the write
   completes: write the JSON (`title`, `promotionType`, `clusterSignature`, `filesTouched`, `landed`,
   `commit` (empty for r2), `pluginVersion`, `sourcedFromMemory`, plus `culpritId`, `rung`,
   `audience`, `verify` and `aliases`) to a scratch file and pass it with the double-quoted
   `$(cat …)` form, never inline single quotes:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/dream.mjs" --record-promotion "$(cat <scratch-file>)"`.
3. **Offer to commit the freshly written output.** Resolve `${user_config.docTrackingPolicy}`
   (default `standard`). When it permits tracking — `standard` or `all-tracked`, never `all-local`
   — **and** `git check-ignore <path>` vetoes none of the just-written paths, name the side effect
   and **ask the user** (AskUserQuestion, mirroring **Confirm**'s per-item batching, 1–4 at a time)
   whether to commit the freshly written `docs/devcycle/lessons.md` and its promotion records as one
   scoped Conventional commit: `git add <paths> && git commit -- <paths>` with a `docs(learn): …` or
   `chore(learn): …` subject, respecting `${CLAUDE_PLUGIN_ROOT}/references/branch.md`'s Committing
   rule — the prompt is where the user declines on a protected branch. Never a silent `git add`: any
   path the policy excludes, `git check-ignore` vetoes, or the user leaves declined stays written but
   uncommitted.
4. **Delete the source memory once its promotion lands, and only if it has one.**

Finally re-render the report in outcome mode —
`--render-report <candidates.json> --outcome` — so the proposal and the outcome are diffable, and
rewrite the checkpoint's two lines: `last-run:` to now, the version to the installed one.

## Entry points

`/devcycle:learn` runs the default loop; `/devcycle:learn --preview` runs the preview; neither emits a handoff block.
