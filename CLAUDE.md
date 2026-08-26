# CLAUDE.md

Entry point for an agent working on devcycle's own source (not on a repo devcycle is
running against).

## What this is

devcycle is a Claude Code plugin. `commands/*.md` are its runtime entry points (what
`/devcycle:*` loads), `playbooks/*.md` are the behavior specs each stage follows, and
`references/*.md` are the shared mechanism docs those playbooks and commands point to
instead of restating. There is no build step and no `package.json` — scripts run directly
under Node. The pinned Node version is in `.nvmrc`.

## Commands you'll actually run

- `node scripts/validate.mjs`
- `node scripts/redaction-check.mjs`
- `node scripts/duplication-check.mjs`
- `node scripts/xref-check.mjs`
- `node --test tests/unit/*.test.mjs`
- `node scripts/doctor.mjs` (local only)
- `node scripts/find-state-files.mjs` — enumerates every `.devcycle/state.md` for `/devcycle:continue`'s resume discovery; Node-walks the tree so the gitignored `.devcycle/` can't hide a state file

## Before you trust a doc

Docs here have been wrong before — content read from a stale cache looked authoritative
and wasn't. Verify a doc's claim against the live repo directly: `commands/`, `playbooks/`,
`references/`, and `docs/README.md`.

## Structure changes and doc changes move together (§0.5)

A code or structure change here is not done until `README.md`, the relevant `docs/` page,
and the hub index reflect it — in the same change, not a follow-up.
