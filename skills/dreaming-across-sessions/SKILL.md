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
`artifactFresh`, `artifactPath`. If `artifactFresh` is true, read `artifactPath` and skip
mining entirely — this is the path a distill run takes right after a standalone preview.
Report `capped: true` when the cap bound the input; it is a normal outcome, not a
failure.

## Mine

At `standard` or `thorough`, dispatch mining subagents per
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

## Write and checkpoint

Write `.devcycle/dreaming/<YYYY-MM-DD>-dream.md`: one section per candidate (type,
cluster signature, supporting evidence with session references, proposed edit, sensitive
flag if any), plus the covered range, session count, and whether the cap bound the
input. Then advance the checkpoint:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/dream.mjs" --commit-checkpoint <now, ISO-8601 UTC>
```

The other two flags are called elsewhere, not by this skill: `--record-promotion <json>`
by `devcycle:distilling-learnings`, once per confirmed promotion; `--check-recurrence` by
`devcycle:doctor`, to check whether a past promotion's pattern reappeared.

## Standalone

`/devcycle:dream` is read-only: it reports the artifact above and stops. It promotes
nothing — only `devcycle:distilling-learnings`' own confirmation flow can, on a later,
separate run. It starts no cycle, writes no `.devcycle/state.md`, and emits no handoff
block.

Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.
