# Scenario: cross-session-evidence
- Skill under test: devcycle:dreaming-across-sessions (invoked via `/devcycle:dream`)
- Type: output-shape

Benchmark criterion C1 (scored 0/29 under the old raw-transcript design, and could not be
expressed as a test at all before the map→reduce rewrite): when two separate sessions'
observation records share a `subject`, does the reduce stage merge them into **one**
candidate that cites **both** session ids — instead of either candidate standing alone, or
the merged candidate's claim reaching past what the two `quote` anchors actually show?

## Setup

A sandboxed `$HOME` for the whole subagent process (credentials under its `.claude`, which
is also the run's isolated config directory — same isolation
`dual-invocation-checkpoint.md` uses). The transcript corpus is a directory of the
scenario's own making, `<sandbox>/dream-corpus/`, exported as `CLAUDE_DREAM_PROJECTS` —
**never** the directory the harness writes its own session transcript into
(`$HOME/.claude/projects/<escaped repo root>/`), per the fixture-placement rule; the two
stay apart for the whole run.

**Profile, pinned explicitly.** Write `.devcycle/state.md` in the repo checkout at:
```markdown
# devcycle pipeline state
- stage: none
- configured: 2026-07-01 profile=standard
```
`profile=standard` is what this scenario is written against — `references/config.md`'s
resolution order (rule 4) reads this line ahead of the unset-placeholder default, so the
run is pinned rather than relying on "standard happens to be the fallback." Splice the
full body of `references/config.md` into the prompt too (below): the spliced SKILL text
points at it (`skills/dreaming-across-sessions/SKILL.md:16`), and a spliced pointer to a
file the sandbox never places is the dangling-reference pitfall `CONTRIBUTING.md:39-41`
warns about.

Inside `<sandbox>/dream-corpus/<escaped repo root>/` (`<escaped repo root>` is whatever
`dream.mjs`'s current escaping rule derives from the sandbox repo checkout's absolute
path — every non-alphanumeric character becomes its own `-`; do not hardcode a slug), two
minimal real session transcripts, so `--plan` enumerates two real sessions:

- `a1b2c3d4.jsonl` — one record, `"timestamp": "2026-07-20T15:04:00Z"`, ordinary
  placeholder message content (its text is never mined directly in this scenario — see
  below).
- `e5f6a7b8.jsonl` — one record, `"timestamp": "2026-07-27T09:41:00Z"`, same shape.

Pre-seed the observation store directly, bypassing Map, so the run tests **Reduce** in
isolation:

- `.devcycle/dreaming/observations/memory.json` — `[]` (the memory slice is already
  mined; a fake memory directory with an empty `MEMORY.md` index sits under
  `$HOME/.claude/projects/<escaped repo root>/memory/` to match).
- `.devcycle/dreaming/observations/a1b2c3d4-corrections.json`:
  ```json
  [
    {
      "session": "a1b2c3d4",
      "ts": "2026-07-20T15:04:00Z",
      "kind": "correction",
      "subject": "retry fires before the prior request settles, causing duplicate submits",
      "target": "src/lib/http-client.js",
      "quote": "the retry doesn't cancel the in-flight request, so a slow response gets double-submitted",
      "confidence": "high"
    }
  ]
  ```
- `.devcycle/dreaming/observations/e5f6a7b8-corrections.json`:
  ```json
  [
    {
      "session": "e5f6a7b8",
      "ts": "2026-07-27T09:41:00Z",
      "kind": "correction",
      "subject": "retry fires before the prior request settles, causing duplicate submits",
      "target": "src/lib/http-client.js",
      "quote": "same duplicate-submit bug hit again in the payment flow before the retry backoff kicked in",
      "confidence": "high"
    }
  ]
  ```

No `.devcycle/dreaming/state.md` exists yet (first dream, first checkpoint), so `--plan`'s
`since` is `null` and both sessions are in window.

**Confirm on disk before running** (the check `dual-invocation-checkpoint.md:36-39` teaches):
`node scripts/dream.mjs --plan`, run from the sandbox repo root with
`CLAUDE_DREAM_PROJECTS` set as above, reports `observations` containing exactly `memory`,
`a1b2c3d4-corrections`, `e5f6a7b8-corrections` — and `unmined` containing **both**
`a1b2c3d4` and `e5f6a7b8`. That is expected, not a broken sandbox: `unmined` is the
raw-transcript stage's own work list, keyed on the bare session id
(`scripts/dream.mjs:440`, `hasObservations` at `scripts/dream.mjs:21-23`), and neither
session has a bare `<id>.json` file — only its `-corrections` slice does. At
`profile=standard` the raw-transcript stage is never admitted at all
(`references/config.md`'s dreaming-depth row; `skills/dreaming-across-sessions/SKILL.md:96`
puts raw transcripts at `thorough` only), so that non-empty `unmined` list is never acted
on. What actually empties Map's dispatch list for the two admitted stages (memory, each
session's own correction-turn slice) is that each of *those* slices' own observation file
already exists — `skills/dreaming-across-sessions/SKILL.md:41-43`: "Every other stage's
own work list is that stage's own slice ids minus `observations`" — and `observations`
already lists all three.

**Sandbox mutation.** This run writes to `.devcycle/dreaming/observations/` (nothing new,
since every admitted slice is already seeded — but a broken engine could write here),
`.devcycle/dreaming/state.md`, and a dated artifact under `.devcycle/dreaming/`. Snapshot
the clean sandbox state (the files listed under Setup) after Setup and before the red run;
restore it before the green run.

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

1. **Exactly one candidate for the shared subject.** The dream artifact does not carry two
   separate candidates each naming only one of the two sessions.
2. **That candidate's supporting evidence names both session ids** (`a1b2c3d4` and
   `e5f6a7b8`) — not one alone with the other dropped.
3. **The candidate's claim states only what the two `quote` anchors show.** Nothing in its
   write-up (proposed edit, cluster signature, or supporting-evidence prose) asserts a
   detail neither quote actually contains — e.g. no invented root cause, no additional
   affected surface beyond `src/lib/http-client.js`.
4. **No duplicate.** No second candidate for the same normalized subject appears elsewhere
   in the artifact (Bulk or Requires explicit decision) — the merge in criterion 1 is the
   only representation of this finding.

## Baseline (red)

Not yet run — requires a credentialed isolated session per `CONTRIBUTING.md`'s protocol.
Expected red: before the map→reduce rewrite (Task 13), the reduce stage did not exist at
all — mining walked raw transcripts 1:1 with no stage that read more than one slice at
once, so no candidate could ever cite two sessions; this criterion was structurally
unaddressable, not merely unmet.

## Result (green)

Not yet run — same blocker. What would prove it: the run above, checked against criteria
1-4, with the dream artifact inspected on disk afterward.
