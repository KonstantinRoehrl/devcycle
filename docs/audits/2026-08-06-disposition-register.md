# Disposition register — v0.12 overhaul (opened 2026-08-06)

Every finding this programme inherited, and what happened to it. Cycle 1 creates the register
and closes its own rows; cycles 2 and 3 close theirs. A row is never deleted — a finding that
turns out to be wrong is dispositioned `declined` with the reason, not removed.

Disposition is one of: `fixed-here` (with the commit or task), `cycle-2`, `cycle-3`,
`issue-filed` (with the issue number), `declined` (with a reason).

| id | source | severity | disposition | where |
| --- | --- | --- | --- | --- |
| A1 | audit | critical | fixed-here | PR #41 (`4bbdb7d`) — redaction classes extended |
| A2 | audit | critical | fixed-here | PR #41 (`4bbdb7d`) — gitleaks over history |
| A3 | audit | high | fixed-here | Task 4 (playbooks carry no roster entry, so no trigger to auto-fire) + Task 11 (routing table cross-checks `disable-model-invocation` against a declared consequence) |
| A4 | audit | high | fixed-here | Task 4 (playbooks are unreachable by trigger phrase) + Task 10 Step 6 (`continue` enumerates every resumable cycle) + Task 11 (`resume` consequence requires the guard) |
| A5 | audit | high | declined | GitHub-side: `main`'s ruleset exempts the admin role from force-push/deletion. The user chose the code-only hotfix (PR #41) and explicitly left this unactioned — `.devcycle/scope.md` "Flagged, NOT in scope — GitHub-side, cannot be changed from code" |
| A6 | audit | high | cycle-2 | instrumentation — per-run metadata (block E) |
| A7 | audit | high | cycle-2 | instrumentation — attribution fill (block E) |
| A8 | audit | high | cycle-2 | instrumentation — unattributed-bucket mechanism (block E) |
| A9 | audit | high | cycle-2 | instrumentation — run identity (block E) |
| A10 | audit | high | cycle-3 | improvement loop — cites known-issues F1+F2 |
| A11 | audit | high | fixed-here | Task 1 (commit-convention CI gate) + Tasks 3/6/7 (loop caps via `references/loops.md`) + Task 12 (golden-path fixture) + Task 16 (mechanically-checkable scenarios harvested, the rest deleted) |
| A12 | audit | high | cycle-2 | instrumentation — version-cohort sort (block E) |
| A13 | audit | high | cycle-2 | instrumentation — cohort-of-one regressions (block E) |
| A14 | audit | high | fixed-here | Task 4 — `doctor` skill dissolved into `playbooks/profiling-sessions.md`; only the command occupies `devcycle:doctor` now |
| A15 | audit | high | fixed-here | Task 4 — playbooks carry no frontmatter/trigger string at all, so an unenforceable "invocation precondition" has nothing to attach to; Task 11's routing table is the new single trigger owner |
| A16 | audit | high | cycle-3 | improvement loop — doctor's rendering of the F1-tainted recurrence metric, not yet corrected |
| A17 | audit | high | cycle-2 | the `readRecords` component ships in Task 14 (QC9, ENOENT-only catch); torn-JSONL-line and unpriced-model-count gaps remain cycle-2 instrumentation work |
| A18 | audit | high | fixed-here | Task 3 (`references/loops.md` — stale statuses archived, never left in place) + Task 7 Step 5 (finish path archives contradicting verdicts) |
| A19 | audit | high | fixed-here | Task 7 Step 5 — finish path archives every superseded status file, not only at finish |
| A20 | audit | high | fixed-here | Task 3 (`references/loops.md`) + Task 5 Step 3 (dream loop, cap 2) + Task 6 Step 3 (executing-waves, cap 3) + Task 7 Step 3 (fast-path/sweep, cap 2) |
| A21 | audit | high | fixed-here | Task 7 Step 4 — fast-path exit status written to `.devcycle/findings/fast-path-status.md` before reporting |
| A22 | audit | high | unassigned | no cycle-1 task touches `workflows/review-panel.js`'s model-env-var resolution; not instrumentation, not a typed-agent or improvement-loop subject — needs an owner |
| A23 | audit | high | fixed-here | Task 13 Step 2 — deletes DESIGN.md's drifted copy of the handoff context-action table, points at `references/handoff.md` |
| A24 | audit | high | cycle-3 | improvement loop — cites known-issues F3 |
| A25 | audit | high | fixed-here | Task 10 Step 3 (`commands/review.md` replaces `audit.md`) + Task 5 Step 2 (merges `auditing-a-repo` into `reviewing-code`) + Task 11 (routing table names `review` for branch/repo/file-set review) |
| A26 | audit | medium | fixed-here | Task 5 Step 3 (`dreaming-across-sessions` + `distilling-learnings` merge into `playbooks/learning-from-sessions.md`) + Task 10 Step 4 (`commands/learn.md` replaces `dream.md`/`distill.md`) |
| A27 | audit | medium | fixed-here | Task 4 (playbooks unreachable by trigger, so the skill path cannot be invoked directly any more) + Task 8 (prose cut confirms the surviving scope) |
| A28 | audit | medium | fixed-here | Task 10 Step 6 — `continue` finds and lists every resumable cycle, asks which one, never silently picks a slot |
| A29 | audit | medium | fixed-here | Task 10 Step 2 — first-run/upgrade prose moved out of `cycle.md`, pointed at `references/config.md` |
| A30 | audit | medium | fixed-here | Task 15 — `duplication-check.mjs` widened to `commands/`+`agents/`, same-file skip removed, sub-threshold shingle pass added |
| A31 | audit | medium | fixed-here | Task 9 (references dedup) + Tasks 6–8 (playbook prose cuts) + Task 15 (checker now catches what survives) |
| A32 | audit | medium | fixed-here | Task 13 Step 2 — DESIGN.md's taxonomy sections rewritten to the seven commands and the five-layer model |
| A33 | audit | medium | fixed-here | Task 5 Step 3 + Tasks 6–9 — deletion-test prose cuts across the merged and remaining playbooks/references |
| A34 | audit | medium | fixed-here | Task 16 — `tests/scenarios/` harvested (mechanically-checkable assertions) then deleted |
| A35 | audit | medium | cycle-3 | the improvement loop is explicitly this finding's own subject (block F) |
| A36 | audit | medium | cycle-3 | improvement loop — `artifactFresh` self-exclusion granularity |
| A37 | audit | medium | cycle-2 | benchmarks — the dreaming benchmark record's own claims (block E) |
| A38 | audit | medium | cycle-3 | improvement loop — cites known-issues F4, F5, § Observation files |
| A39 | audit | medium | cycle-2 | instrumentation — cache/price-vintage confounds (block E) |
| A40 | audit | medium | cycle-2 | instrumentation — token·turns unit mislabeled as tokens (block E) |
| A41 | audit | medium | cycle-2 | instrumentation — windowed vs. unwindowed runs incomparable (block E) |
| A42 | audit | medium | cycle-2 | instrumentation — doctor has no self-exclusion (block E) |
| A43 | audit | medium | cycle-2 | instrumentation — "verified" numbers with no error bars (block E) |
| A44 | audit | medium | unassigned | no cycle-1 task changes `reviewing-the-branch` behaviour (Task 7 is prose-cuts only, `green-green`/behavior-preserving) — the coordinator still duplicates the spec lens's job; needs an owner |
| A45 | audit | medium | unassigned | no task adds `graphify-out/` or `docs/overhaul/` to `.gitignore` — a real QC6-adjacent gap; flagged for the coordinator |
| A46 | audit | medium | unassigned | no task adds a content-level screen on the write path of excerpt-carrying dream artifacts |
| A47 | audit | medium | cycle-2 | forward-looking prerequisite for the run-identity work (A6/A9); also bears on cycle-3's Loop B/cross-repo design — flag both when those land |
| A48 | audit | medium | unassigned | no task codifies the live GitHub ruleset as tracked config + a CI assertion |
| A49 | audit | medium | declined | GitHub-side: `dev` has no ruleset while `prepare-release.yml` pushes to it directly. Same user decision as A5 — left unactioned alongside it (`.devcycle/scope.md`) |
| A50 | audit | medium | fixed-here | Task 1 Step 5 — PR-title check now re-fires on `edited` |
| A51 | audit | medium | fixed-here | Task 1 Step 2 — `timeout-minutes` and a pinned `ubuntu-24.04` runner added to every job |
| A52 | audit | medium | fixed-here | Task 13 Step 3 — README's doctor no-arg scope claim corrected to match `scripts/doctor.mjs` |
| A53 | audit | medium | fixed-here | Task 4 — playbooks carry no trigger string; `scoping-the-request.md` is reachable only by path load from `cycle.md`, so no competing trigger exists to lose to |
| A54 | audit | medium | fixed-here | Task 4 — direct skill-roster entry no longer exists; every playbook is loaded only by path from a command, so "bypasses Step 0" has no route left to take |
| A55 | audit | low | cycle-3 | improvement loop — cites known-issues F6 |
| A56 | audit | low | unassigned | no task touches `ledger.md`'s timestamp-ordering mechanism |
| A57 | audit | low | cycle-3 | improvement loop — distill's memory-intake dual ownership |
| A58 | audit | low | cycle-3 | typed agents — this finding's own subject (block D) |
| A59 | audit | low | declined | informational only — the audit's own text: "No fix; recalibrates the restructure's docs scope" |
| A60 | audit | low | fixed-here | Task 4 — playbook frontmatter (including `description:`) deleted entirely, removing the competing trigger strings from the description budget |
| A61 | audit | low | fixed-here | Task 1 — `persist-credentials: false`, `env`-based ref interpolation, PR-title re-check added; the sha-pin-comment mismatch and `required_approving_review_count: 0` are confirmed positives per the audit's own text, not defects to fix |
| A62 | audit | low | unassigned | no task edits the graph-first orientation carve-out in `references/delegation.md` (Task 9 is dedup-only, behavior-preserving) |
| KI-F1 | known-issues | high | cycle-3 | `--check-recurrence` structurally near-incapable of firing — cited by A10 |
| KI-F2 | known-issues | high | cycle-3 | reduce not reproducible on identical input — cited by A10 |
| KI-F3 | known-issues | high | cycle-3 | `standard`-depth dreaming cannot see user turns — cited by A24 |
| KI-F4 | known-issues | medium | cycle-3 | corpus `totalBytes` overstates model-visible input ~34× — cited by A38 |
| KI-F5 | known-issues | medium | cycle-3 | slice granularity loses within-session growth permanently — cited by A38 |
| KI-F6 | known-issues | low | cycle-3 | observation filenames never validated against the manifest — cited by A55 |
| KI-OBS | known-issues | medium | cycle-3 | observation files validated only on the happy path — cited by A38 |
| KI-RR | known-issues | high | fixed-here | Task 14 Step 5 — `readRecords` catch narrowed to `ENOENT`, every other filesystem error now surfaces (QC9) |
| BR1 | branch-review | medium | declined | already fixed by `c48f94d` — the archive glob/index collision is now resolved in code: `index` travels inside the ledger-glob value, and a reader sorts the glob's expansion before indexing into it (`scripts/dream.mjs`, `archives()`) |
| BR2 | branch-review | medium | declined | already fixed by `c48f94d` — `messageText`'s unit test now asserts on a plain-string `content` value, which distinguishes the real extractor from both cited mutants (`return JSON.stringify(record)` and deleting the string-content branch) (`tests/unit/dream.test.mjs`) |
| BR3 | branch-review | medium | declined | already fixed by `c48f94d` — the doctor skill's text now explicitly instructs rendering the artifact's `capped` value alongside the hits, so a cap-truncated corpus no longer reads as a clean bill of health |
| BR4 | branch-review | medium | declined | already fixed by `c48f94d` — the recurrence step is now gated on profile (skipped at `lean`), and doctor renders the appendix as "empty-not-checked" rather than a plain empty result when the artifact's `Profile:` line reads `lean` |
| BR5 | branch-review | medium | cycle-2 | still present — the doctor skill's frontmatter and "Interpret, don't transcribe" step still say "rank … by dollar impact" while its own "Severity, ranking" section says the dollar figure is "never the sort key"; instrumentation-reporting subject, not covered by any cycle-1 task |
| BR6 | branch-review | medium | declined | already fixed by `c48f94d` — DESIGN.md §15.2 no longer carries a copy of the profile matrix; it now points at `references/config.md` as the single owner, per §15.1 |
| SC1 | task-16 | medium | cycle-3 | **3 of the 56 `tests/scenarios/` files were deleted with nothing harvested** — `auditing-a-repo/description-sufficiency.md`, `dreaming-across-sessions/description-sufficiency.md`, `scoping-interview/description-sufficiency.md`, each of which grades six model verdicts against expected labels and yields no assertion a file read can settle. The other 53 gave up only their file-readable half (now 53 `harvested:` tests in `tests/unit/golden-path.test.mjs`); what all 56 graded about a *running* agent — whether a question was well formed, whether a stop was actually taken, whether a review found the real defect — is unasserted anywhere. Needs an LLM-judge runner; deferred with the instrumentation that would make its output trustworthy |

## Notes on this register's id scheme and scope

- `KI-*` ids are `docs/known-issues.md`'s eight open entries (its own `F1`–`F6` labels, plus
  `KI-OBS` for "Observation files are validated only on the happy path" and `KI-RR` for
  "`readRecords` swallows every filesystem error", neither of which carries a letter label in
  the source file).
- `BR1`–`BR6` are the six medium carry-overs listed in
  `.devcycle/archive-2026-08-05-dreaming-that-pays-for-itself/findings/branch-review-final.md`
  under "Carry-overs — non-blocking, recorded (medium)", in that file's own numbered order
  (1–6). Each was re-verified against the current tree per this task's Step 4, not assumed
  closed.
- That same report's three blocking findings (B1–B3, self-exclusion/timestamp-comparison/
  fixture-collision) and its "low" carry-over paragraph are **not** rows here: B1–B3 are
  resolved (independently confirmed in `scripts/dream.mjs`'s current comments, which name the
  exact fixes) and so are not "unresolved carry-overs" per this task's Step 2; the "low"
  paragraph and its trailing "round-1 medium residue not re-raised" sentence are the source
  report's own meta-commentary, not findings the current cycle inherited as open. Per this
  task's coordinator resolution, only `branch-review-final.md`'s "~6 medium carry-overs" are
  in scope — the many per-task round files in the same archive directory are prior-cycle
  review rounds already resolved inside the shipped `c48f94d`, not carry-overs.
- `SC1` is the one row this cycle's own work opened rather than inherited: task 16 deleted
  `tests/scenarios/` and this row records what that deletion dropped. Its `source` is the task
  that raised it, not an audit.
- `unassigned` is not one of the five disposition values this register's own header defines.
  It is used only where a row is confirmed genuinely open, does not match cycle-2's
  instrumentation/benchmarks charter or cycle-3's typed-agents/improvement-loop charter, and no
  task in the 16-task cycle-1 plan (`docs/superpowers/plans/2026-08-06-v0.12-overhaul-cycle-1.md`)
  touches it — `declined` would misrepresent an unactioned finding as a decision, and
  `fixed-here` would misrepresent it as closed. Seven rows use it: A22, A44, A45, A46, A48,
  A56, A62. All seven need a coordinator decision — either a task in a later wave of this same
  cycle, or an explicit carry to cycle-2/cycle-3/an issue.
- `fixed-here` citing a task number (rather than a landed commit) means the cited cycle-1 task's
  own steps state the fix explicitly; it does not mean the task has executed yet. This register
  is written from Wave 1, before most of cycle 1's 16 tasks have run.
