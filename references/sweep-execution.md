# Sweep-executed tasks inside a wave

The single owner of how a plan task marked `**Execution:** sweep` runs inside the execution
stage. No existing file owns this: `${CLAUDE_PLUGIN_ROOT}/playbooks/sweeping-mechanical-changes.md` is a playbook — the
standalone short path — and owns the sweep *invocation* contract, while
`${CLAUDE_PLUGIN_ROOT}/references/evidence.md` and `${CLAUDE_PLUGIN_ROOT}/references/ledger.md` own the shape of the artifacts a
sweep writes, neither of them the per-task cycle a sweep replaces.
`${CLAUDE_PLUGIN_ROOT}/playbooks/executing-waves.md` names this file and does not restate it.

A task whose plan entry carries `**Execution:** sweep` replaces steps 2–3 of that playbook's
per-task cycle with one run of the mechanical-sweep workflow; steps 4–7 then apply with the
deltas below. The invocation contract — args-JSON shape, the `$(cat …)` invocation,
`DEVCYCLE_SWEEP_MODEL` resolution, the clean-targets precondition, the exit-code taxonomy, and
the re-run rule — is owned by
**${CLAUDE_PLUGIN_ROOT}/playbooks/sweeping-mechanical-changes.md** (REQUIRED, its steps 2–4).

- **Run it.** Take files, instruction, and verifyCommand verbatim from the task body into
  `.devcycle/sweep-args-<task-id>.json` and save the stdout report to
  `.devcycle/sweep-report-<task-id>.json` — per task, since the triage path's single names would
  collide across concurrent sweeps. Ledger IMMEDIATELY before the invocation, in
  `references/config.md`'s audit shape: `event=dispatched outcome=sweep model <decision>`, so a crash
  mid-sweep still shows the task dispatched.
- **Clean targets** apply before a task's FIRST invocation, and a dirty target means the sweep does
  not run for that task: ledger `event=user-decision outcome=sweep dirty-targets` naming the files,
  then the fallback below. On a re-run of a task already logged `dispatched outcome=sweep`, dirty
  targets are the interrupted run's own edits and take the sweep playbook's Resume confirmation
  instead.
- **Exit 0, `applied` non-empty.** The saved report IS the implementer report: ledger
  `event=report-received` with it as `ref=`, then the task-reviewer dispatch (report included, skips
  and all), the green gate, and the acceptance commit exactly as steps 4–7 define. No implementer
  exists to write the evidence files, so the coordinator writes them itself per
  `references/evidence.md`, with one binding substitution: `<task-id>` is the plan's task number, not
  the literal `sweep` id that reference names for the standalone triage route.
- **Exit 0, `applied` empty.** Nothing was swept: no diff to review, nothing to commit, steps 4–7 do
  not apply. Ledger `event=report-received outcome=sweep applied-none` with the report as `ref=`,
  relay its per-file reasons verbatim, then the fallback — that line already marks the pending
  decision, so log nothing further.
- **Hard stop** (exit 1 with a stdout report): ledger `event=review-verdict outcome=rejected (sweep
  hard stop: <reason>)`, then the fallback. A fatal exit 1 without a report logs no verdict.
- **The fallback**, in each case above, is a user decision: corrected parameters and a re-run, or a
  normal `devcycle:implementer` dispatch for the task. A **rejection** of a swept diff (reviewer
  findings or green gate) goes straight to that implementer dispatch, never a sweep re-run of the
  rejected instruction. Any such brief must disclose the files the sweep already applied, or instruct
  reverting them first; it never assumes a clean slate.
