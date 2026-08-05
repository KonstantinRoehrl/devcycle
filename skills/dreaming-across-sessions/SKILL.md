---
name: dreaming-across-sessions
description: Use when the session transcripts and memory accumulated for this repo since the last dream are ready for a cross-session consolidation pass — mining, clustering, and deduping recurring patterns and contradictions into promotion candidates for devcycle:distilling-learnings, screening every candidate and cluster signature for sensitive content. Read-only: writes only a dated dream artifact and its own checkpoint; promotes nothing itself.
---

# Dreaming across sessions

## Announce

State which scope this run covers: "I'm using the dreaming-across-sessions skill to
consolidate <the session/memory record since last-dreamed-through | the full history,
first run>."

## Profile

Resolve `profile` per `${CLAUDE_PLUGIN_ROOT}/references/config.md` (dreaming depth
row) — that row owns the matrix; the corpus it stages is: `lean` reads the **memory
store only**; `standard` adds **archives / findings / ledgers plus user-correction
turns**; `thorough` adds **raw transcripts**. `lean` still runs at every profile, so
the checkpoint keeps advancing and no backlog accumulates — and for the first time
`lean` has a real input, since the memory store is the thing it exists to dedup.

Also read the free-text `instructions` argument here, if one was given. This is a
**synthesis pass, not an editor**: instructions that steer *what the run looks for*
work; a line-targeted imperative ("change line 40 of X") is a no-op, because no stage
of this pipeline edits a file.

## Plan the corpus

Run the engine; never walk transcripts directly:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/dream.mjs" --plan
```

This prints the manifest as JSON: `since`, `cap`, `capped`, `sessions` (each with `id`,
`files`, `firstTimestamp`, `lastTimestamp`, `records`, `bytes`, `self`), `totalBytes`,
`observations` (every slice id already in the observation store), `unmined` (session
ids with no observation file yet — the raw-transcript stage's work list), `archives`,
`memoryDir`, `artifactFresh`, `artifactPath`. `bytes`/`totalBytes` mean a dispatch is
never handed an unreadable slice and a run can be budgeted before it starts. Every
other stage's own work list is that stage's own slice ids minus `observations` — the
same subtraction `unmined` already did for sessions (see Map, below). If
`artifactFresh` is true, read `artifactPath`, report it, and stop there — skip the
map, the reduce, screening, the recurrence check, the artifact rewrite, and the
checkpoint advance entirely. This is the path a distill run takes right after a
standalone preview; the sessions `--plan` just enumerated were never mined by this run,
so nothing below may advance the checkpoint past them. Report `capped: true` when the
cap bound the input; it is a normal outcome, not a failure.

## Map

Reached only when `artifactFresh` was false (see Plan the corpus above). Mechanical
observation extraction: one dispatch per unmined slice the profile admits, per
`${CLAUDE_PLUGIN_ROOT}/references/delegation.md`, **each pinned to the fast tier in the
dispatch itself, never inheriting the caller's model** — `${CLAUDE_PLUGIN_ROOT}/references/config.md`
owns what the fast tier resolves to. A session-sourced slice reads its text via the
engine, never by walking transcripts directly:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/dream.mjs" --extract <session-id>
```

Each dispatch reads only its own slice and writes that slice's observation records to
`.devcycle/dreaming/observations/<slice-id>.json`, an array of records shaped exactly:

```json
{
  "session": "f2a2877b",
  "ts": "2026-08-03T14:22:10Z",
  "kind": "correction",
  "subject": "scenario evidence sections omitted",
  "target": "CONTRIBUTING.md",
  "quote": "a reasonable, disclosed judgment call rather than a spec violation",
  "confidence": "high"
}
```

`kind` ∈ `friction | correction | rule-violation | decision | contradiction-side`.
`target` is a repo-relative path or `null`. `subject` is a normalized phrase and the
cross-session grouping key Reduce (below) clusters on. `quote` is a short verbatim
excerpt and the grounding anchor: **an observation may state only what its quote
shows.** A dispatch **returns a count, not content** — observations go to disk, so the
coordinator's context stays flat however large the corpus grows. A slice that already
has an observation file is not re-mined, which is what makes an interrupted run
resumable and a marginal run cheap.

**Which slices, by profile.** A slice is not only a session, and the memory store is
not optional:

| stage | slice source | `<slice-id>` | admitted at |
| --- | --- | --- | --- |
| memory store | the manifest's `memoryDir` — `MEMORY.md` and its linked entry files | `memory` | every profile, `lean` included |
| archives / findings / ledgers | each manifest `archives[]` entry, read via its `ledger.glob` + `index` and its `evidenceFiles` | `archive-<entry id>` | `standard`, `thorough` |
| user-correction turns | each manifest session, read via `--extract` and filtered to correction turns | `<session-id>-corrections` | `standard`, `thorough` |
| raw transcripts | each manifest session, read in full via `--extract` | `<session-id>` | `thorough` only |

`lean` mines the memory store and stops — the first time the profile whose entire job
is memory dedup has had an implemented input at all. Raw transcripts are the
lowest-density source available and were previously the *only* wired one, which is why
a `standard` dream extrapolated to millions of tokens; moving them to `thorough` puts
the expensive stage behind the profile where a user opted into the expense.

The map tier stays at fast rather than dropping further: precision inflation is
already the weakest measured axis (4 of 29 benchmark candidates embellished a real
finding), and trading a measured extractor for an unmeasured one on exactly that axis
is not a saving. Cost is governed by corpus depth now, not by tier.

## Reduce

A **single** dispatch reading the **full** observation store — not one slice of it —
**at the caller's tier**: this is genuine judgement, and the only stage at which
≥2-session evidence and cross-slice contradiction detection are possible at all. It
groups records by `subject`. It also reads `docs/devcycle/promotions/` and drops any
candidate whose subject matches a landed `cluster-signature`, so a durable store never
re-proposes work that already landed.

Roughly 120 tokens per observation record: at ~10 records per session across a
69-session corpus that is ~83k tokens, which fits a single reduce dispatch — the
property that makes cross-session comparison possible at all.

## Contradictions

Two candidates that conflict are never resolved by recency — "latest" or "most recent"
never settles which one is right, since it can silently reintroduce a mistake a prior
dream already corrected. Each conflicting pair becomes its own `contradiction-resolution`
candidate, both sides preserved, for explicit human resolution in distill's confirmation
step.

## Screen

Flag anything resembling a credential, an internal URL, or a proprietary snippet — in a
candidate's content **or in its cluster signature** — for explicit human attention
alongside the confirm/skip choice. A signature can be more revealing than the fix it
describes.

After screening, partition every candidate into the two parts the artifact carries:

- **Bulk** — ordinary `doc-edit`, `skill-edit`, and `enforcement-gap` candidates.
- **Requires explicit decision** — every sensitive-flagged candidate and every
  `contradiction-resolution`.

The partition is **written by the skill, not chosen by the reader**: a candidate cannot
be moved into the bulk to avoid a per-item decision, and that is what keeps the
sensitive-content and contradiction guarantees intact under a whole-artifact review.

## Check recurrence

Run the engine's recurrence match. It does not scan the corpus this run covers: each
recorded `cluster-signature` is matched against the full session corpus (capped,
self-excluded), windowed independently per promotion by that promotion's own `landed`
date — not by this run's `since`/covered range. A hit can therefore legitimately name a
session outside the range this artifact states below as its covered corpus.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/dream.mjs" --check-recurrence
```

It prints a JSON object with two keys: `hits`, an array holding one element per committed
promotion record that has at least one hit since that record's own `landed` date
(`recordPath`, `title`, `commit`, `landed`, `hits` — the matching session ids); and
`capped`, true when the session cap bound the corpus this match ran against, which makes
an empty or short `hits` list a possibly-incomplete answer rather than a clean bill of
health. Report `capped` alongside the results rather than dropping it.
It never prints the record's cluster-signature text — that text would land in this
session's own transcript, which is corpus for a later run, and self-seed as a permanent
hit against itself. A reader who needs the signature opens `recordPath`. Fold `hits`,
one entry per element, into the artifact's recurrence section below; render nothing when
it is empty.

## Write and checkpoint

Write `.devcycle/dreaming/<YYYY-MM-DD>-dream.md` in the two parts Screen above just
produced — a **Bulk** section and a **Requires explicit decision** section — each
holding one entry per candidate (type, cluster signature, supporting evidence with
session references — now genuinely plural, since a candidate can cite every session
whose observations shared its `subject` — proposed edit, sensitive flag if any), the
recurrence-check result above as its own "previously promoted — did it hold" section
(doctor renders this section rather than re-deriving it) — noting there, next to that
section's hits, that each is windowed from its own record's `landed` date rather than
from the covered range below, so a hit naming a session outside that range is expected,
not a contradiction — plus the covered range, session count, and whether the cap bound
the input (`capped`, kept in the artifact so doctor can render a cap-truncated result
distinguishably from an empty one). Then advance the checkpoint:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/dream.mjs" --commit-checkpoint <now, ISO-8601 UTC>
```

The other flag is called elsewhere, not by this skill: `--record-promotion <json>` by
`devcycle:distilling-learnings`, once per confirmed promotion.

## Standalone

`/devcycle:dream` is read-only: it reports the artifact above and stops. It promotes
nothing — only `devcycle:distilling-learnings`' own confirmation flow can, on a later,
separate run. It starts no cycle, writes no `.devcycle/state.md`, and emits no handoff
block.

Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.
