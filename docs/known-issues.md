# Known issues

Open defects in devcycle's own engines, recorded so they are not rediscovered from scratch. Each
entry names the code it lives in and what goes wrong if it is left alone. Not a backlog of ideas:
everything here is a confirmed defect with a located cause. `CONTRIBUTING.md` owns what fixing one
means for its entry, and how this file, the maintenance-findings store under
`docs/devcycle/maintenance-findings/`, and GitHub split defect state.

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

## Session profiler — `scripts/doctor.mjs`

### Memory is bounded by the largest session, not by the corpus (low)

`run()` summarizes the transcript corpus one session at a time (`summarizeCorpus`), so peak memory
tracks the largest single session — its main transcript plus its subagents' — plus one small summary
object per session, and no longer the whole corpus. A session's records are still held together
while it is summarized, because
membership (`isDevcycleSession`) and the session id are decided over every record of the session
before a window narrows what is measured. A single transcript larger than Node's default heap would
therefore still abort the run. It was left rather than fixed because streaming within one session
would need a two-pass read — membership first, then the window — for a case no corpus has produced.
If one does, `NODE_OPTIONS=--max-old-space-size=<MB>` is the stop-gap.

## Execution driver — `scripts/drive-execution.mjs`

Limits of unattended execution, recorded with why each was left rather than fixed.

### POSIX only (low)

The driver starts each session as the leader of its own process group and stops it by signalling
that group (`killGroup` in `workflows/lib/agent-cli.js`). Windows has no process groups in that
sense, so an interrupted driver there would leave its session running and committing. It is
documented as a limit rather than ported: a port needs a Windows equivalent of group signalling
that nothing in devcycle provides.

### `claude-haiku-5-5` is refused on an assumed 200k window (low)

`scripts/pricing.mjs` has no row for `claude-haiku-5-5`, so `windowFor` in `scripts/depth-bands.mjs`
takes its window from `claude-haiku-4-5-20251001` (200k). The driver's pre-flight refuses a model
whose window puts a session start (~55k tokens) in the over-budget band or past it, which that
assumption does, although Claude Code 2.1.294 reports `contextWindow: 1000000` for the model
(`docs/platform-notes.md` § (k)); the depth probe bands a fresh session on it `over-budget` for the
same reason. The fix is a pricing row, filed as its own issue.

### Sweep tasks' ledger lines carry no idempotency key (low)

The task scripts append every ledger line under a lockfile with a `key=` that makes a crash re-run
append nothing twice, but a sweep task's `dispatched outcome=sweep` and `report-received` lines are
still appended by hand as `references/sweep-execution.md` describes, with no key and no lock. A
driven session that dies between a sweep's dispatch and its report, then re-runs it, can leave a
duplicate line; the resume table still reads the task's position correctly, so the cost is a noisier
ledger, not a wrong resume.

### A starter killed while reclaiming a stale lock blocks the next start (low)

A driver replaces a stale `.devcycle/drive.lock` only while it holds a second file,
`.devcycle/drive.lock.reclaim`, so two starters can never both take over the same dead lock. A
starter killed with `kill -9` in the few system calls between taking that file and removing it
leaves it behind, and every later start exits 1 with `drive-lock: a starter died while reclaiming …`
(a `--detach` start prints its PID first and reports the failure in `.devcycle/drive.log`). It is
left rather than fixed because guessing that the reclaimer is gone could let two drivers share a
checkout. When no driver runs, remove both files by hand.

### Some dead drivers' locks need removing by hand, and a clone's can be reclaimed (low)

`scripts/drive-lock.mjs` asks about a lock's process only from the same machine id, boot and pid
namespace; any other lock counts as live, except one from another boot of this machine id whose
process started before this boot, which is taken for a lock a reboot left. So a driver that died
inside a container that has since restarted (a new pid namespace) leaves a lock every later start
refuses, and the lock of a driver on a cloned VM that shares this machine's id and started before
this machine last booted is taken for a reboot's and reclaimed. It is left rather than fixed because nothing
cheap tells a reboot from a clone that booted earlier. When no driver runs, remove the lock by hand.

### The runtime resolves the default branch without `gh` (low)

`references/branch.md` asks `gh` for the default branch when `origin/HEAD` is unset; the scripts
that run during execution (`defaultBranches` in `scripts/branch-names.mjs`, used by the driver,
`scripts/wave-setup.mjs` and `scripts/task-commit.mjs`) skip that step and, without `origin/HEAD`,
treat every local branch among `git config init.defaultBranch`, `main` and `master` as the default,
so a resume never waits on the network. A repo with none of them gets no driver: its pre-flight
exits 3 and names the fix.
