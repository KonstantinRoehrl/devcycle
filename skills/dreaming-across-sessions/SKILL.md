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
row): `lean` merges duplicate memory entries and stops; `standard` adds cross-session
pattern mining; `thorough` adds the scratch-code pass.

## Plan the corpus

Run the engine; never walk transcripts directly:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/dream.mjs" --plan
```

This prints the manifest as JSON: `since`, `cap`, `capped`, `sessions` (each with `id`,
`files`, `firstTimestamp`, `lastTimestamp`, `records`), `archives`, `memoryDir`,
`artifactFresh`, `artifactPath`. If `artifactFresh` is true, read `artifactPath`, report
it, and stop there — skip mining, clustering, screening, the recurrence check, the
artifact rewrite, and the checkpoint advance entirely. This is the path a distill run
takes right after a standalone preview; the sessions `--plan` just enumerated were never
mined by this run, so nothing below may advance the checkpoint past them. Report
`capped: true` when the cap bound the input; it is a normal outcome, not a failure.

## Mine

Reached only when `artifactFresh` was false (see Plan the corpus above). At `standard`
or `thorough`, dispatch mining subagents per
`${CLAUDE_PLUGIN_ROOT}/references/delegation.md` — one dispatch per manifest slice (a
session's files, or an archived cycle's ledger and evidence), **each pinned to the fast
tier in the dispatch itself, never inheriting the caller's model**. Each dispatch reads
only its own slice and returns structured candidates, never file contents.

## Cluster

Merge duplicate memory entries outright. Cluster the rest by intent. For the
`thorough`-only scratch-code pass, the clustering key is the task brief, finding, or
invariant description a recurring script or fixture was checking — never the code text
itself: two implementers checking the same invariant rarely write textually similar
code, so clustering on code would under-report the recurrence.

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

Write `.devcycle/dreaming/<YYYY-MM-DD>-dream.md`: one section per candidate (type,
cluster signature, supporting evidence with session references, proposed edit, sensitive
flag if any), the recurrence-check result above as its own "previously promoted — did it
hold" section (doctor renders this section rather than re-deriving it) — noting there,
next to that section's hits, that each is windowed from its own record's `landed` date
rather than from the covered range below, so a hit naming a session outside that range is
expected, not a contradiction — plus the covered range, session count, and whether the
cap bound the input. Then advance the checkpoint:

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
