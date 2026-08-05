---
description: "Consolidate this repo's accumulated session transcripts and memory since the last dream — mining, clustering, and deduping recurring patterns and contradictions into promotion candidates, screened for sensitive content, and written to a dated dream artifact. Read-only and standalone: promotes nothing itself, advances only its own checkpoint."
disable-model-invocation: true
---

# /devcycle:dream

Consolidate the session transcripts and memory accumulated for this repo since the
last dream into curated, deduped promotion candidates, and write them to a dated
artifact for later review. Never promotes anything itself.

`$ARGUMENTS`, if given, is free-text `instructions` passed to the skill alongside the
resolved `profile`: steer *what the run looks for* (e.g. "focus on testing
conventions"). This is a synthesis pass, not an editor — a line-targeted imperative
("change line 40 of X") is a no-op, because no stage of this pipeline edits a file.

Use the `devcycle:dreaming-across-sessions` skill. It starts no cycle and keeps its own
checkpoint at `.devcycle/dreaming/state.md`, separate from `.devcycle/state.md` and from
`distilling-learnings`' own `.devcycle/distilling-state.md`.

Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.
