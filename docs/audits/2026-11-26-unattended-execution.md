# Unattended execution on 0.34.x: what changed since the execution-economy audit

- Baseline: `docs/audits/2026-11-24-execution-economy.md` (174 driven sessions, 39 cycles, plugin 0.32.0 to 0.33.0)
- Audited content: plugin 0.34.0 run records, written 2026-11-24 to 2026-11-25
- Issues touched: #456 (coordinator routing, interruptions), #494 (model policy), #374, #406, #432 and #487 are cited only where a finding meets them, never restated

This is a delta audit. It re-measures only what 0.34.0 records can show and cites the baseline's finding number for any figure it does not re-derive. Baseline figures are taken from the baseline document as written; the per-session and per-task rates beside them are plain division of those figures and are marked "derived".

`<research>` below means `.devcycle/research/unattended-execution-2026-11-26/`, the gitignored folder that holds every script and JSON output behind a figure.

## Summary

**The delta is thin: 29 driven sessions in 8 runs, all on plugin 0.34.0, in 2 repositories, over two days.** It is enough to say what did not move and to inventory five stops (every figure in this summary is derived in a later section with its command). It is not enough to estimate a rate, and the one rate that can be tested (zero sessions that committed nothing) is called out as unattributed.

- **Cost.** The 29 sessions (verified: `node <research>/corpus.mjs`, `driveRows`) cost **$54.39**, or $1.88 per session against a derived $1.96 in the baseline. The coordinator layer, the driven session's own thread, cost $23.56 (43.3% of the total, $0.81 per session, $0.44 per committed task). The baseline's derived figures are $0.76 per session and $0.44 per task. The coordinator layer did not change measurably, which fits 0.34.0 being the release the baseline audited rather than one that acted on it.
- **Repeated work fell.** 6 of 56 tasks were dispatched to an implementer more than once (verified: `node <research>/measure.mjs`, `tasksWithDispatch` and `tasksWithRedispatch`), and the repeats cost $1.36 against the baseline's 59 repeats at $26.85 (finding 7). No dispatch was a usage-limit kill.
- **Interruptions.** 5 of 29 sessions stopped (verified: `node <research>/corpus.mjs`, `stoppedSessions`), all `needs-user`, none stalled. By class: **4 avoidable, 1 auto-recoverable, 0 human-only.** Three of the four avoidable stops were a task whose Files list was too narrow, in plans whose gate had already run its blast-radius check. Every stopped session still committed at least one task, and every restart came within 2 minutes.
- **Probe.** The Agent tool takes a family alias only. `CLAUDE_CODE_EFFORT_LEVEL` overrides every subagent's effort, and without it a subagent with no `effort:` key runs at the model default. The export therefore stays.
- **Recommendation.** Adopt the policy's coordinator default: the fast tier (the Sonnet family), capped at the opt-in model. Expected cost change: **zero** for a Sonnet opt-in (all 29 sessions here (verified: `node <research>/corpus.mjs`, `costByModel` holds only `claude-sonnet-5-5`) and, by baseline finding 3, all 174 there). For an Opus opt-in the coordinator share halves: this corpus's coordinator tokens price at $47.11 on Opus and $23.56 on Sonnet, a saving of $0.81 per driven session. No Opus-opted-in driven run exists in either corpus, so the quality side of that move is unmeasured.
- **Follow-ups.** Four drafted issues, none filed (see the section so named).

## Sample

| Item | Count | Command |
| --- | --- | --- |
| Run records with `pluginVersion` starting `0.34.` | 10 | `node <research>/corpus.mjs` |
| Of those, with at least one `drive` row | 8 | same |
| `drive` rows (driven sessions) | 29 | same |
| Plugin versions seen | 0.34.0 only | same |
| Repositories with a drive row | 2 | same (`repositories`) |
| Span | 2026-11-24 to 2026-11-25 | same (`firstStart`, `lastEnd`) |
| Committed tasks across the 29 sessions | 54 | same (`committedTasks`, the sum of `committedAfter - committedBefore`) (verified: `node <research>/corpus.mjs`) |
| Driven-session transcripts found | 29 of 29 | `node <research>/transcripts.mjs` |

The planning pre-count was 10 records, 8 with drive rows and 29 drive rows; the recount agrees. The two records without a drive row are this audit's own planning run and the previous cycle's audit run. Every driven coordinator ran `claude-sonnet-5-5`, so the sample says nothing about any other coordinator model.

The records were frozen into `<research>/snapshot.json` on the day of the audit because a live cycle keeps appending to its own record; every figure below comes from that snapshot.

How thin: the baseline has 174 sessions (baseline document, summary), this has 29 (verified: `node <research>/corpus.mjs`, `driveRows`), from two repositories that mostly ran one plan each. A rate seen here carries a wide interval. 5 stops in 29 sessions is 17%, and its 95% interval (Wilson) is roughly 8% to 35%, which contains the baseline's derived 12.6% (22 of 174, finding 4). Nothing below claims a rate difference unless it states why a sample this small can show it.

## Cost and redundancy since the baseline

### C1. The cost split by layer matches the baseline's within noise

| Layer | 0.34.0 dollars | Share | Baseline dollars (summary table) | Baseline share |
| --- | --- | --- | --- | --- |
| Coordinator (main thread of the driven `claude -p` session) | $23.56 | 43.3% | $132.69 | 38.9% |
| Implementers | $20.00 | 36.8% | $135.40 | 39.7% |
| Task reviewers | $10.49 | 19.3% | $66.43 | 19.5% |
| Other subagents | $0.34 | 0.6% | $6.16 | 1.8% |
| **Total** | **$54.39** | | **$340.69** | |

- Command: `node <research>/driven.mjs` (subagent rows counted when their `agent-cost` timestamp falls inside a `drive` row's window), and `node <research>/reprice.mjs` for the coordinator figure (the main thread, priced from the transcripts).
- The total is the sum of the 29 `drive` rows' `costUsd`, which is the CLI's `total_cost_usd` for the whole session, subagents included. A coordinator figure therefore needs the transcripts: it is the main thread's tokens priced with `scripts/pricing.mjs`, not the `drive` row.
- Compared with: baseline summary table. The implementer share is lower and the coordinator share higher, but the baseline split is of a different mix of plans, so the shift is not attributed to anything.

### C2. The coordinator's per-session and per-task cost is unchanged

| | 0.34.0 | Baseline (derived) |
| --- | --- | --- |
| Coordinator dollars per driven session | $0.81 ($23.56 over 29) | $0.76 ($132.69 over 174) |
| Coordinator dollars per committed task | $0.44 ($23.56 over 54) | $0.44 ($132.69 over 304 tasks, finding 1) (verified: `node <research>/reprice.mjs`, coordinator dollars; the 304 is the baseline's) |
| Tasks committed per driven session | 1.86 | 1.75 (304 over 174) |

- Command: `node <research>/reprice.mjs` and `node <research>/measure.mjs`.
- This finding re-measures baseline finding 1 (the per-session re-load). Nothing in 0.34.0 acts on it, and the figure shows no drift either way.

### C3. Repeated implementer dispatches fell, and none was a kill

- 56 tasks were dispatched; 6 got a second implementer dispatch (10.7%) (verified: `node <research>/redispatch.mjs`, `redispatchedTasks` 6, and `node <research>/measure.mjs`, `tasksWithDispatch` 56). The baseline had 59 repeats across 304 tasks (19.4%, finding 7).
- Cost of the later attempts: **$1.36**; the first attempts of those 6 tasks cost $2.02 (verified: `node <research>/redispatch.mjs`, `supersededFirstAttemptUsd`) (two of them were complete and went to a fix pass, so that sum is not all waste). The baseline's repeats cost $26.85, of which about $19.1 was superseded work after usage-limit kills and interrupts (finding 7).
- Cause, read from each run's ledger (`node <research>/ledgerscan.mjs`): 4 restarts after a stop or a blocked report (plan widened, sibling committed, Docker started), 1 fix pass after a red gate, 1 fix pass after a review rejection.
- No drive row exits for a usage limit: the only exit reasons are `handoff` (24) and `stopped` (5) (`node <research>/measure.mjs`, `driveCostByExit`).
- Second path: `doctor.mjs`'s 0.34.0 cohort reports `retries: 6`, the same count (`node <research>/cohort.mjs`). Its re-dispatch cause split prints `unknown 6`, because causes are only classified from 0.34.1 (`REDISPATCH_CAUSE_SINCE`), so the cause split above is the ledgers' and not doctor's.
- Reading: the drop is real in direction and probably in size (the baseline's redo class was kills and interrupts, which do not occur here), but 6 repeats is too few to rank causes. The re-dispatch metric's fix-pass versus redo split, which baseline finding 7 asked for, cannot be checked on 0.34.0 records.

### C4. Review churn is low

- 59 `verdict` rows over 56 reviewed tasks; 2 tasks needed more than one round (verified: `node <research>/measure.mjs`, `reviewRounds` 59, `tasksWithVerdict` 56, `tasksWithMoreThanOneRound` 2). The doctor cohort reports 56 rounds over 60 tasks (verified: `node <research>/cohort.mjs`), `blockingFindings: 0` and `conformanceFailures: 2` (`node <research>/cohort.mjs`).
- Rejections: 2 of 59 verdicts, both recorded as conformance failures in the run records: one a red gate after an accepted round (a Files-too-narrow case, see the inventory) and one a review rejection with blocking findings. Both were fixed in one pass and accepted next round. **No rejection was reversed by a later round** (zero tasks where the next round overturned a standing finding, from `node <research>/ledgerscan.mjs`, `rejectedThenAccepted` read against the ledger text).
- Compared with: the baseline reports reviewers' spend by layer only (finding 9), so there is no rounds-per-task baseline to compare against.

### C5. Every stopped session still committed work, where 15% did not in the baseline

- 0 of 29 sessions committed nothing (`committedAfter` equal to `committedBefore`) (verified: `node <research>/corpus.mjs`, `sessionsCommittingNothing` 0). The baseline had 26 of 174 (15%, finding 4, $30.12).
- If the baseline rate held, 0 of 29 would occur with probability about 1% (0.85 to the 29th power), so this is unlikely to be chance. The cause was **not measured**: the baseline's no-commit sessions were mostly usage-limit and interrupt restarts, which this corpus does not contain, so a different mix of failures, not a better driver, is the simplest explanation.

### C6. A Sonnet coordinator again dispatched an Opus subagent, and the ledger does not say so

- 1 of 56 task reviewers in the driven windows (verified: `node <research>/driven.mjs`, `counts.reviewerCalls` 56) ran `claude-opus-5-5` ($0.73), dispatched with an explicit `opus` model by a Sonnet coordinator (`node <research>/models.mjs`, the `agent-cost` row has `explicitModel: true`; its `agent-trace` row has `requestedModel: opus`). The run's ledger names no Opus (`grep -n -i opus` over that run's ledger found nothing).
- Compared with: baseline finding 5 (a Sonnet coordinator dispatched Opus subagents above the ceiling, unchecked) and finding 6 (the ledger's model audit line is missing for reviews). The recurrence is 1 in 56, far below the baseline's; the ceiling is still not enforced where it matters.
- In the same dispatch rows, 10 of 62 implementer `dispatch` rows carry an alias or a placeholder (`sonnet` 5, `session` 3, `inherited` 2) in `model` instead of a resolved id, and 35 of 62 are `modelSource: inherited` (`node <research>/models.mjs`). A second place the recorded model and the real one can part. This is what the doctor check drafted below would catch.

## Interruption inventory

29 driven sessions: 24 ended `handoff`, 5 ended `stopped` with `stopReason: needs-user`, and no session carries a `stallCount` above 0 (`node <research>/stops.mjs`). The 5 stops cost $12.89 (23.7% of the driven total; the baseline's 22 stops cost $51.29, 15.1% of its total).

The class column is a judgement, as it was in the baseline (finding 4): **avoidable** is a check before wave 1 or a script that could have prevented the stop; **auto-recoverable** is a retry or resume that finishes with no human input; **human-only** is a real decision.

| Exit reason | Count | Class | Evidence (run id prefix, ledger lines of the run's own ledger) |
| --- | --- | --- | --- |
| `stopped` / `needs-user`: task's Files list too narrow | 3 | avoidable | `7de17717` lines 12, 18, 19: task 2 reports blocked, task 3's gate goes red, the user amends the plan to add the files each needed (a test file, a reference, two budget fixtures, a decisions entry). `10b7829c` lines 30, 35: task 4 blocked, the user approves widening Files to a component spec. `bb362d0f` lines 32, 37: task 1 blocked a second time, the user authorises a one-line edit to a SQL test and adds it to Files. In all three the plan's gate had run and passed its blast-radius leg (`gate-ran` rows, `node <research>/stops.mjs`). |
| `stopped` / `needs-user`: Docker daemon not running | 1 | avoidable | `bb362d0f` lines 12, 29: task 1 reports blocked, the user starts Docker and resumes. A pre-flight check before wave 1 would have stopped it before any work was dispatched; the daemon itself is still the user's to start. This is the environment half of triage cluster C4 (pre-flight checks before wave 1); this audit only names the overlap. |
| `stopped` / `needs-user`: gate red from a sibling's uncommitted work | 1 | auto-recoverable | `9c198d1f` lines 14, 19: task 3's baseline check was red while task 1's edits were uncommitted in the same wave; once task 1 committed, the user's only input was "restart unattended" and task 3 passed on the same brief. The driver could re-dispatch a task blocked on a sibling after the sibling commits. |
| `handoff` | 24 | not an interruption | wave-to-wave handoffs, the planned exit |
| stall (`stallCount` above 0) | 0 | not applicable | `node <research>/stops.mjs` |
| Dispatch ended without output (inside a session, no exit) | 1 | not an interruption | `10b7829c` lines 20 to 25: task 6's implementer ended without output, its report was rejected as missing, and review round 1 started 14 seconds later and was accepted. The ledger has one `dispatched` line for task 6 and the run record one `dispatch` row (`retryIndex` 0, `outcome` complete), so there was no second dispatch (verified: `node <research>/redispatch.mjs` lists no task 6 in that run); how the report came to exist is not recorded. |

**Totals: 4 avoidable, 1 auto-recoverable, 0 human-only.** They count the five `stopped` sessions only; the `handoff`, stall and dispatch-ended rows are not exits and are not classed.

Reading:
- **The same failure dominates as in the baseline.** Baseline finding 4 counted 9 Files-too-narrow stops of 22 and suggested widening Files lists to the files a task's gate exercises. Here it is 3 of 5 (verified: the inventory table above; the 9 is `grep -n "Files lists too narrow" docs/audits/2026-11-24-execution-economy.md`, line 181). The planning gate's blast-radius leg now exists and ran on all three plans (it failed on early drafts and passed on the final one in each), yet the stops happened: the check does not reach what these tasks needed. That is a defect in the check's coverage, not a missing check. Drafted below.
- **Recovery was fast.** From each stop to the user's restart decision: 1.6, 0.6, 1.0, 1.3 and 1.1 minutes (drive-row `endedAt` to the ledger's `user-decision` stamp). The baseline's wait was a median of 1.2 and a p90 of 10.3 minutes across 22 stops. With a user present every time, the stops cost little wall-clock time here; what they cost is a human being needed at all.
- **Nothing here is human-only.** No stop was a real decision between alternatives; each was a mechanical extension or a restart. That is the baseline's conclusion too (10 to 12 of 22 preventable).
- Pre-flight checks before wave 1 are triage cluster C4. The Docker stop is the one case in this corpus that overlaps it; nothing is designed here.

## Probe results

The probe ran during planning, with the user's go-ahead, and was not re-run for this audit. Its working notes are the planning scratch file `spike-1.md` (local, not tracked). Setup: Claude Code 2.1.332, a scratch directory with one project agent (`probe-low`, `effort: low`, no `model:`), `--setting-sources project --strict-mcp-config --permission-mode auto`, coordinator `claude-sonnet-5-5`. Effort was read from each assistant record's `effort` field, which is the field `scripts/dispatch-health.mjs` reads. **Total cost: $0.247** (the six runs' `total_cost_usd`, summed).

| Run | Env | Coordinator | `probe-low` (`effort: low`) | `general-purpose`, model `haiku` (no effort key) | Agent `model` set to a full id (`claude-haiku-5-5`) |
| --- | --- | --- | --- | --- | --- |
| R1 | `CLAUDE_CODE_EFFORT_LEVEL=high` and `--effort high` | sonnet-5-5, high, 4 turns | sonnet-5-5, **high** | haiku-5-5, **high** | `InputValidationError`: expected one of `sonnet`, `opus`, `haiku`, `fable` |
| R2 | `--effort high` only | sonnet-5-5, high, 7 turns | sonnet-5-5, **low** | haiku-5-5, **medium** | the same `InputValidationError` |
| R3 | `--effort low`, `medium`, `xhigh`, `max`, no tools | sonnet-5-5 at each level, success | not applicable | not applicable | not applicable |

Findings:
1. The Agent tool's `model` takes a family alias only; a full id is a validation error. The dispatch value is the alias; the ceiling is enforced on family rank; an opt-in on an id older than its family's newest is a documented limit.
2. `CLAUDE_CODE_EFFORT_LEVEL` overrides every subagent's effort, frontmatter included (R1).
3. Without it, a subagent's `effort:` frontmatter holds (R2), and a subagent with no effort key does **not** inherit the session's `--effort`: it ran at medium (assumption: the model's default) under a high coordinator.
4. The coordinator's own effort holds from `--effort` alone (R2).
5. The fast-tier coordinator accepts every effort level the drive row can carry (R3).

**The decision it drove.** The Agent tool dispatches by family alias (`dispatchForm: alias` in `references/model-policy.json`). The `CLAUDE_CODE_EFFORT_LEVEL` export stays: devcycle's subagents carry no `effort:` key, so without the export every one of them would drop from the opted-in level to the model default, an effort default change the design rules out. A per-role subagent effort therefore needs the export dropped or overridden per dispatch, and a paid comparison first; it is drafted below, not built.

## Coordinator routing

**Recommendation: the policy's coordinator default stands, the fast tier capped at the opt-in model.** The policy table gives the coordinator `fast tier, capped at the ceiling` with the fast family `sonnet` (`references/model-policy.json`). Until now the driver copied the opting-in session's model unchanged (baseline finding 3), which made the session tier equal the fast tier on every one of 174 baseline coordinators and all 29 here (verified: `node <research>/corpus.mjs`, `costByModel`).

Expected cost change, from the model split in C1 and `scripts/pricing.mjs` (`PRICING`):

| Opt-in model | Coordinator before | Coordinator after | Change on this corpus's 29 driven sessions (verified: `node <research>/corpus.mjs`, `driveRows`) |
| --- | --- | --- | --- |
| Sonnet (`claude-sonnet-5-5`) | Sonnet | Sonnet | **$0.00**: every coordinator in both corpora |
| Opus (`claude-opus-5-5`) | Opus: $47.11 | Sonnet: $23.56 | **-$23.56, about -$0.81 per driven session** |

- Command: `node <research>/coordinator-price.mjs` prices the 29 coordinators' main-thread tokens at each model's rates. Opus is exactly twice Sonnet at every token class in the table (input 4 against 2, output 20 against 10, cache read 0.2 against 0.1), so the ratio is 2.000.
- The Sonnet row is zero because nothing changes for it; the figure is the same arithmetic as C1, not a measurement of a new run.
- What the figure leaves out: subagent costs (the ceiling on a Sonnet coordinator now caps subagents at Sonnet, which is a quality and cost change for any Opus-opted-in run) and the coordinator's quality on Sonnet versus Opus, which no driven run in either corpus tested. A cheaper-than-Sonnet coordinator is not recommended: the table prices a Haiku coordinator's tokens at $1.55, but baseline finding 3 showed that a Haiku coordinator would clamp every subagent to Haiku under the current ceiling, and the policy's fast family is Sonnet.

## Follow-up issues (drafted, not filed)

Each is filed only at the cycle's finish, with the user's confirmation. Each ends with `Refs #456`.

**1. `feat(model-policy): set a subagent's effort per role`**
The policy's effort column ships as `inherit` for every role, because the `CLAUDE_CODE_EFFORT_LEVEL` export overrides every subagent's effort (probe finding 2) and none of devcycle's subagents carries an `effort:` key (probe finding 3). A per-role value needs the export dropped, or overridden per dispatch, and must not move any role's default silently. Compare a lower effort on reviewers and implementers against `inherit` in a paid paired run before changing any default. Refs #456.

**2. `feat(doctor): flag a dispatch whose transcript model differs from the ledger's resolved model`**
In 0.34.0 driven runs 10 of 62 implementer dispatch rows record an alias or a placeholder instead of a model id, and one task reviewer ran Opus under a Sonnet coordinator with no ledger line naming it. Nothing compares what the script resolved with what the subagent actually ran, so a coordinator that ignores the printed model goes unnoticed. Add a doctor check that joins each ledger dispatch to its transcript's model and reports mismatches. Refs #456.

**3. `fix(plan-cost): price a fast-tier dispatch as the Sonnet family`**
`PLANNING_MODELS.fast` in `scripts/plan-cost.mjs` is a Haiku-class id (verified: `grep -n "PLANNING_MODELS = " scripts/plan-cost.mjs`, line 40), while the policy's fast tier is the Sonnet family. The planning projection therefore prices every fast dispatch at $0.10 and $0.50 per million tokens where the Sonnet family costs $2 and $10, so it under-prices every fast dispatch by a factor of 20. Re-pricing moves every projection figure and its calibration, so it needs its own change and a recalibration. Refs #456.

**4. `fix(plan): widen a task's Files to the files its gate exercises`**
In 3 of 5 stops in 0.34.0 driven runs a task needed a file outside its Files list, and in every one of them the plan's blast-radius check had already run and passed. The files were a component spec, a SQL test, a reference with its budget fixtures and a decisions entry, which are the files a task's own gate reads or ratchets. Find why the blast-radius leg did not reach them and extend it, so the widening happens at planning and not as a mid-wave user decision. Refs #456.

## Coverage

**Sample.** 10 run records at plugin 0.34.x, 8 with drive rows, 29 drive rows, all 0.34.0, 2 repositories, 2026-11-24 to 2026-11-25 (see the Sample section). Driven spend counts only the 29 `drive` windows; the audit's own planning run and the previous audit run are in the corpus but contribute no driven spend.

**Instruments.**
- Run records under the user's runs directory: `drive`, `dispatch`, `verdict`, `agent-cost`, `agent-trace` and `event` rows.
- `scripts/doctor.mjs` with `NODE_OPTIONS=--max-old-space-size=12288` and an explicit `--dir` over a copy of the corpus sessions' transcripts (symlinks are skipped by doctor, so the folder holds copies).
- `scripts/pricing.mjs` for every repricing.
- The runs' own ledgers, read where they exist: 9 of the 10 corpus runs have one, and the one without is the previous audit's run, which has no driven sessions (`node <research>/ledgers.mjs`).
- `scripts/dispatch-health.mjs` was not run; the ledgers and run records already carry every dispatch's outcome.

**Refutation pairs.** Each headline figure was recomputed by a second path.

| Figure | Path 1 | Path 2 |
| --- | --- | --- |
| Driven total $54.39 | sum of the 29 `drive` rows' `costUsd` (`node <research>/corpus.mjs`) | each driven transcript, main thread plus subagent files, priced from usage rows with `scripts/pricing.mjs` and de-duplicated by message id: $54.39, worst row difference under 0.0001 (`node <research>/reprice.mjs`) |
| Coordinator $23.56 | main-thread tokens repriced from the transcripts (`reprice.mjs`) | the same figure as `main` cost in doctor's per-session `costByAgentType` over the 29 driven sessions: $23.56 (`node <research>/refute.mjs`); and the total minus the in-window subagent rows, $54.39 - $30.49 = $23.90, within 1.5% |
| Subagents $30.49 (implementers $20.00, reviewers $10.49) | in-window `agent-cost` rows (`node <research>/driven.mjs`) | transcript repricing of subagent files, $30.83 (`reprice.mjs`); the 1.1% gap is subagent work with no `agent-cost` row, which is the $0.34 "other" line |
| 29 sessions, 5 stopped, 0 stalled | drive rows (`node <research>/corpus.mjs`, `node <research>/stops.mjs`) | doctor sees the same 29 drive rows across the cohort (`driveRowsSeen: 29`, `node <research>/cohort.mjs`) (verified: `node <research>/cohort.mjs`) |
| 6 repeated tasks | dispatch rows per task beyond the first (`node <research>/redispatch.mjs`) | doctor cohort `retries: 6`; the ledger's second `dispatched` lines (`node <research>/ledgerscan.mjs`, `redispatchCauses`: 6) |
| 5 stops by cause | ledger `report-received` blocked and `user-decision` lines, with line numbers cited in the inventory | `drive` row `stopReason` (5 `needs-user`) and the stop-to-restart gap from `endedAt` to the ledger stamp |

The doctor total for the version cohort ($293.35, 91 sessions) (verified: `node <research>/cohort.mjs`, `versionCohort`) covers every session of the corpus's runs, planning and brainstorm included, and is not a driven figure; it is used only for its quality counters.

**Not measured.**
- Redundant reads inside a driven session (baseline finding 1): the coordinator layer did not change, so the baseline's figures stand and nothing was re-derived.
- Guard denials: the 29 drive rows carry 115 `guardDenials` (`node <research>/corpus.mjs`); their causes were not analysed.
- Depth bands (#487): the deepest drive row reached 150,723 depth tokens (`node <research>/corpus.mjs`), a figure only; no band decision was re-run.
- Any cost or quality effect of a different coordinator model: no driven run in either corpus used one.
- The cause of the zero no-commit sessions (C5).
- Why doctor's re-dispatch cause split reads `unknown` for every 0.34.0 re-dispatch is by design (`REDISPATCH_CAUSE_SINCE` is 0.34.1), so no cause split exists for this corpus except the ledgers'.
- Anything on 0.34.1 or later: the corpus has no record from those versions.

**Data caveats.** Pricing uses the table dated 2026-11-03 for every row. The stop classes are judgements from ledger text, as in the baseline. Ledger line numbers are of the runs' own local ledgers, which are not tracked. Counts of repeats use each run's `dispatch` rows, so a dispatch that wrote no row (a kill before intake) is not seen except through the ledger.

**Where the scripts live.** `.devcycle/research/unattended-execution-2026-11-26/`, which is gitignored and local: `corpus.mjs` (sample, `corpus-runs.txt` holds the run ids), `measure.mjs`, `driven.mjs`, `reprice.mjs`, `refute.mjs`, `models.mjs`, `redispatch.mjs`, `ledgers.mjs`, `ledgerscan.mjs`, `stops.mjs`, `transcripts.mjs`, `cohort.mjs`, `coordinator-price.mjs`, with the JSON each wrote beside them. Delete `snapshot.json` to re-walk the live records; the figures above come from the frozen one.
