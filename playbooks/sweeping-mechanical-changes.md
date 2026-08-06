# Sweeping Mechanical Changes

The supervised sweep walk for requests triage has judged bulk-mechanical — one uniform edit rule applied
identically across many files, success checkable by one command — and the user has confirmed via the
AskUserQuestion gate. This playbook never re-litigates that verdict. Instead of the full pipeline it runs
one supervised pass: derive the sweep parameters from the repo, confirm the exact blast radius, run
`workflows/mechanical-sweep.js` (pilot-first, per-file verify, worktree isolation), commit once, one
reviewer pass, hand to finish. Subagent implementers, the plan file, and the wave ledger are dropped;
nothing in the steps below is.

**Announce at start:** "I'm using the sweeping-mechanical-changes skill to run this as a supervised sweep."

## The sweep walk

1. **Branch discipline.** Read `${CLAUDE_PLUGIN_ROOT}/references/branch.md` and follow it before anything
   else — the sweep commits, so it never runs on the default or an integration branch. Resume keys off the
   `branch:` line it has you record, and its per-commit re-check binds step 5's commit and step 6's amend.
2. **Derive parameters** — from the repo, never from anyone's memory:
   - the **instruction**: the request's edit rule, verbatim;
   - the **file list**: found by search; record the exact derivation command (the `grep`/`rg` invocation)
     alongside the list it produced;
   - the **verifyCommand**: the repo's own documented verification convention (test suite, linter, build).
     The script hard-requires one; if the repo documents none, the user supplies one at gate 2;
   - the **model**: resolve `DEVCYCLE_SWEEP_MODEL` from the `implementerModel` knob per
     `${CLAUDE_PLUGIN_ROOT}/references/config.md` — a sweep edit is single-file mechanical, the fast tier's
     ideal case. One route-specific departure: where that reference falls back to the session tier, leave
     the variable unset instead so the CLI's default applies, since an environment variable cannot inherit
     the session model the way a dispatch can;
   - **clean targets**: every target must be tracked AND clean — `git ls-files --error-unmatch` matches it
     and `git status --porcelain` prints nothing for it. Both checks are needed: `status` is equally silent
     for a gitignored or nonexistent path as for a clean one. Any target failing either (modified, staged,
     `??` untracked, gitignored, absent) → stop and put it to the user: commit that file, or drop it from
     the list, then re-derive. Every revert below, the resume table's git evidence, and the commit's freedom
     from unrelated work depend on the sweep's own edits being the only dirty state on a target.
3. **Confirm the blast radius (gate 2).** Write the derived parameters to `.devcycle/sweep-plan.md` —
   instruction, verifyCommand, derivation command, the full file list with its count, the clean-targets
   check with its result, and the model in the audit shape `${CLAUDE_PLUGIN_ROOT}/references/config.md`
   defines or this path's own `model unset (auto: no fast-tier id resolved; CLI default applies)`, since a bare
   name hides which path chose it. Then ask ONE AskUserQuestion presenting exactly that blast radius, model
   included: confirm / adjust (re-run the clean-targets check over the adjusted list, rewrite the plan
   file, re-present) / abort (closed out per **State file** below). Nothing runs and no agent edits anything
   until this gate passes. On confirm, write `{"files": [...], "instruction": "...", "verifyCommand":
   "..."}` to `.devcycle/sweep-args.json`.
4. **Capture the baseline, then run the sweep.** BEFORE invoking anything, run the confirmed verifyCommand in
   the real working tree and write its output verbatim to `.devcycle/evidence/sweep-before.txt` — the only
   moment it exists, since the script starts copying files back as it goes and keeps nothing of its own green
   baseline. Red is a stop, not a sweep input: report it verbatim and put it to the user. Green → run:

   `node "${CLAUDE_PLUGIN_ROOT}/workflows/mechanical-sweep.js" "$(cat .devcycle/sweep-args.json)"`

   with `DEVCYCLE_SWEEP_MODEL` as resolved in step 2. The script reads its JSON from `argv[2]` only; the
   double-quoted command substitution hands the file's contents through as one intact argument, so no
   escaping is needed whatever the instruction contains.
   - **Exit 1 with a stdout report** (baseline or pilot hard stop): files applied before the stop sit in the
     real tree, uncommitted and unreviewed. Relay the per-file reasons verbatim and stop for a user
     decision, stating what each option does to those edits — **retry** with corrected parameters (the
     re-run rule reverts them first); **fall through** to the normal pipeline (edits handed over, explicitly
     disclosed, and `.devcycle/state.md`'s `stage:` set to the stage being entered, or a later
     `/devcycle:continue` re-enters the sweep just routed away from); **abort** (revert them, then close out
     per **State file**). Never edit the sweep script to get past a stop.
   - **Exit 1 with no stdout report** (malformed JSON argument, not inside a git repository, an unhandled
     failure): the message is on stderr only. Quote it verbatim, fix the invocation or environment, and
     re-run — a broken invocation, not a verification verdict. An unhandled failure can also fire mid-sweep
     with no report listing what was already copied back: check `git status` over the targets first, and
     treat anything found under the re-run rule.
   - **Exit 0**: save the stdout report to `.devcycle/sweep-report.json`; skipped files with their reasons
     carry into the handoff block. Non-empty `applied` → step 5. Empty `applied` means nothing was swept and
     there is nothing to commit: skip step 5, relay the report's per-file reasons verbatim, and stop for a
     user decision — close out as-is, or adjust the parameters and re-run.

   **Re-run rule.** Before ANY re-run over targets already carrying this sweep's edits — a retry after a
   hard stop, a re-run after a fatal exit, or a confirmed resume — revert those edits (`git checkout -- <the
   applied or confirmed files>`) and run from clean: a non-idempotent instruction applied twice passes per-file
   verify and rides into the commit doubled, and the pilot's early-stop only works from clean. A retry that
   changed the verifyCommand also re-captures `.devcycle/evidence/sweep-before.txt` from the reverted tree.
   The revert is safe only for the sweep's own edits — if the targets may have changed
   underneath the run, show `git diff -- <targets>` and have the user confirm before reverting.
5. **Verify the real tree, then commit.** Run the confirmed verifyCommand in the real working tree and write
   its output verbatim to `.devcycle/evidence/sweep-after.txt` — the script's worktree carries HEAD state
   for every non-target file, so this is the only green produced against the exact tree being committed. Red
   → a hard stop: report verbatim, stop for a user decision, never commit. Green → ONE Conventional Commit
   for the whole sweep, scoped per `${CLAUDE_PLUGIN_ROOT}/references/commit-convention.md`'s "Scoping the
   commit": `git commit -- <the confirmed target files>`. Then record the resulting sha on a `sweepCommit:`
   line in `.devcycle/state.md` IMMEDIATELY, before any other action — resume's commit-marker check keys off
   that line rather than guessing which `git log` entry is the sweep's.
6. **Light review.** Dispatch exactly ONE `devcycle:task-reviewer` subagent with the diff, the two evidence
   files, and the sweep report (skips included). On reject: fix in-session, re-run the verifyCommand
   (rewriting `.devcycle/evidence/sweep-after.txt`), re-dispatch, then fold the accepted fix into the sweep
   commit. The fix must stay within the confirmed target files — a finding whose fix needs any other file
   exceeds the sweep's mechanical scope and stops for a user decision. Amending rewrites history, so first
   confirm the commit was never pushed: `git branch -r --contains <the recorded sweepCommit sha>` must print
   nothing. Empty → `git commit --amend --no-edit -- <the confirmed target files>`, then rewrite the
   `sweepCommit:` line to the new sha immediately, as in step 5. Non-empty (the commit is on a remote) → do
   not amend; commit the fix as a separate follow-up. No panel, no cross-model lens, no red-team here.

   Cap: 2 rounds. One round is one reviewer dispatch, its fix, and the verifyCommand re-run.
   Statuses and their reporting are owned by `${CLAUDE_PLUGIN_ROOT}/references/loops.md`.
7. **Handoff.** Read `${CLAUDE_PLUGIN_ROOT}/references/handoff.md` and follow it — the block's shape, the
   `sweep → finish` context action, and the await gate are all its rules. This stage's block reports `Stage
   completed: sweep`, listing the branch, the commit sha, `.devcycle/sweep-plan.md`, and
   `.devcycle/sweep-report.json` as artifacts, and skipped files with their reasons as carry-overs. Then set
   `stage: finish` in `.devcycle/state.md` and hand to
   `${CLAUDE_PLUGIN_ROOT}/playbooks/finishing-the-cycle.md` unchanged.

**Evidence.** Owned by `${CLAUDE_PLUGIN_ROOT}/references/evidence.md`. Three things are route-specific: the
class is `green-green` by construction, since a sweep preserves behavior; `sweep-before.txt` comes from step
4's own pre-sweep verify run, not from the script; and an exit 0 with an empty `applied` list commits
nothing, so the evidence is then the report's per-file skip reasons.

**Escalation valve.** If derivation reveals per-file judgment, an ambiguous rule, or an exploding file list
— stop, say so, and re-enter the normal pipeline at scoping or brainstorm, updating `.devcycle/state.md`
accordingly. Never force non-uniform work through a sweep because it is already in flight.

**Delegation.** `${CLAUDE_PLUGIN_ROOT}/references/delegation.md` exempts this path from delegate-by-default
(`## The short paths`) — the sweep script is the worker, and supervising it in-session is the design. Its
stage budget still binds: reaching those counters means the change was not the uniform mechanical edit that
triage took it for, so escalate rather than keep sweeping.

## State file

Sweep runs write `.devcycle/state.md` in the standard shape (`commands/cycle.md`), with these fields:

- `scope:`, `spec:`, `plan:` stay `none` — the walk produces none of them; its artifacts are
  `.devcycle/sweep-plan.md`, `sweep-args.json`, and `sweep-report.json`.
- `request:` carries the edit rule being swept.
- `ledger:` stays the standard `.devcycle/ledger.md` line but is unused.
- `sweepCommit:` is a sweep-only extra line, absent until step 5 commits and then carrying that commit's sha
  (rewritten by step 6's amend).
- An abort — at gate 2 or at a hard stop — closes the cycle: `stage: done`, fresh `updated:`, the abort
  noted in `request:`, and every sweep artifact already written deleted. Left at `stage: sweep` with its
  artifacts on disk, a later `/devcycle:continue` walks straight back into the aborted sweep.

## Resume (`/devcycle:continue`)

Read `${CLAUDE_PLUGIN_ROOT}/references/resume.md` and follow it: settle the checkout onto the recorded
branch first, then git evidence — led here by the `sweepCommit:` marker, since this path records one — and
review acceptance is never inferable from git, so a sweep commit found on resume is committed but not yet
accepted and step 6 runs again. On top of that reference's rows, this path reads its own evidence as:

| git evidence | resume action |
| --- | --- |
| sweep commit present | dispatch the task reviewer (step 6); uncommitted target edits alongside it are an interrupted step-6 fix — confirm them (below), then finish that fix through step 6's verify-and-amend ending, never the re-run rule (its revert would discard the fix and re-apply the sweep on top of the committed one) |
| uncommitted target edits, no sweep commit | interrupted mid-run: re-confirm gate 2 with those edits confirmed (below), then the re-run rule — revert, re-run from clean — verify the real tree, commit |
| neither | no `.devcycle/sweep-plan.md` → the run never reached gate 2: restart at step 2. Plan file present → first check whether the branch gained a commit touching the targets since it was written (`git log --since=<the plan file's timestamp> <branch> -- <targets>`); one found → STOP for a user decision, the likely cause being a crash inside step 5's commit-then-record window; none → re-derive, re-confirm gate 2, run |

**Confirming uncommitted target edits.** Step 2's precondition rules out a pre-existing user edit on a target,
but not one made *after* the interruption, which `git status` cannot tell apart from sweep work. So wherever a
row above finds uncommitted target edits, show `git diff -- <targets>` and have the user confirm they are this
sweep's own before anything is reverted, re-run, or amended; if they cannot vouch, stop for a decision —
revert, commit separately, or drop those files.
