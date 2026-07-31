---
name: sweeping-mechanical-changes
description: Use when devcycle triage has confirmed a bulk-mechanical request and the run takes the sweep path — derive parameters, confirm the blast radius, run the mechanical-sweep workflow, one commit, one task-reviewer pass, then the finish stage.
---

# Sweeping Mechanical Changes

The supervised sweep walk for requests triage has judged bulk-mechanical — one
uniform edit rule applied identically across many files, success checkable by
one command — and the user has confirmed via the AskUserQuestion gate (sweep
path vs. full pipeline). This skill never re-litigates that verdict. What it
runs instead of the full scoping → brainstorm → planning → execution →
branch-review → on-device walk is a single supervised pass: derive the sweep
parameters from the repo, confirm the exact blast radius, run
`workflows/mechanical-sweep.js` (pilot-first, per-file verify, worktree
isolation), commit once, one reviewer pass, hand to finish. All four guardrails
a plan task would carry — branch discipline, verbatim evidence, an escalation
valve, and an independent review — still apply; only the ceremony around them
(subagent implementers, plan file, wave ledger) is dropped.

**Announce at start:** "I'm using the sweeping-mechanical-changes skill to run
this as a supervised sweep."

## The sweep walk

1. **Branch discipline.** Read `${CLAUDE_PLUGIN_ROOT}/references/branch.md` and
   follow it before anything else — the sweep commits, so it never runs on the
   default or an integration branch. Resume keys off the `branch:` line that
   reference has you record.
2. **Derive parameters** — from the repo, never from anyone's memory:
   - the **instruction**: the request's edit rule, verbatim;
   - the **file list**: found by search; record the exact derivation command
     (the `grep`/`rg` invocation) alongside the list it produced;
   - the **verifyCommand**: the repo's own documented verification convention
     (test suite, linter, build). The script hard-requires one; if the repo
     documents none, the user supplies one at gate 2;
   - the **model**: resolve `DEVCYCLE_SWEEP_MODEL` from the `implementerModel`
     knob per `${CLAUDE_PLUGIN_ROOT}/references/config.md` — a sweep edit is
     single-file mechanical, the fast tier's ideal case. One route-specific
     departure from that reference: where it falls back to the session tier
     (no fast-tier id resolvable with confidence), leave the variable unset
     instead so the CLI's default applies — an environment variable cannot
     inherit the session model the way a subagent dispatch can;
   - **clean targets**: every target must be tracked AND clean —
     `git ls-files --error-unmatch` matches it and `git status --porcelain`
     prints nothing for it. Both checks are needed: `status` is equally silent
     for a gitignored or nonexistent path as for a clean one. Any target
     failing either (modified, staged, `??` untracked, gitignored, absent) →
     stop and put it to the user: commit that file, or drop it from the list,
     then re-derive. This precondition is what makes the sweep's own edits the
     only sanctioned dirty state on a target, which every `git checkout --`
     revert below, the resume table's git evidence, and the commit's freedom
     from unrelated work all depend on.
3. **Confirm the blast radius (gate 2).** Write the derived parameters to
   `.devcycle/sweep-plan.md` — instruction, verifyCommand, derivation command,
   resolved model, the full file list with its count, and the clean-targets
   check with its result — then ask ONE AskUserQuestion presenting exactly that
   blast radius: confirm / adjust (re-run the clean-targets check over the
   adjusted list, rewrite the plan file, re-present) / abort (closed out per
   **State file** below). Nothing runs and no agent edits anything until this
   gate passes. On confirm, write the args JSON —
   `{"files": [...], "instruction": "...", "verifyCommand": "..."}` — to
   `.devcycle/sweep-args.json`.

   State the model in the model-routing audit shape of
   `${CLAUDE_PLUGIN_ROOT}/references/config.md` — `model <id> (pinned)`,
   `model fast:<id> (auto: sweep edit, single-file mechanical)`, or this
   path's own `model unset (auto: no fast-tier id resolved; CLI default
   applies)` — in the plan file and the question alike. A bare name hides
   which path chose it.
4. **Capture the baseline, then run the sweep.** The baseline is yours to take,
   and this is the only moment it exists: step 2's clean-targets precondition
   still holds, and the moment the script starts copying verified files back the
   clean tree is gone. So BEFORE invoking anything, run the confirmed
   verifyCommand yourself in the real working tree and write its output verbatim
   to `.devcycle/evidence/sweep-before.txt` (**Evidence** below). Do not expect
   the script to hand this back: `mechanical-sweep.js` runs its own baseline
   inside a worktree and keeps nothing of a green one — its stdout report
   carries only `applied` and `skipped`. A red baseline is a stop, not a sweep
   input: report it verbatim and put it to the user, because a sweep judged
   against an already-broken verify proves nothing. Green → run the sweep:

   `node "${CLAUDE_PLUGIN_ROOT}/workflows/mechanical-sweep.js" "$(cat .devcycle/sweep-args.json)"`

   with `DEVCYCLE_SWEEP_MODEL` as resolved in step 2. The script reads its JSON
   from `argv[2]` only; the double-quoted command substitution hands the file's
   contents through as one intact argument, so no escaping is needed no matter
   what the instruction contains.
   - **Exit 1 with a stdout report** (baseline or pilot hard stop): the script
     copies each verified file back into the real tree as it goes, so files
     applied before the stop sit uncommitted and unreviewed. Relay the
     per-file reasons verbatim and stop for a user decision, stating what each
     option does to those edits — **retry** with corrected parameters (the
     re-run rule reverts them first); **fall through** to the normal pipeline
     (edits handed over, explicitly disclosed, and `.devcycle/state.md`'s
     `stage:` set to the stage being entered, as the escalation valve does, or
     a later `/devcycle:continue` re-enters the sweep just routed away from);
     **abort** (revert them, then close out per **State file** below). Never
     edit the sweep script to get past a stop.
   - **Exit 1 with no stdout report** (fatal: malformed JSON argument, not
     inside a git repository, an unhandled failure): the message is on stderr
     only. Quote it verbatim, fix the invocation or environment, and re-run —
     a broken invocation, not a verification verdict. An unhandled failure can
     also fire mid-sweep, after files were copied back, with no report listing
     them: check `git status` over the targets first, and treat anything found
     under the re-run rule.
   - **Exit 0**: save the stdout report to `.devcycle/sweep-report.json`; skipped
     files with their reasons carry into the handoff block. The baseline is
     already on disk from this step's opening. Non-empty `applied` → step 5.
     Empty `applied` means nothing
     was swept and there is nothing to commit (normalization can drop every
     file before the baseline verify even runs): skip step 5, relay the
     report's per-file reasons verbatim, and stop for a user decision — close
     out as-is, or adjust the parameters and re-run.

   **Re-run rule.** Before ANY re-run over targets already carrying this
   sweep's edits — a retry after a hard stop, a re-run after a fatal exit, or a
   confirmed resume — revert those edits first
   (`git checkout -- <the applied or confirmed files>`) and run from clean. A
   non-idempotent instruction applied a second time passes per-file verify and
   rides into the commit doubled; starting clean also keeps the pilot's
   early-stop working. A retry that changed the verifyCommand also re-captures
   `.devcycle/evidence/sweep-before.txt` from the reverted tree — a baseline
   taken with a different command is not this run's baseline. The revert is safe
   only for the sweep's own edits: if
   the targets may have changed underneath the run (a parallel session on the
   same checkout), show `git diff -- <targets>` and have the user confirm
   before reverting.
5. **Verify the real tree, then commit.** Run the confirmed verifyCommand in
   the real working tree and write its output verbatim to
   `.devcycle/evidence/sweep-after.txt` — the script's worktree carries HEAD
   state for every non-target file, so this is the only green produced against
   the exact tree being committed. Red → treat it as a hard stop: report
   verbatim, stop for a user decision, never commit. Green → ONE Conventional
   Commit for the whole sweep, scoped by pathspec on the commit itself:
   `git commit -- <the confirmed target files>`. Never
   `git add -A`, `commit -a`, or a bare `git commit` — a bare commit ships
   whatever else the user had staged. Then record the resulting sha on a
   `sweepCommit:` line in `.devcycle/state.md` IMMEDIATELY, before any other
   action: resume's commit-marker check keys off that line rather than guessing
   which entry in `git log` is the sweep's, and a crash inside this window
   leaves only the resume table's backstop under it.
6. **Light review.** Dispatch exactly ONE `devcycle:task-reviewer` subagent
   with the diff, the two evidence files, and the sweep report (skips
   included). On reject: fix in-session, re-run the verifyCommand (rewriting
   `.devcycle/evidence/sweep-after.txt`), re-dispatch until accept, then fold
   the accepted fix into the sweep commit. The fix must stay within the
   confirmed target files — a finding whose fix needs any other file exceeds
   the sweep's mechanical scope and stops for a user decision (the escalation
   valve's shape). Amending rewrites history, so first confirm the commit was
   never pushed: `git branch -r --contains <the recorded sweepCommit sha>` must
   print nothing. Empty →
   `git commit --amend --no-edit -- <the confirmed target files>`, then rewrite
   the `sweepCommit:` line to the new sha immediately, as in step 5. Non-empty
   (the commit is on a remote) → do not amend; commit the fix as a separate
   follow-up. No review panel, no cross-model lens, no red-team — those belong
   to the full branch-review stage, not here.
7. **Handoff.** Emit this stage's block (`Stage completed: sweep`) per
   **Handoff block** below, set `stage: finish` in `.devcycle/state.md`, and
   hand to `devcycle:finishing-the-cycle` unchanged — its policy resolution and
   git action apply exactly as at the end of the full pipeline.

**Evidence.** The classes, the file-backed contract, and this path's
coordinator-written evidence files are owned by
`${CLAUDE_PLUGIN_ROOT}/references/evidence.md` — read it there. Three things are
route-specific and live only here. First, the class: `green-green` by
construction, since a sweep preserves behavior by definition. Second, where
`sweep-before.txt` comes from:
the coordinator's own pre-sweep verify run in step 4, taken on the clean tree
before the script is invoked — not from the script, which discards a green
baseline's output. Third, the one exception:
an exit 0 with an empty `applied` list commits nothing, and the evidence is then
the report's per-file skip reasons.

**Escalation valve.** If derivation reveals per-file judgment, an ambiguous
rule, or an exploding file list — stop, say so, and re-enter the normal
pipeline at scoping or brainstorm, updating `.devcycle/state.md` accordingly.
Never force non-uniform work through a sweep because it is already in flight.

## State file

Sweep runs still write `.devcycle/state.md` in the standard shape
(`commands/cycle.md`), with these fields specifically:

- `scope:`, `spec:`, `plan:` stay `none` — the sweep walk produces none of
  them; its artifacts are `.devcycle/sweep-plan.md`, `sweep-args.json`, and
  `sweep-report.json`.
- `request:` carries the edit rule being swept.
- `ledger:` stays the standard `.devcycle/ledger.md` line but is unused — the
  sweep has no wave dispatches to log.
- `sweepCommit:` is a sweep-only extra line, absent until step 5 commits and
  then carrying that commit's sha (rewritten by step 6's amend).
- An abort — at gate 2 or at a hard stop — closes the cycle: `stage: done`,
  fresh `updated:`, the abort noted in `request:`, and every sweep artifact
  already written deleted. Left at `stage: sweep` with its artifacts on disk,
  a later `/devcycle:continue` walks straight back into the aborted sweep.

## Handoff block

Read `${CLAUDE_PLUGIN_ROOT}/references/handoff.md` and follow it — the block's
shape, the `sweep → finish` context action, and the await gate are all its
rules. This stage's block reports `Stage completed: sweep`, listing the branch,
the commit sha, `.devcycle/sweep-plan.md`, and `.devcycle/sweep-report.json`
as artifacts, and skipped files with their reasons as carry-overs.

## Resume (`/devcycle:continue`)

Read `${CLAUDE_PLUGIN_ROOT}/references/resume.md` and follow it: settling the
checkout onto the recorded branch comes first, then git evidence — led here by
the `sweepCommit:` marker check, since this path records one — and review
acceptance is never inferable from git, so a sweep commit found on resume is
committed but not yet accepted and step 6 runs again. On top of that
reference's rows, this path reads its own evidence as:

| git evidence | resume action |
| --- | --- |
| sweep commit present | dispatch the task reviewer (step 6); uncommitted target edits alongside it are an interrupted step-6 fix — confirm them (below), then finish that fix through step 6's verify-and-amend ending, never the re-run rule (its revert would discard the fix and re-apply the sweep on top of the committed one) |
| uncommitted target edits, no sweep commit | interrupted mid-run: re-confirm gate 2 with those edits confirmed (below), then the re-run rule — revert, re-run from clean — verify the real tree, commit |
| neither | no `.devcycle/sweep-plan.md` → the run never reached gate 2: restart at step 2. Plan file present → first check whether the branch gained a commit touching the targets since it was written (`git log --since=<the plan file's timestamp> <branch> -- <targets>`); one found → STOP for a user decision, the likely cause being a crash inside step 5's commit-then-record window; none → re-derive, re-confirm gate 2, run |

**Confirming uncommitted target edits.** Step 2's precondition rules out a
pre-existing user edit on a target, but not one made *after* the interruption,
which `git status` cannot tell apart from sweep work. So wherever a row above
finds uncommitted target edits, show `git diff -- <targets>` and have the user
confirm they are this sweep's own before anything is reverted, re-run, or
amended; if they cannot vouch, stop for a decision — revert, commit separately,
or drop those files.

## Guardrails preserved vs. dropped

| Rationalization | Reality |
| --- | --- |
| "The rule is unambiguous, skip gate 2" | The gate is the blast radius, not the rule — the user confirms the exact file list before any agent edits. Nothing runs first. |
| "The pilot passed, the rest is safe to assume" | The script's per-file verify decides, not the pilot's vibe — and a reported hard stop is a stop for a user decision, never something to route around. |
| "Most files swept fine, commit and move on" | Skipped files with reasons go to the reviewer and the handoff — silently dropping them ships a partial sweep as a complete one. |
| "It's mechanical, skip the reviewer pass" | Step 6 is not optional — one `devcycle:task-reviewer` dispatch is the floor, exactly as on the fast path. |
| "A few files need small case-by-case tweaks" | Per-file judgment is the escalation valve's trigger (not a sweep at all) — stop and re-enter the pipeline. |

**Delegation.** `${CLAUDE_PLUGIN_ROOT}/references/delegation.md` exempts this path from its
delegate-by-default rule (`## The short paths`) — the sweep script is the worker, and
supervising it in-session is the design. The counters in `## The stage budget` still bind:
reaching them means the change was not the uniform mechanical edit triage took it for, and the
answer is to escalate, not to keep sweeping.
