# Known issues

Open defects in devcycle's own engines, recorded so they are not rediscovered from scratch. Each
entry names the code it lives in and what goes wrong if it is left alone. Not a backlog of ideas:
everything here is a confirmed defect with a located cause. `CONTRIBUTING.md` owns what fixing one
means for its entry.

This file is the hand-curated store of confirmed defects in devcycle's own engines.
Maintenance-detected defects are recorded separately under
`docs/devcycle/maintenance-findings/`, each carrying an empty `lifecycle:` field until it is
resolved.

## Learn engine — `scripts/dream.mjs`

Three limits left open by the 2026-09-09 corpus-memory hardening, recorded with why each was
left rather than fixed.

### The whole-root fallback still opens every transcript (medium)

When no project slug matches the repo, `resolveProjectFiles` falls through to scanning every
transcript under `~/.claude/projects` and asking `sessionRepoMatches` whether each belongs to
this repo. That scan now stops at each file's first record carrying a `cwd` instead of parsing
the file whole, and memoizes one `git` call per distinct cwd — but it still opens every
transcript on the machine, so the fallback's cost still scales with sessions ever created
rather than sessions mined. The hardening attacked the trigger (the primary slug lookup now
unions the literal and realpath-resolved roots, so the fallback fires less often); nothing in
it makes a fallback itself cheap. Making one cheap needs an index the engine does not have.

### `sessionRepoMatches` misses a session that changed repos mid-run (low)

The scan decides on the first record carrying a `cwd` and stops. A session that started in
another repo and `cd`'d into this one is therefore classified by where it started, and no
longer matches — where the previous full-file scan would have found the later `cwd`. This is
the deliberate price of bounding the scan: a session's cwd is fixed in practice, and the early
exit is the only thing that bounds the fallback path at all. It costs recall only on the
fallback path, and only for a session that moved between repos.

### `--observations-deduped` still loads the whole observation corpus into memory (medium)

`readAllObservations` concatenates every mined slice's records into one array and dedupes it
there, so the reduce stage's memory scales with the observation store's total size. This is a
second memory path, independent of corpus planning, and the 2026-09-09 cycle did not address
it: its scope was which sessions a run reads, not how the mined output is later folded.
