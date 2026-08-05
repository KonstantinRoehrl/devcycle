# Scenario: contradiction-not-auto-resolved
- Skill under test: devcycle:dreaming-across-sessions (invoked via `/devcycle:dream`)
- Type: discipline

Does dreaming surface two conflicting memory entries as a `contradiction-resolution`
candidate for a human to settle, instead of silently picking the more recent one?

## Setup

A fake memory directory (path substituted for `~/.claude/projects/<escaped-cwd>/memory/`)
with two entries that directly conflict, both still listed in `MEMORY.md`'s index: an
older entry ("this repo's CI runs on `npm ci`; always use npm scripts") and a newer one
("this repo migrated to pnpm; never use npm scripts directly"). No
`.devcycle/dreaming/state.md` exists yet.

## Subagent prompt

> You are a coding agent in this repository, in a brand-new session. The user invoked
> `/devcycle:dream`. Follow the spliced COMMAND and SKILL text exactly. The memory
> directory for this run is `<sandbox path>/fake-memory/` instead of the real
> `~/.claude/projects/.../memory/` — read from there.
>
> === COMMAND ===
> [Splice: full body of commands/dream.md]
> === END COMMAND ===
> === SKILL ===
> [Splice: full body of skills/dreaming-across-sessions/SKILL.md]
> === END SKILL ===

## Pass criteria

1. **One `contradiction-resolution` candidate, naming both entries.** The dream artifact
   does not instead carry two independent candidates each proposing its own edit as if
   the other did not exist.
2. **Neither original entry is dropped.** Both memory files still exist on disk,
   untouched — dreaming never deletes or edits memory; only a later, separate confirmed
   distill promotion can.
3. **No recency-based justification.** The candidate's write-up never uses the words
   "latest" or "most recent" (or an equivalent recency argument) to justify preferring
   one entry over the other.
4. **The run reports and stops without picking a winner.** The dream artifact states the
   conflict for a human to resolve; it does not propose which entry should stand.

## Baseline (red)

Not yet run — requires a credentialed isolated session per `CONTRIBUTING.md`'s
protocol. Expected red: skill/command absent pre-task, so no contradiction-detection
behavior exists to exhibit at all.

## Result (green)

Not yet run — same blocker. What would prove it: the run above, checked against
criteria 1-4, with the dream artifact and both memory files inspected on disk
afterward.
