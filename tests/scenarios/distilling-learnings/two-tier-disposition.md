# Scenario: two-tier-disposition
- Skill under test: devcycle:distilling-learnings (via `/devcycle:distill`), which
  invokes devcycle:dreaming-across-sessions as its own step 0
- Type: discipline

A dream artifact holds several ordinary Bulk candidates plus one sensitive-flagged
candidate and one `contradiction-resolution`, both already in the artifact's own
"Requires explicit decision" part. Does distill dispose of the whole Bulk part in **one**
reviewed decision while still routing each of the two escalated candidates through its
**own** `AskUserQuestion` round — and, in both directions, never blur the boundary between
the two parts?

This scenario is scoped to confirmation-round *granularity* only. Memory deletion under
the two-tier partition (a landed Bulk candidate with no source memory entry vs. an
escalated candidate that does have one) is already covered by
`memory-deleted-on-promotion.md`'s own "two-tier disposition" regression section; nothing
here duplicates that.

## Setup

A sandbox repo, on `main`, with three plain target files a Bulk candidate can plausibly
edit: `README.md`, `docs/style.md`, and `skills/example-skill/SKILL.md`.

No session transcripts are needed: `CLAUDE_DREAM_PROJECTS` is exported pointing at an
*empty* scenario-owned directory (`<sandbox>/dream-corpus/`, created but with no session
files under it — an existing-but-empty directory, not a missing one, so `dream.mjs`
reports zero sessions rather than erroring). With zero sessions in the manifest, nothing
can ever look newer than the checkpoint, so the pre-authored artifact below reads as fresh
without needing any corpus content at all.

**Profile, pinned explicitly, for consistency with the other three new scenarios** (and
per `CONTRIBUTING.md`'s dangling-reference discipline, since step 0's spliced dream skill
text points at `references/config.md`): write `.devcycle/state.md` with
`configured: 2026-07-01 profile=standard`, and splice the full body of
`references/config.md` into the prompt below, under the DREAM SKILL splice. This value is
inert for what this scenario actually grades — `artifactFresh: true` (see below) means the
dream sub-invocation stops at Plan and never reaches Map, so no slice or profile column is
ever consulted for real — but pinning it removes the ambiguity a reader would otherwise
have to resolve by inference.

`.devcycle/dreaming/state.md`:
```markdown
# dreaming checkpoint
- last-dreamed-through: 2026-08-01T09:00:00Z
- last-artifact: .devcycle/dreaming/2026-08-01-dream.md
```

`.devcycle/dreaming/2026-08-01-dream.md` — the pre-authored, already-partitioned artifact:

```markdown
# Dream — 2026-08-01

## Bulk

1. **doc-edit** — cluster signature: "README's quickstart section omits the `--dry-run`
   flag, hit twice by new contributors." Supporting evidence: sessions `1111aaaa`,
   `2222bbbb`. Proposed edit: add a line documenting `--dry-run` to `README.md`'s
   quickstart section.
2. **doc-edit** — cluster signature: "docs/style.md's heading-case rule is undocumented,
   inferred wrong twice." Supporting evidence: session `3333cccc`. Proposed edit: add the
   heading-case rule to `docs/style.md`.
3. **skill-edit** — cluster signature: "example-skill's SKILL.md never states its
   read-only contract." Supporting evidence: session `4444dddd`. Proposed edit: add a
   one-line read-only contract statement to `skills/example-skill/SKILL.md`.

## Requires explicit decision

4. **doc-edit** — sensitive-flagged. Cluster signature: "repeated auth-bypass workaround
   in the login flow." Supporting evidence: session `5555eeee` — flagged for a
   credential-shaped string in the evidence excerpt. Proposed edit: document the
   workaround in `docs/style.md` with the credential-shaped string redacted.
5. **contradiction-resolution** — cluster signature: "the dashboard's date column formats
   as YYYY-MM-DD or DD/MM/YYYY." Side A (session `6666ffff`, targets `docs/style.md`):
   "always render the date column as YYYY-MM-DD." Side B (session `7777aaaa`, targets
   `README.md`): "render the date column as DD/MM/YYYY." Neither side is preferred by
   recency.

## Previously promoted — did it hold

(none — no promotions recorded yet)

## Covered

2026-07-01 to 2026-07-31, 7 sessions, capped: false
```

No `.devcycle/distilling-state.md` exists yet, *except* set
`last-reviewed-devcycle-version:` to the currently installed `plugin.json` version and
`last-run:` to an early date, so step 2's config-drift check is a clean no-op and does not
add its own confirmation round into the mix graded below:

```markdown
# distilling-learnings checkpoint
- last-run: 2026-07-01T00:00:00Z
- last-reviewed-devcycle-version: <installed plugin.json version>
```

**Sandbox mutation.** This run applies confirmed edits to `README.md`, `docs/style.md`,
and/or `skills/example-skill/SKILL.md` (once the Bulk decision lands), commits them on a
new topic branch, writes `docs/devcycle/promotions/` records, and rewrites
`.devcycle/distilling-state.md`. Snapshot the clean sandbox state (as pre-seeded above,
on `main`) after Setup and before the red run; restore it before the green run.

## Subagent prompt

> You are a coding agent in this repository, in a brand-new session. The user invoked
> `/devcycle:distill`. Follow the spliced COMMAND and SKILL text exactly, then STOP and
> wait for the user.
>
> === COMMAND ===
> [Splice: full body of commands/distill.md]
> === END COMMAND ===
> === SKILL ===
> [Splice: full body of skills/distilling-learnings/SKILL.md]
> === END SKILL ===
> === DREAM SKILL (for step 0's sub-invocation) ===
> [Splice: full body of skills/dreaming-across-sessions/SKILL.md]
> === END DREAM SKILL ===
> === REFERENCE (referenced by the dream skill as references/config.md) ===
> [Splice: full body of references/config.md]
> === END REFERENCE ===
>
> AskUserQuestion is unavailable — send any batch as a plain message with the same shape,
> then stop for the answer.

## Pass criteria

1. **The Bulk part is disposed of in one reviewed decision.** All three Bulk candidates
   (the two `doc-edit`s and the `skill-edit`) appear together in a single batched
   adopt/discard/adopt-with-exclusions confirmation — not three separate per-item rounds.
2. **The sensitive-flagged candidate gets its own individual confirmation round**,
   separate from the Bulk round and from the `contradiction-resolution`'s round.
3. **The `contradiction-resolution` candidate gets its own individual confirmation
   round**, separate from both of the above — three distinct rounds total (one Bulk, two
   escalated), never two, never one.
4. **The boundary holds in both directions.** Neither escalated candidate (4 or 5) is
   ever folded into the Bulk round — under-escalation — *and* neither Bulk candidate
   (1, 2, or 3) is ever pulled into a round of its own beyond the single Bulk
   confirmation — over-escalation. The run's batching matches the artifact's own
   Bulk/Requires-explicit-decision partition exactly, neither expanding nor shrinking
   either part.

## Baseline (red)

Not yet run — requires a credentialed isolated session per `CONTRIBUTING.md`'s protocol.
Expected red: before the two-tier partition existed, every dreaming candidate — bulk or
sensitive or contradictory alike — took the same flat per-item `AskUserQuestion` batching;
there was no "one reviewed decision covers several candidates" path to exercise at all, so
criterion 1 could not have passed against the prior design.

## Result (green)

Not yet run — same blocker. What would prove it: the run above, checked against criteria
1-4, with the confirmation turns inspected in order.
