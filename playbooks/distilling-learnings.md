# Distilling learnings

## Announce

"I'm using the distilling-learnings skill to review this repo's accumulated memory for
promotion."

## Inbox source

The real global auto-memory system for the current repo:
`~/.claude/projects/<escaped-cwd>/memory/` — escaping rule: absolute cwd, every `/`
replaced with `-`. `MEMORY.md` is the index; its linked entry files are the content.

## Checkpoint

Read (or, on first run, initialize) `.devcycle/distilling-state.md`:

```markdown
# distilling-learnings checkpoint
- last-run: <ISO-8601 UTC, or "never">
- last-reviewed-devcycle-version: <semver, or "none">
```

This is `distilling-learnings`' own small persisted artifact — not part of the
pipeline's `.devcycle/state.md`, and read/rewritten only by this skill.

## Session flow

0. **Consolidate first.** Run `${CLAUDE_PLUGIN_ROOT}/playbooks/dreaming-across-sessions.md` — the same
   one-engine-two-callers reuse this skill already applies to doctor's drift engine. Its
   candidates replace raw 1:1 memory entries as the input to the batching below, and
   include instruction, guideline, and skill-definition clarifications sourced from
   repeated bugs and recurring friction — not only captured facts.

   If the dream errors, times out, or leaves its corpus unreadable, report the failure and
   continue with raw 1:1 memory-entry batching. A dream never blocks a distill run, and its
   failure is never silently swallowed. A `capped: true` manifest is not a failure — it is
   a bounded run, reported as such.
1. **Read memories accumulated since `last-run:`.** Entries in `MEMORY.md` and their
   linked files, filtered by modification time where the memory system exposes it, or
   the full set on first run.
2. **Check for devcycle config drift.** Compare `last-reviewed-devcycle-version:`
   against the currently installed devcycle `plugin.json` `version`. If the installed
   version is newer, call doctor's config-drift mode against the user's global
   `CLAUDE.md` and any repo-level devcycle-wrapper skills found in the current repo:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --drift <path>
   ```

   (or `/devcycle:doctor drift <path>` as the user-facing form) — reusing doctor's
   drift engine rather than re-implementing stale-key detection.
3. **Dispose of the dream artifact in two tiers.** The artifact
   (`.devcycle/dreaming/<YYYY-MM-DD>-dream.md`) is already partitioned by
   `${CLAUDE_PLUGIN_ROOT}/playbooks/dreaming-across-sessions.md` into a **Bulk** part (ordinary `doc-edit`,
   `skill-edit`, and `enforcement-gap` candidates) and a **Requires explicit decision**
   part (every sensitive-flagged candidate and every `contradiction-resolution`) — the
   partition is authored by the dream, never chosen here.

   - **Bulk**: one reviewed decision covers the whole part — adopt, discard, or
     adopt-with-exclusions. Exclusions are expressed by editing the artifact itself, so
     the reviewed document and the exclusion list are the same object.
   - **Requires explicit decision**: per-item `AskUserQuestion` confirmation, 1-4 at a
     time. A candidate is never moved out of this set to skip its round. A
     `contradiction-resolution` is still never resolved by recency; it requires an
     explicit human choice between the two preserved sides.

   This changes disposition *granularity*, never the *existence* of confirmation: the
   bulk decision is itself a review of the whole document, and nothing is ever
   auto-applied. Landing has side effects the confirmation must name before it is asked,
   not after: each adopted candidate writes a `docs/devcycle/promotions/<date>-<slug>.md`
   record (step 4), and — for the subset of adopted candidates that actually carry a
   source memory entry, typically fewer than the record count since most dreaming
   candidates are mined from session transcripts and carry none (step 5) — deletes that
   entry. State both counts, records to be written and memories to be deleted, against
   the candidate set on offer before the bulk decision or the first per-item
   `AskUserQuestion` is asked. Drift findings from step 2 are not dream candidates and are
   not part of this partition; they keep their own per-item `AskUserQuestion` batching,
   1-4 at a time, each → a concrete stale-line fix. On the step 0 dream-failure fallback
   (raw 1:1 memory-entry batching, no artifact to partition), every candidate stays at
   that same per-item batching.
4. **Apply confirmed edits.** Before writing anything, follow
   `${CLAUDE_PLUGIN_ROOT}/references/branch.md`'s Committing rule: if the checkout is on
   the default branch or an integration branch, create a topic branch first. This skill
   is standalone and owns no `.devcycle/state.md`, so skip that rule's `branch:`-line
   write — just create the branch and apply every edit below on it. Any skill file
   touched in this step gets `superpowers:writing-skills`-style scenario testing before
   landing — the same TDD discipline every skill in this repo already carries. Commit
   each applied edit scoped per
   `${CLAUDE_PLUGIN_ROOT}/references/commit-convention.md`'s "Scoping the commit" — read
   it there and follow it.

   Once the commit lands, record it. Write the JSON — `title`, `promotionType`,
   `clusterSignature`, `filesTouched`, `landed`, and `commit` — to a scratch file, then pass
   it through with the double-quoted `$(cat …)` form
   `playbooks/sweeping-mechanical-changes.md` already uses for the same reason: the
   file's contents ride through as one intact argument, so no escaping is needed no matter
   what the instruction contains (an apostrophe in `clusterSignature` breaks the inline
   single-quoted form outright). Never single-quote the JSON inline.

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/dream.mjs" --record-promotion "$(cat <scratch-file>)"
   ```

   The record goes to `docs/devcycle/promotions/`, which is committed — so it is visible to
   every developer on the repo, not only whoever ran the promotion. If `git check-ignore`
   covers that path, write the file and skip the commit: the repo's own ignore rules decide
   what lands in history, not this skill (same guard `playbooks/auditing-a-repo.md` and
   `playbooks/onboarding-a-repo.md` apply to their own committed artifacts). Otherwise
   commit it under an explicit pathspec alongside the edit it describes.
5. **Delete the source memory when the promotion has one.** Reusing the existing
   convention verbatim (DESIGN.md:248: "once encoded, corresponding personal memories...
   are deleted") — no new deletion convention invented. Most dreaming candidates are
   mined from session transcripts and carry no source memory entry at all; for those,
   deleting nothing is the normal outcome, not a skipped step. The contract stays
   narrow either way: a landed promotion never deletes a memory entry it did not come
   from — judging that one entry supersedes another is exactly where a wrong call
   silently destroys a fact. A memory whose promotion the user declined is left in
   place, untouched.
6. **Rewrite the checkpoint** — `last-run:` to now, `last-reviewed-devcycle-version:` to
   the installed `plugin.json` version.

## Entry point

`/devcycle:distill`, standalone: no `.devcycle/state.md` touch, no handoff block — the
same shape as `devcycle:doctor`/`devcycle:audit`.

Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.
