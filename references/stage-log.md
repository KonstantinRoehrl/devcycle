# Stage log

What each stage records as it goes, so a resume after a stop, a crash or `/clear` repeats no finished
sub-step. `scripts/stage-log.mjs` owns the file, `.devcycle/stage-log/<run id>.jsonl`, and this file
owns which keys each stage writes. Playbooks and `references/stages.json` notes point here and
restate nothing.

## The rule

**On entry,** read what is already done:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/stage-log.mjs" read --state .devcycle/state.md --stage <stage>`.
Skip every sub-step the table says a logged key covers, and take its answer or artifact from the log.
An empty result means nothing is done yet.

**As each sub-step finishes,** before starting the next, log it:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/stage-log.mjs" log --state .devcycle/state.md --stage <stage> --key <key> [--ref <path>] [--data '<json>']`.
Put answers in `--data` as JSON, with no apostrophe (write `\u0027`), and an artifact's path in `--ref`.
Logging a key again replaces its earlier value, so a repeated step is harmless. Never log a raw session
id or an absolute path. A log line never marks a review accepted or a stage complete; only `stage:`
does that (`references/resume.md` § Review acceptance is never inferable from git).

## What each stage logs

| Stage | Keys, written as each sub-step finishes | Resume skips |
| --- | --- | --- |
| scoping | `interview-batch-<n>` (questions and answers in `--data`); `research-map` (`--ref`); `scope-written` (`--ref` `.devcycle/scope.md`) | answered batches; research |
| brainstorm | `question-batch-<n>`; `section-approved-<slug>`; `builder-check`. The spec is written to its path early and recorded on `spec:`, whose annotation and the `spec-review` run event already hold the spec-reviewer result | decided questions; approved sections; finished checks |
| planning | `feasibility-verdict`; `plan-section-<slug>` (`--ref` the plan draft); `self-review-<item>` | the gate; written sections; passed checks |
| branch-review | `refutation-<round>`. Each lens's result file under `.devcycle/review/round-<n>/` is its own record | lenses with a result file; a finished refutation. The `single` engine has no lenses, so a stop there re-runs the round |
| on-device | `batch-answer`; `item-<id>` (verdict and evidence, `(auto)` ticks included) | items with a recorded verdict. The app is relaunched, because the stop ended it |
| audit | `criteria-confirmed` (criteria, scope and audit plan in `--data`); `research-map` (`--ref`). Only the audit stage logs: `/devcycle:review` and `/devcycle:maintain` share its playbook and own no state file | the criteria interview; research. The sweep itself re-runs, since no panel round directory is passed at this stage, and the finished document is already on `audit:` |
| diagnosis | `reproduction` (steps and evidence); `hypothesis-<n>` (what was tested and the result) | a confirmed reproduction; tested hypotheses. The report is already on `diagnosis:` |
| execution, fast-path | nothing new: the ledger, commit markers and git evidence already give exact positions | — |
| sweep | nothing new: its § Resume reverts and re-runs from clean, the one exception to exact resume | — |
| finish | nothing new: every step before `stage: done` re-derives from git, the knobs and `on-device-routing.mjs`, and repeats safely. A second push is a no-op, and `gh pr create` refuses a second PR and names the first (assumption). After `stage: done` the cycle is closed, so the archive and cleanup offer are not resumed | — |
| receiving-review | nothing new: it re-enters through its own §6.6 | — |
