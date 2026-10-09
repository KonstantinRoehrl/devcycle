# Resuming a run (`/devcycle:continue`)

How any stage re-enters itself after an interruption. Skills name this file; none of
them restate it.

Every ask this file names sits on the run record a resume already carries: an Other answer at one
appends `user-correction-at-gate` to that run, whose rule `references/ledger.md` owns.

## The state file

A cycle's file lives at `<repo root>/.devcycle/state.md`, where repo root is
`git rev-parse --show-toplevel` of the working directory: never adopt one found in a
parent directory or another project's checkout. `commands/continue.md` enumerates every
`.devcycle/state.md` under this repo root, since a nested checkout or subproject may hold
one of its own; which of them to resume is the user's answer at its "ask which one" gate.
`/devcycle:cycle` writes it as its first action and every stage rewrites it at every
transition, in this shape:

```markdown
# devcycle state
- stage: <the stage to RESUME at; the enum lives in commands/cycle.md>
- root: <absolute repo toplevel this cycle belongs to>
- branch: <git branch> (cut from <base> at <sha>)
- request: <one line: what this cycle is building/fixing>
- kind: <feature|bug|refactor|audit|docs|chore>
- scope: <path or none>
- audit: <path or none>
- diagnosis: <path or none>
- spec: <path or none>
- plan: <path or none>
- plan-counts: planned=<n> waves=<n>
- ledger: .devcycle/ledger.md
- checklist: <path or none>
- run: <run id from scripts/run-record.mjs, or none>
- configured: <no | defaults | date [+ KEY=VALUE list]>
- knobs: <the resolver's knobs: line, verbatim after "knobs: ">
- updated: <ISO-8601 UTC>
```

`stage:` names the stage the NEXT session resumes at, never the one just completed.
`run:` is the run record's id, minted once per cycle and carried across `/clear` so a resumed
cycle appends to the same record rather than starting a second one.
`knobs:` is the persisted copy of the resolved knob values —
`references/config.md` § Knob channel owns who reads it. Only
`/devcycle:cycle`, `/devcycle:continue`'s knob-change question, and `/devcycle:continue` on a
state file that has no `knobs:` line yet write it; every other stage rewrite carries it forward
unchanged, like `kind:` and `plan-counts:`. `configured:` is carried forward the
same way; the next section owns its forms.
Three optional rows sit outside the template. Only `/devcycle:continue`'s knob comparison and the
knob-change question it gates write or drop the two `knobs-` rows, and only the opt-in gate at
planning's close writes `drive:`; every other rewrite carries all three forward, and
`/devcycle:cycle`'s `stage: done` reuse resets them with the rest.

- `- knobs-declined: <a fresh knobs: line's values>` — global values the user chose not to apply.
  **Keep this cycle's values** writes it, replacing any earlier row. While a comparison's fresh
  line still equals the row, the question is skipped and this cycle's values are kept. **Apply**
  drops it, and so does a comparison that prints nothing — the global values match the cycle's
  own `knobs:` line again, though they now differ from the row — so a later change asks afresh.
- `- knobs-changed: <stamp> <the compare lines joined by "; ">` — the first **apply** made before
  this cycle's ledger exists, so the run record's minted knobs are known superseded from that
  stamp; a second such apply leaves that row alone. This cycle's ledger exists once
  `.devcycle/ledger.md`'s `Plan:` header names the state file's `plan:` path. A ledger file whose
  header names another plan is a previous cycle's slot, and a `plan: none` cycle (fast path,
  sweep) never has one: neither is appended to. Once it exists, an apply appends a `task=config
  event=user-decision` line per `${CLAUDE_PLUGIN_ROOT}/references/ledger.md` instead, outcome
  `knobs changed mid-cycle: <the compare lines joined by "; ">`, ref `.devcycle/state.md`.
- `- drive: auto model=<id> opted=<stamp>` — the user chose unattended execution at
  `playbooks/planning-waves.md` § Handoff; an agent writes it only as that answer's direct result
  (`docs/decisions/README.md`, 2026-10-08 — Unattended execution). `<id>` is the opting-in
  session's model as the depth probe reads it. Absent means manual: `scripts/drive-execution.mjs`
  refuses to start, and `/devcycle:continue --drive` stops `not-opted-in`.

`updated:` is the canonical timestamp of `node "${CLAUDE_PLUGIN_ROOT}/scripts/stamp.mjs" now`
taken when the field is written — never a narrated or estimated time.
`kind:` records the confirmed triage request kind and `plan-counts:` the plan's Dispatch-Map
totals, both read by the `hooks/workload-sensor.mjs` commit-sensor so a cycle's workload is
captured progressively; both are carried forward on rewrite like the other lines.
`branch:` carries a `(cut from <base> at <sha>)` annotation whose `<sha>` (the point the topic
branch was cut) `hooks/workload-sensor.mjs` parses to bound the cycle's diff. A bare branch line no
longer blinds the sensor — `references/branch.md` § Committing owns the base it derives instead —
but keep writing the annotation: it records the exact cut point, where the derivation only infers
one from the branch's ancestry, and an inference goes wrong where a record cannot (a branch cut
from something outside the sanctioned cut-points, a history rewritten since).

**The ownership check, run before trusting anything else in the file.** `root:` and
`request:` pin it to one project and one goal, so every reader asks whether the file
belongs to the checkout it sits in: verify `root:` against `git rev-parse --show-toplevel`
of the state file's OWN directory, not the caller's cwd — worktrees and nested checkouts
have a toplevel of their own. A differing `root:` means the file was copied from another
checkout or leaked from another project: never resume it and never silently reset it —
report what its `root:` and `request:` say versus where you are,
and let the user choose between adopting it (the repo genuinely moved: rewrite `root:`,
keep everything else) and leaving it alone. The adopt-or-leave answer is the user's to
give. A file with no `root:` line predates this format and is not foreign: adopt it by writing
`root:` and `request:` at the next rewrite.

## The state file's `configured:` line

One line records the first-run configuration offer, one form per outcome:

- `no` — the offer was never made.
- `defaults` — the offer ran and wrote nothing, every answer matching its recommended default.
- `<date>` plus a KEY=VALUE list — the offer ran and wrote those; the drift notice has not run yet.
- `<date>` alone — the drift notice in `references/config.md` § Knob channel ran against the list
  and retired it.

A trailing `· profile-asked` marker is legacy — accepted on read and kept through the drift
notice's rewrite, never newly written — and changes nothing a reader does. The line is a record of
the offer, never a source of knob values; its only other reader is that drift notice.

## Settle the branch first, before reading anything else

On re-entry, settle the branch before any edit, any git-evidence check, and any
dispatch — keyed off the `branch:` line RECORDED in `.devcycle/state.md`, not off
whatever the checkout currently happens to be on (parallel sessions share the
checkout and may have switched it back to the integration branch):

- If the state file records a topic branch, resume means getting the checkout onto
  that branch — `commands/continue.md`'s recorded-vs-current mismatch rule already
  covers asking the user before switching; never switch silently. Never
  create a fresh topic branch when one is recorded: the recorded branch is where
  any committed work lives.
- Only if the recorded branch is still the default or an integration branch does
  branch discipline (`references/branch.md`) apply — an interrupted run may have
  stopped before the topic branch was ever created. Create it and record it on the
  `branch:` line as branch discipline requires.

## Then derive position from git evidence

Only once the checkout is on the recorded branch, re-derive position from git
evidence on that branch rather than trusting conversation memory:

| git evidence | resume action |
| --- | --- |
| change absent, or present but uncommitted | (re)implement |
| change committed | dispatch the task reviewer |

A stage that records its own commit marker in `.devcycle/state.md` (e.g. a
`sweepCommit:` line) checks that marker FIRST and treats the commit as present when
`git merge-base --is-ancestor <sha> <branch>` exits 0 — never guessed from the log.
A stage may add evidence rows of its own for states this table does not name; it may
never weaken the two rows above.

## Resuming at the recorded stage

`references/stages.json` owns which entry each stage resumes through — a playbook path or an
upstream skill — and its re-entry `note:`. `scripts/stage-entry.mjs <stage>` prints both;
`scripts/resume-check.mjs` prints them on success and `scripts/find-state-files.mjs` per listed
state file, so neither command opens this file to find an entry. `commands/cycle.md` walks the
stages in order and states each one's conditions.

`done` has no entry: a closed cycle resumes at nothing, and `/devcycle:cycle` reuses its state file
rather than resuming it.

On resume the stage keeps the `startedAt` it was entered with; `references/handoff.md` owns how it
is recorded and why.

## Resuming a wave's per-task position

`playbooks/executing-waves.md` re-enters by reading
`.devcycle/state.md`, the plan's Dispatch Map, and the ledger, then resuming each task
from its last ledger event, most specific row winning. Sweep rows key on the event's
logged `outcome=` (a `sweep` token in it), never on the task's `**Execution:** sweep`
marker: a bare `dispatched` on a sweep-marked task is a post-rejection implementer fix
and takes the generic rows.

| ledger last event for a task | resume action |
| --- | --- |
| `dispatched` | re-dispatch the same brief (the run may have died) |
| `report-received` | dispatch the reviewer (it produces the diff itself) |
| `report-received outcome=rejected (missing report file)` or `outcome=rejected (intake bounce)` | re-dispatch the implementer — after a bounce, with the lint findings its `ref=` names |
| `report-received outcome=blocked` | the implementer reported `status: blocked`: a user decision is pending (drive mode: stop `needs-user`) |
| `review-round` (no verdict after it) | the reviewer's run may have died: re-dispatch it for that round |
| `review-verdict outcome=accepted` | run the green gate, commit |
| `review-verdict outcome=rejected` or `rejected (green gate: …)` | re-dispatch the implementer with the findings or gate evidence — on a sweep-marked task, a fresh dispatch briefed per the rejection bullet (findings, task body, applied-edits disclosure), never a sweep re-run; the next review is the next round |
| `review-verdict outcome=rejected (missing findings file)` | re-dispatch the **reviewer** for that round, not the implementer |
| `review-verdict outcome=deferred (concurrent sibling edits)` | re-run the green gate once the wave quiesces (`playbooks/executing-waves.md` step 6), not a re-dispatch |
| `committed` | task done — move to the next task |
| `dispatched outcome=sweep …` | no brief to re-dispatch: re-run the sweep bullets from the clean-targets check |
| any other sweep-token outcome (`applied-none`, `dirty-targets`, `sweep hard stop: …`) | a decision was pending when the run died: re-present the fallback, never an automatic dispatch. Reasons come from the saved report, or for `dirty-targets` from the files the event names (no sweep ran, so no report exists); a hard stop also carries its applied-files disclosure |

**Retry caps.** An intake bounce, `rejected (missing report file)` and `rejected (missing findings
file)` each allow two retries per task: the third such line for the task is a pending user decision
(drive mode: stop `needs-user`), never another dispatch — the task script that writes it returns
`needs-user`.

**Exhausted-unresolved** has no ledger form. A task whose review round 3 ends rejected gets
`.devcycle/findings/task-<id>-review-status.md` (`references/loops.md` § Where the status lives).
While that file reads `exhausted-unresolved` and no `user-decision` line for that task names the
loop id `task-<id>-review` in its `outcome=`, the task's position is that pending decision, whatever
its last ledger event: present it to the user (drive mode: stop `needs-user`). Matched by id, never
by ordering — the status file carries no time; `task=drive` and `task=config` lines never match.

## Review acceptance is never inferable from git

A reviewed commit and an unreviewed one look identical. Acceptance is recorded only
by the stage advancing `stage:` in `.devcycle/state.md`, at which point
`/devcycle:continue` routes onward and never re-enters that stage. So on resume, an
existing commit with no recorded verdict is always treated as committed but not yet
accepted: dispatch the reviewer. A redundant re-review after an interruption is the
safe failure mode; skipping the reviewer because a commit exists is not.
