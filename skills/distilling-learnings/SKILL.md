---
name: distilling-learnings
description: Use when the current repo's accumulated auto-memory entries are ready for a codified promotion session — turning vetted memory into doc or skill edits, checking for devcycle config drift since the last run, batching every promotion for confirmation, and deleting each memory once its promotion lands. Side-effectful (edits docs/skills, deletes memories); invoke only via /devcycle:distill.
---

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
3. **Batch the proposed promotions.** `AskUserQuestion`, 1-4 at a time: each memory →
   proposed doc/skill edit, and each drift finding → a concrete stale-line fix. Never
   more than 4 in one batch; never proceed on an item the user has not confirmed.
4. **Apply confirmed edits.** Any skill file touched in this step gets
   `superpowers:writing-skills`-style scenario testing before landing — the same TDD
   discipline every skill in this repo already carries.
5. **Delete the source memory on promotion.** Reusing the existing convention verbatim
   (DESIGN.md:248: "once encoded, corresponding personal memories... are deleted") — no
   new deletion convention invented. A memory whose promotion the user declined is left
   in place, untouched.
6. **Rewrite the checkpoint** — `last-run:` to now, `last-reviewed-devcycle-version:` to
   the installed `plugin.json` version.

## Entry point

`/devcycle:distill`, standalone: no `.devcycle/state.md` touch, no handoff block — the
same shape as `devcycle:doctor`/`devcycle:audit`.
