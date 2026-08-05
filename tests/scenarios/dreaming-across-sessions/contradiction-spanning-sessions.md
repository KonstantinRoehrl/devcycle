# Scenario: contradiction-spanning-sessions
- Skill under test: devcycle:dreaming-across-sessions (invoked via `/devcycle:dream`)
- Type: discipline

Two sessions hold opposite `contradiction-side` observations on the same `subject`, aimed
at two *different* files. Does reduce fold them into **one** `contradiction-resolution`
candidate landing in the artifact's **Requires explicit decision** part — rather than the
old design's failure mode, two independent edits proposed against two different files as
if the other session did not exist, which would have written conflicting rules into the
repo had both been confirmed?

## Setup

Same isolation as `cross-session-evidence.md`: a sandboxed `$HOME` for the whole subagent
process, `CLAUDE_DREAM_PROJECTS` pointing at a scenario-owned `<sandbox>/dream-corpus/`,
kept apart from the directory the harness writes its own session transcript into.

**Profile, pinned explicitly**, same mechanism as `cross-session-evidence.md`: write
`.devcycle/state.md` in the repo checkout:
```markdown
# devcycle pipeline state
- stage: none
- configured: 2026-07-01 profile=standard
```
and splice the full body of `references/config.md` into the prompt (below) — the spliced
skill text points at it (`skills/dreaming-across-sessions/SKILL.md:16`), so leaving it
unplaced would be the dangling-reference pitfall `CONTRIBUTING.md:39-41` warns about.

Inside `<sandbox>/dream-corpus/<escaped repo root>/`, two minimal real session
transcripts:

- `b2c3d4e5.jsonl` — one record, `"timestamp": "2026-07-18T11:02:00Z"`.
- `f6a7b8c9.jsonl` — one record, `"timestamp": "2026-07-25T16:30:00Z"` — the **later** of
  the two, so a recency-based resolution would (wrongly) favor this side.

Pre-seed the observation store directly, same reasoning as `cross-session-evidence.md` —
this scenario grades Reduce and the Screen-stage partition, not Map:

- `.devcycle/dreaming/observations/memory.json` — `[]` (fake memory dir with an empty
  `MEMORY.md` index under `$HOME/.claude/projects/<escaped repo root>/memory/`).
- `.devcycle/dreaming/observations/b2c3d4e5-corrections.json`:
  ```json
  [
    {
      "session": "b2c3d4e5",
      "ts": "2026-07-18T11:02:00Z",
      "kind": "contradiction-side",
      "subject": "the dashboard's date column formats as YYYY-MM-DD or DD/MM/YYYY",
      "target": "docs/dashboard.md",
      "quote": "always render the date column as YYYY-MM-DD — every other surface in this app is ISO already",
      "confidence": "high"
    }
  ]
  ```
- `.devcycle/dreaming/observations/f6a7b8c9-corrections.json`:
  ```json
  [
    {
      "session": "f6a7b8c9",
      "ts": "2026-07-25T16:30:00Z",
      "kind": "contradiction-side",
      "subject": "the dashboard's date column formats as YYYY-MM-DD or DD/MM/YYYY",
      "target": "src/dashboard/format.js",
      "quote": "render the date column as DD/MM/YYYY — that's what the existing dashboard tests assert",
      "confidence": "high"
    }
  ]
  ```

No `.devcycle/dreaming/state.md` exists yet (first dream, first checkpoint), so `--plan`'s
`since` is `null` and both sessions are in window.

**Confirm on disk before running:** `node scripts/dream.mjs --plan` (same env) reports
`observations` containing exactly `memory`, `b2c3d4e5-corrections`, `f6a7b8c9-corrections`
— and `unmined` containing **both** `b2c3d4e5` and `f6a7b8c9`. That is expected, not a
broken sandbox, for the identical reason `cross-session-evidence.md` documents: `unmined`
is the raw-transcript stage's own work list (`scripts/dream.mjs:440`, keyed on the bare
session id via `hasObservations`, `scripts/dream.mjs:21-23`), and at `profile=standard`
the raw-transcript stage is never admitted (`skills/dreaming-across-sessions/SKILL.md:96`
puts it at `thorough` only). What actually empties Map's dispatch list for the admitted
stages (memory, each session's own correction-turn slice) is that `memory`,
`b2c3d4e5-corrections`, and `f6a7b8c9-corrections` already have observation files —
`skills/dreaming-across-sessions/SKILL.md:41-43`'s "that stage's own slice ids minus
`observations`" comes back empty for both.

**Sandbox mutation.** This run writes to `.devcycle/dreaming/observations/`,
`.devcycle/dreaming/state.md`, and a dated artifact under `.devcycle/dreaming/`. Snapshot
the clean sandbox state after Setup and before the red run; restore it before the green
run.

## Subagent prompt

> You are a coding agent in this repository, in a brand-new session. The user invoked
> `/devcycle:dream`. Follow the spliced COMMAND and SKILL text exactly.
>
> === COMMAND ===
> [Splice: full body of commands/dream.md]
> === END COMMAND ===
> === SKILL ===
> [Splice: full body of skills/dreaming-across-sessions/SKILL.md]
> === END SKILL ===
> === REFERENCE (referenced by the skill as references/config.md) ===
> [Splice: full body of references/config.md]
> === END REFERENCE ===

## Pass criteria

1. **Exactly one `contradiction-resolution` candidate** for this subject — the artifact
   never carries two independent `doc-edit` candidates, one proposing the ISO format
   against `docs/dashboard.md` and another proposing `DD/MM/YYYY` against
   `src/dashboard/format.js`, as if each were the whole story.
2. **Both sides are preserved**, each still naming its own session id (`b2c3d4e5` for the
   ISO side, `f6a7b8c9` for the `DD/MM/YYYY` side) and its own target file — neither side
   is dropped or merged into a single averaged proposal.
3. **The candidate lands in the artifact's "Requires explicit decision" part**, not
   "Bulk" — `contradiction-resolution` is one of the two types Screen always escalates,
   regardless of how the partition would otherwise fall.
4. **No recency-based resolution.** The candidate's write-up never uses "latest," "most
   recent," or an equivalent recency argument to justify preferring the `DD/MM/YYYY` side
   (`f6a7b8c9`, the later session) — the contradiction is stated for a human to resolve,
   not settled by which side happened to run last.

## Baseline (red)

Not yet run — requires a credentialed isolated session per `CONTRIBUTING.md`'s protocol.
Expected red: before the map→reduce rewrite (Task 13), mining had no stage that read
across sessions at once, so two opposite-side observations aimed at different files could
only ever surface as two independent per-session candidates — the two-file failure mode
this scenario exists to catch, not merely an unmet assertion.

## Result (green)

Not yet run — same blocker. What would prove it: the run above, checked against criteria
1-4, with the dream artifact inspected on disk afterward.
