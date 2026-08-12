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

A **single** dispatch reads the **full** observation store at the caller's tier — the only stage where
cross-session evidence and contradiction detection are possible at all. It groups records by
`subject` and runs `--check-suppressed "<subject>"`, dropping the candidate on `true`, so
a durable store never re-proposes work that already landed. It answers on one line as
`{"suppressed": true|false}` — read that key, never the absence of it — and never echoes the subject
or a landed cluster signature, either of which would self-seed as a permanent hit against this
session's own transcript in a later run.

**Contradictions are never resolved by recency** — "latest" can reintroduce a corrected mistake. Each
pair becomes a `contradiction-resolution` candidate, both sides kept, resolved by a human at Confirm.

**Screen** every candidate's content **and its cluster signature** for anything resembling a
credential, an internal URL, or a proprietary snippet, and flag it for human attention — a signature
can reveal more than the fix it describes. Then partition candidates into the artifact's two parts:
**Bulk** (ordinary `doc-edit`, `skill-edit`, `enforcement-gap`) and **Requires explicit decision**
(every sensitive-flagged candidate and every `contradiction-resolution`). The partition is **written
here, not chosen by the reader**: no candidate moves into the bulk to avoid a per-item decision.

**Recurrence** is skipped at `lean`, leaving the artifact's recurrence section empty — its `Profile:`
line is what lets doctor tell that apart from a check that ran and found nothing. At `standard` or
`thorough`, run `--check-recurrence`: each recorded `cluster-signature` is matched against the full
session corpus, windowed per promotion by that promotion's own `landed` date, so a hit may
legitimately name a session outside the range this artifact covers. Report its `capped` value beside
the hits — a short list under a bound cap is possibly incomplete, not a clean bill of health.

## Write the artifact

Write `.devcycle/dreaming/<YYYY-MM-DD>-dream.md`: the two partitioned sections, one entry per
candidate (type, cluster signature, supporting evidence with its session references, proposed edit,
sensitive flag); the recurrence result as its own "previously promoted — did it hold" section,
with the per-record windowing noted beside its hits; the covered range, session count and `capped`;
and a `Profile: <lean|standard|thorough>` line, which doctor reads. Then advance the corpus
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
   **before** asking: how many promotion records will be written, how many memories deleted. An Other answer to any question here appends `user-correction-at-gate`, the rule `${CLAUDE_PLUGIN_ROOT}/references/ledger.md` owns.

If the engine errors, times out, or leaves its corpus unreadable, report that and continue with raw
1:1 memory-entry batching: mining never blocks landing, and its failure is never silently swallowed.

## Land

Follow `${CLAUDE_PLUGIN_ROOT}/references/branch.md`'s Committing rule first (a topic branch off any
default or integration branch), minus its `branch:`-line write. Then, per adopted candidate:

1. **Apply the edit** and commit it scoped per
   `${CLAUDE_PLUGIN_ROOT}/references/commit-convention.md`'s "Scoping the commit". Any playbook
   file touched here is checked first against `tests/unit/golden-path.test.mjs`, `scripts/validate.mjs`, `scripts/redaction-check.mjs`, and `scripts/duplication-check.mjs`.
2. **Record the promotion** once that commit lands: write the JSON (`title`, `promotionType`,
   `clusterSignature`, `filesTouched`, `landed`, `commit`, `pluginVersion` — the plugin's own
   `.claude-plugin/plugin.json` version — and `sourcedFromMemory`, whether this candidate came from
   a memory entry, which step 3 below already knows) to a scratch file and pass it with the
   double-quoted `$(cat …)` form, never inline single quotes, which an apostrophe in
   `clusterSignature` breaks outright:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/dream.mjs" --record-promotion "$(cat <scratch-file>)"`. The
   record lands in `docs/devcycle/promotions/` under an explicit pathspec alongside the edit it
   describes — or, where `git check-ignore` covers that path, written and left uncommitted, the same
   guard `${CLAUDE_PLUGIN_ROOT}/playbooks/reviewing-code.md` and
   `${CLAUDE_PLUGIN_ROOT}/playbooks/onboarding-a-repo.md` apply to their own artifacts.
3. **Delete the source memory once its promotion lands, and only if it has one.** Most candidates
   come from transcripts and carry no memory entry: deleting nothing is then the normal outcome, not
   a skipped step. A landed promotion never deletes an entry it did not come from; a declined one
   leaves its memory untouched.

Finally rewrite the checkpoint's two lines: `last-run:` to now, the version to the installed one.

## Entry points

`/devcycle:learn` runs the default loop; `/devcycle:learn --preview` runs the preview; neither emits a handoff block.
