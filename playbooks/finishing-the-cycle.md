# Finishing the Cycle

The pipeline's last stage: resolve the effective git policy, act on it, close the state file.
Both `/devcycle:cycle` and `/devcycle:continue` run the finish stage through this playbook —
the policy logic lives here and only here. It reports per
`${CLAUDE_PLUGIN_ROOT}/references/output.md`.

Read this stage's lessons: `node "${CLAUDE_PLUGIN_ROOT}/scripts/dream.mjs" --lessons finish`. No store, no output.

## Configured policy

Resolve `${user_config.gitPolicy}` per `${CLAUDE_PLUGIN_ROOT}/references/config.md`: allowed
values `local-commits-only` | `push-allowed` | `open-pr`, default `local-commits-only`. Call
the result the **configured policy**. Never offer the first-run configuration walkthrough here
— it belongs to `/devcycle:cycle` only.

## Resolve the effective policy

`local-commits-only` is already the floor: effective equals configured, no signal checks
needed. Otherwise (`push-allowed` or `open-pr`), check two signals before pushing anything:

- **Permission-settings signal:** read the effective Claude Code permission settings — project
  `.claude/settings.local.json`, project `.claude/settings.json`, user
  `~/.claude/settings.json`, and any managed/enterprise policy file present on this platform
  (read whichever exist; a missing file has no rules). The signal fires if any of them
  contains a `deny` rule whose pattern would match the literal `git push` command — e.g.
  `Bash(git push:*)`, `Bash(git:*)`, or a bare `Bash` deny. An `ask`-only rule (no matching
  `deny`) does NOT fire it — leave the configured policy alone; the normal permission prompt
  at push time communicates the restriction.
- **Protected-branch signal:** resolve the repo's release/default branch exactly as
  `${CLAUDE_PLUGIN_ROOT}/references/branch.md` resolves it — that file owns the resolution
  chain and this stage runs no other. The signal fires if the branch recorded in
  `.devcycle/state.md` (this cycle's branch) IS that default branch — devcycle never pushes
  directly to the repo's default branch.

If either signal fires, the **effective policy** for this run is `local-commits-only`
regardless of the configured value; otherwise effective equals configured. The clamp is silent
(no pause, no question) but always narrated in the handoff block below.

## Act on the effective policy

- `local-commits-only`: hand the branch back — report branch name and commits; do not push, do
  not open a PR.
- `push-allowed`: push the branch; NEVER merge it.
- `open-pr`: push the branch and open a PR, and do not merge it. Its title parses as a
  Conventional Commit and additionally matches whatever
  `${CLAUDE_PLUGIN_ROOT}/references/commit-convention.md` derived for this run, recorded at
  the top of `.devcycle/ledger.md`.

**Screen this cycle's real artifacts for privacy.** Constraint 4 (`.devcycle/scope.md`) is a
hard gate: `redaction-check.mjs` defaults to `git ls-files`, so gitignored `.devcycle/` has
never been screened by CI. Run it directly against what actually exists on this machine —
`node ${CLAUDE_PLUGIN_ROOT}/scripts/redaction-check.mjs --dir .devcycle` and `node
${CLAUDE_PLUGIN_ROOT}/scripts/redaction-check.mjs --dir
$(node -e "import('${CLAUDE_PLUGIN_ROOT}/scripts/run-record.mjs').then(m
=> console.log(m.runsDirForRepo(m.gitToplevel(process.cwd()))))")`. The second call screens only this
repo's own slice of the run-record store: `run-record.mjs` exports `gitToplevel(cwd)` and
`runsDirForRepo(toplevel)` — the latter resolving `DEVCYCLE_RUNS_DIR` (falling back to
`~/.claude/devcycle/runs`), the same base the mint step writes into, so a user with that variable
set is screened at the directory their records actually live in. The mint step
(`commands/cycle.md`, "Before the first confirmation") guarantees this directory exists by the
time finish runs. A non-zero exit stops
the finish stage — surface the specific finding to the user rather than silently continuing;
this screen exists because the CI screen (which covers only the committed schema and golden
fixture) structurally cannot see either directory. When the finding is redactable machine
identity, `node "${CLAUDE_PLUGIN_ROOT}/scripts/redaction-check.mjs" --auto-redact --dir <the same
dir>` rewrites the flagged spans in place (it requires an explicit `--dir`/`--file`); re-run the
screen after.

**Record the run's workload signature (before closing the state file).** Recover the run id
from `.devcycle/state.md`'s `run:` line and the branch base from its `branch:` line, which
records `(cut from <base-branch> at <sha>)` (the ledger's `Branch:` line carries the same). Pass
that `<sha>` as `--base`; the `<base-branch>` name works too, since git accepts `<base>...HEAD`
with a branch name. Read `requestKind` from the confirmed triage kind on the `request:`/`scope:`
lines. Then append the workload record:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/run-record.mjs" workload \
  --run <runId> --base <base-sha> --requestKind <feature|bug|refactor|audit|docs|chore> \
  --planned-task-count <count from the plan's Dispatch Map, 0 if execution was never reached> \
  --wave-count <wave count from the plan's Dispatch Map, 0 if none>
```

`diffStats` derives the file and line counts from git itself, so pass no line counts. A cycle
with no branch or no diff — an audit-only cycle, or a fast path that reached no commit — records
nothing; doctor treats a missing workload record as *workload-unknown*, never as zero work. This
append is counts-and-enums only: it never carries paths, prose, or diff content.

As this stage's final state-file write, set `stage: done` and a fresh `updated:` timestamp —
nothing remains to resume.

## Archive this cycle's audit trail

`.devcycle/ledger.md` is a single slot the next cycle overwrites, and the ephemeral set below
is offered for deletion — so without this step a finished cycle leaves no durable record for a
later consolidation pass to read.

Before copying the audit trail below, move every status file in `.devcycle/findings/` whose
verdict the run superseded into `.devcycle/archive-<YYYY-MM-DD>-<branch-slug>/`, per
`${CLAUDE_PLUGIN_ROOT}/references/loops.md`. A findings directory holding two contradicting
verdicts for one loop is a defect, not a record.

Then copy, never move, into `.devcycle/archive-<YYYY-MM-DD>-<branch-slug>/`: `ledger.md`, and
the `briefs/`, `evidence/`, `findings/`, and `reports/` directories. Use the cycle's own branch name,
slugified, and today's UTC date. The copy runs unconditionally and asks nothing: it only
duplicates files this stage already declines to delete, so it cannot lose work and cannot
change the finish verdict. A failed copy is reported and the stage continues.

## Clean up this cycle's ephemeral artifacts

After the state file is closed above and before the handoff block below, offer to remove the
files whose only purpose was to pass content between this cycle's dispatches.

1. **Enumerate.** The ephemeral set is exactly: `.devcycle/reports/*`, `.devcycle/evidence/*`,
   `.devcycle/findings/*`, `.devcycle/sweep-args-*.json`, `.devcycle/sweep-report*.json`, and
   any generated per-task brief files. Nothing else is a candidate.
2. **Show and ask.** Present the list and what it totals — file count and size — and ask for
   confirmation in one question, answered inside a cycle run: an Other answer appends
   `user-correction-at-gate`, whose rule `${CLAUDE_PLUGIN_ROOT}/references/ledger.md` owns.
3. **Remove only on an explicit yes.** Anything short of that leaves every file in place.

**Never removed, whatever the answer:** `.devcycle/state.md`, `.devcycle/ledger.md`,
`.devcycle/scope.md`, the spec, the plan, the checklist, and the on-device results — this
cycle's audit trail. Never anything tracked by git: check with `git ls-files --error-unmatch
<path>` and keep the file if it is tracked, rather than assuming a path under `.devcycle/` is
ignored in every repo. Never anything outside the repo root.

Cleanup never blocks the finish and never changes its verdict: a declined offer, or a removal
that fails, is reported and the stage completes regardless. The fast path and the sweep path
reach this stage too, so they inherit it.

## Handoff — the pipeline's final block

Emit the block per `${CLAUDE_PLUGIN_ROOT}/references/handoff.md`, with:

- `Stage completed:` finish.
- `Artifacts:` the branch, plus the PR URL if one was opened.
- `Git policy:` the one line no other stage's block carries, directly after `Artifacts:` — the
  resolved git policy. Not clamped: `Git policy: <value> (no override)`. Clamped: `Git policy:
  configured <value> → effective local-commits-only (<reason>)`, where `<reason>` is `a
  permission rule denies git push`, `current branch is the repo's default branch — direct
  pushes to it are not allowed`, or both joined with `; ` if both signals fired.
- `Carry-overs:` whatever is genuinely left open, or `none`.
- `Context action:` Continue — the cycle is over, nothing follows.
- `Compaction hint:` Keep nothing. The cycle is done.
