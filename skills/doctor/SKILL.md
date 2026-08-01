---
name: doctor
description: Use when a Claude Code session or transcript history needs profiling for token cost, context depth, model routing, or agent startup cost — running the analyzer and ranking what it finds by dollar impact, each with the concrete lever that changes it.
---

# Doctor

## Announce

State which scope this run covers: "I'm using the doctor skill to profile <this session |
the transcript history | the window>."

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

- skill attribution is sticky — sessions whose devcycle work continued past the last skill
  invocation are under-counted;
- the context-budget bands are a fraction-based approximation, not a measurement of absolute
  cache-read cost.

Hiding either in the interpretation would make the report read as more certain than it is.

## Standalone

This run starts no cycle, writes no `.devcycle/state.md`, and emits no handoff block.

Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.
