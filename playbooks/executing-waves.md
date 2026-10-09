# Executing Waves

## Engine

Read `profile` first from the `knobs:` line per `${CLAUDE_PLUGIN_ROOT}/references/config.md`
§ Knob channel, and follow § The profile; this stage's two model knobs, `implementerModel` and
`taskReviewerModel`, come off the same line and route per
`${CLAUDE_PLUGIN_ROOT}/references/model-routing.md` (`walkthroughModel` and `branchReviewModel`
belong to later stages). Every agent this playbook dispatches reports per `references/output.md`.
Read `${CLAUDE_PLUGIN_ROOT}/references/delegation.md` and follow it: it settles what the coordinator
does itself and what it delegates — including the stage budget, which binds this playbook hardest.

Read this stage's lessons: `node "${CLAUDE_PLUGIN_ROOT}/scripts/dream.mjs" --lessons execution`. No store, no output.

At **`lean` / `standard`**, do not load **superpowers:subagent-driven-development** — the mechanics
below are self-contained. At **`thorough`**, load it (REQUIRED): it owns brief slicing and file
handoffs, the review/fix loop, implementer-status handling, reviewer-prompt construction, and
continuous execution, and these deltas are the only places devcycle differs from it.

- Its tail does NOT apply: its final-code-reviewer dispatch and its finishing-a-development-branch
  step are replaced by devcycle's reviewing-the-branch and finish stages.
- Its Pre-Flight Plan Review (the conflict scan before Task 1) runs ahead of the pre-flight below,
  but its table and rulings never enter the ledger: a conflict the spec does not settle goes to the
  user (driven: a `needs-user` stop).
- Its never-start-on-main rule is replaced by `references/branch.md`, which also forbids the
  integration branches that file names.
- Its file-handoff mechanics know of neither the quality-constraint ids, the task id, nor the
  `**Evidence tail:** <N>` line: add all three to the sliced brief exactly as step 2 defines them.
- Its reviewer-prompt rules govern the wording of the step 5 dispatch.
- Its `scripts/review-package` does not apply: devcycle implementers do not commit, so there is
  nothing to package; step 5's reviewer produces the diff itself.
- Its implementers-commit convention does not apply — the coordinator commits, at step 7.
- Its progress-file path is replaced by `.devcycle/ledger.md`, in `references/ledger.md`'s line
  format: no `Ruling:` line is ever written there.
- Its "Execute all tasks from the plan without stopping" yields to the wave boundary: a session
  ends at its wave's last commit, driven or not.
- Its "Rulings, not stalls" does not apply: an exhausted-unresolved task, a `status: blocked` report
  and every escalation it stops for become a user decision (driven: a `needs-user` stop).

## Pre-flight, before wave 1

1. **Branch discipline.** Read `${CLAUDE_PLUGIN_ROOT}/references/branch.md` and follow it before
   dispatching anything — the coordinator commits from wave 1 onward, so the topic branch must exist
   and be recorded first.
2. **Commit convention.** Read `${CLAUDE_PLUGIN_ROOT}/references/commit-convention.md` and follow its
   derivation before wave 1's first commit, recording the result as the ledger's `Commit-convention:`
   preamble line.
3. **Plan hygiene.** A requirements block at the top of a plan that no task's steps implement WILL be
   silently skipped. When the pre-dispatch read finds one, patch the owning task's steps explicitly
   and re-extract that task's brief before dispatching it.

## Wave formation

Tasks come from the plan's `## Dispatch Map` and per-task `Dependencies` declarations. A wave = every
task whose declared dependencies are already committed AND whose file set overlaps no other candidate
or running task. Execute by readiness, never by written order. `wave-setup.mjs`'s `dispatchable`
list is this rule applied: every task of any Dispatch-Map wave whose dependencies are committed, in
Map order, less any not yet dispatched whose files overlap a task in flight or one listed before it;
its `wave` stays the lowest Map wave with an uncommitted task. Invariants: never advance a dependent
task before its dependency's commit lands; never place two tasks touching the same file in one wave,
even if both are declared independent; and keep as many file-disjoint implementers concurrent as the
wave allows. (That last one refines upstream's no-parallel-implementers rule, which guards against
file conflicts these invariants already preserve.)

## Per-task cycle

Four task scripts keep every task's books, run from the repo root with `--run <id> --task <id>` as
`references/ledger.md` § Task scripts and `references/commit-convention.md` § The task commit invoke
them. Each writes its own ledger lines and run-record rows and prints one JSON object: `action` says
what comes next, `depthBand` is this session's band; a red gate, a bounce or a cap is an `action`,
exit 2 or 3 a stop.

1. **Position first.** The wave setup `/devcycle:continue` ran gives each task its `next` action; a
   committed task is done — never re-dispatch it.
2. **Slice the brief**, carrying exactly: the task's id (the plan's task number); `**Files:**`
   (create/modify/test); `**Interfaces:**` (consumes/produces, exact signatures); `**Dependencies:**`; the
   `**Evidence:**` class from the plan; an `**Evidence tail:** <N>` line, `<N>` from the profile; the
   task's steps; the global constraints and pinned interfaces that apply; the task's quality constraints
   resolved; and one read, `"$(devcycle-root)/references/delegation.md"` § Read discipline.
   Nothing else, and nothing restated that a named reference owns —
   `references/evidence.md` owns the evidence classes, the evidence file paths (keyed
   on the task id, which is why every brief carries it), and the report shape the implementer must produce.
   - **Resolve the quality constraints:** splice in verbatim, ids included, the lines of the plan's
     `## Quality Constraints` section that the task's `**Quality constraints:**` ids name — a bare `QC3`
     is unreadable to an implementer — **never the whole criteria catalog or the whole section**
     (`references/quality-criteria.md`'s cost rule); `none`, or no such section, adds nothing.
   - **Preload what the evidence class needs:** splice exactly what
     `${CLAUDE_PLUGIN_ROOT}/references/evidence.md` § Preloading a class into a brief names.
   - **Resolve lessons:** run `node "${CLAUDE_PLUGIN_ROOT}/scripts/dream.mjs" --match --stage execution --files "<this task's **Files:** list>"` and splice its output verbatim into the brief's `**Lessons:**` block — only the matched lines this task's files name, **never a whole stage section**. Empty output → `**Lessons:** none`. Each line ends with a `--lesson <id>` pull hint; the block header tells the worker to pull the full record **only if about to work in the area the lesson names**.
   - **Name plugin scripts through the shim, quoted:** a brief writes a plugin script as
     `"$(devcycle-root)/scripts/<name>.mjs"` — quoted, since the word-split substitution tears a
     plugin root containing a space — never as a literal `${CLAUDE_PLUGIN_ROOT}` path, which is
     substituted at render time and expands to nothing in the implementer's shell. No check covers
     either: a sliced brief is run scratch, so both are yours to get right here.
3. **Dispatch devcycle:implementer** with that brief only, never accumulated session history or other
   tasks' reports, on the model `references/model-routing.md` resolves. The dispatch prompt must NEVER
   instruct the implementer to commit, stage, or push. Immediately before it, give the brief to
   `task-dispatch.mjs --role implementer --model-decision "<the routing decision>"` (a fix pass adds
   `--round <n>`) on stdin as a quoted heredoc (`<<'EOF'`) — one `node` call, nothing chained to it,
   no `$(…)` in its flags: the one form the git guard reads as data. It writes the brief file the
   dispatch names. The implementer returns the envelope `references/delegation.md` defines — never
   the report body — and that envelope's on-device count is what triggers the checklist below.
4. **Intake.** `task-intake.mjs`, given the envelope's `report:` path and `status:` and the task
   notification's agent id as `--agent-id`, checks the report against its evidence class and lints
   it — the envelope's `report:` field is a claim, not proof. `review` → step 5. `bounce` or `missing-report` → back to the implementer with
   its `findings`, no reviewer dispatch. `needs-user` → the user decides (driven: a `needs-user`
   stop). The coordinator neither produces nor reads the task diff; step 5 does both.
5. **Dispatch devcycle:task-reviewer** (read-only apart from its own findings file), on the model
   `references/model-routing.md` resolves, with the brief, the report path, the task's file list, the
   two evidence-file paths the report names, and the task's constraints block, instructing it to
   produce the diff itself: `git add -N <new files>` first, or they are invisible to diff, then
   `git diff -U10 HEAD -- <files>`. It returns the task-reviewer envelope `references/delegation.md`
   defines; the reviewer writes its verdict block to `.devcycle/findings/<task-id>-round-<n>.md`
   itself (the dispatch supplies the path and round n).
   Give its brief to `task-dispatch.mjs --role reviewer --round <n>` the same way first; read the
   verdict with `task-verdict.mjs --round <n> --findings <that path> --evidence-class <evidenceClass>`.
   The wave setup's `tasks[]` gives each uncommitted task its `reviewRound`, `evidenceClass` and `testCmd`.
   `accepted` → step 6. `rejected` → the findings path back to the implementer (step 3), then the
   next round's review. `missing-findings` → re-dispatch the reviewer for the same round, no verdict
   acted on. `needs-user` → the user decides (driven: a `needs-user` stop).
   Cap: 3 rounds per task; one round is one reviewer dispatch plus the implementer's fix pass, and a
   failed green gate rejects its round too. A task that reaches round 3 without a commit exits
   `exhausted-unresolved` — `task-verdict.mjs` or `task-commit.mjs` writes that status — and is
   surfaced to the user as a decision, never committed as if it had passed.
6. **Green gate (REQUIRED, deterministic).** On acceptance, run `task-commit.mjs` with the plan,
   `--test-cmd "<the task's test command>"` and your subject, plus
   `--subset-cmd "<the task's file-scoped command>"` when the test command is the whole suite.
   It re-runs the test command itself and reads the exit status — never the implementer's word for
   it; a repo with no test suite passes its documented convention as the test command.
   On failure, acceptance is blocked: no commit, `gate-fail`, back to the implementer with the gate
   evidence its ledger line names, then the next round's review; after round 3, `needs-user`.
   `deferred` means a concurrent sibling's edit caused the red: call it again once the wave quiesces.
7. **Branch re-check, then commit.** The same call re-runs
   `git rev-parse --abbrev-ref HEAD` against the recorded `branch:` line immediately before
   committing — `branch-mismatch` stops the run rather than committing to the wrong branch — then,
   on acceptance: a local commit of the task's changed `**Files:**` with your subject, which matches
   the `Commit-convention:` line. `already-committed`: an interrupted run had committed, and only its
   missing lines were added. `nothing-to-commit` or `commit-failed` (a commit hook refused it) → the
   user decides (driven: a `needs-user` stop naming the action). The `PostToolUse` commit-sensor
   records `workload` itself.

**Safety valve.** In a driven session (`/devcycle:continue --drive`), read `depthBand` after every
task script: on `hard-stop`, dispatch no new task, finish the tasks in flight, then end the session
with a handoff whose first field is `Session ended mid-wave: <k> of <n> tasks done (stage: execution)`.
Two task scripts in a row reporting `unknown` count as `hard-stop`: the probe has lost the session.

**Trigger: this commit closes the wave.** When no task in the current wave remains undispatched, in
review, or uncommitted, stop here — before forming the next wave — and follow ## Wave boundaries and
handoff below.

### Sweep-executed tasks

A task whose plan entry carries `**Execution:** sweep` replaces steps 2–3 with one mechanical-sweep
run; steps 4–7 here then apply with six deltas, step 4 being the `report-received` line that file
names rather than `task-intake.mjs`. Read
`${CLAUDE_PLUGIN_ROOT}/references/sweep-execution.md` and apply its deltas to that task; for the
run itself, follow only the invocation contract it names from steps 2–4 of
`${CLAUDE_PLUGIN_ROOT}/playbooks/sweeping-mechanical-changes.md`, and wherever those steps and
the deltas disagree, the deltas win.

## Ledger

Progress is written to `.devcycle/ledger.md`; the task scripts append every per-task line. Read
`${CLAUDE_PLUGIN_ROOT}/references/ledger.md` for the format of the rest — the preamble (pre-flight
steps 1–2 supply its `Branch:` and `Commit-convention:` lines), a sweep's own lines, `user-decision`.

## UI and on-device outcomes

Never claim a rendered or on-device outcome from a script, test, or report. **Trigger: the moment a
task produces rendered changes** — generate or update the on-device checklist in that same wave, never
deferred to the end of the wave or the branch. That trigger is this playbook's own; everything else about
a checklist — its path and state-file record, its item shape, the dimensions it covers, and the
`(auto)` boundary that decides what may ever be checked off without a human — is
`${CLAUDE_PLUGIN_ROOT}/references/checklist.md`: read it and follow it. The later walkthrough of that
checklist is `playbooks/verifying-on-device.md`'s stage, on the same file.

## Wave boundaries and handoff

At every wave boundary and at stage end, update `.devcycle/state.md` (`stage:` = the stage the next
session should resume at — `execution` while waves remain, `branch-review` at stage end — plus branch,
artifact paths, timestamp), then emit the handoff block per
`${CLAUDE_PLUGIN_ROOT}/references/handoff.md`: read it and follow it, including which first-field
label the boundary takes, the context action, and the gate that stops the run until the user acts.
After the last wave's handoff this playbook ends; the next stage is
**`playbooks/reviewing-the-branch.md`** (REQUIRED — the branch gate before
finishing).

## Resuming after /clear

`/devcycle:continue` resumes this stage through `scripts/wave-setup.mjs`: its JSON carries the
settled branch, each task's `next` action from the resume table `references/resume.md` owns, and
the `dispatchable` tasks with their brief inputs. Act on it; never re-derive position yourself.
