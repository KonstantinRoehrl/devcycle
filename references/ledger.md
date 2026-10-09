# The ledger — where progress is written

The single owner of the ledger's own *write* format: its preamble records and its per-event line.
No existing reference fits — `references/resume.md` owns reading position back *out* of the
ledger, `references/evidence.md` owns report and verdict shapes, and neither owns how the file
itself is written, which `resume.md`, `references/handoff.md` and the stage playbooks all point at.

Single source of truth for progress, at `.devcycle/ledger.md` — one ledger, never a second.
`playbooks/executing-waves.md` creates the file, before any per-event line, with these three
records at the top, each written once, in this order:

```
Plan: `<the plan path this stage was handed>`
Branch: `<topic branch>` (cut from `<integration or default branch>` at `<sha>`)
Profile: `<resolved profile>` (evidence tail <N> lines)
```

`Branch:` is recorded once that playbook's pre-flight has the topic branch, `Profile:` from its own
resolved profile, and its commit-convention pre-flight step appends a fourth line,
`Commit-convention:`, after these three once its derivation runs —
`references/commit-convention.md` owns that line's format. Then one
appended line per event, all four fields REQUIRED, exactly this shape:

```
- [<ISO-8601 UTC>] task=<id> event=<dispatched|report-received|review-round|review-verdict|committed|user-decision> outcome=<short> ref=<commit-sha|file|none>
```

The leading `[<ISO-8601 UTC>]` bracket is the output of `node "${CLAUDE_PLUGIN_ROOT}/scripts/stamp.mjs" now`,
taken when the entry is appended — never a narrated or estimated time.
A task script (§ Task scripts) appends one more token after `ref=`, `key=<id>/<event>/<round>/<retry>`:
`<round>` is the review round (0 before the first), `<retry>` the dispatch's retry index for that
task. A line without it stays valid, and a reader that does not know it ignores it.

After any compaction or resume, trust the ledger and `git log` over conversation memory.

## The run record

A second, machine-readable log of the same run — `scripts/run-record.mjs`'s append-only JSONL,
never read by this file's own reader (`references/resume.md`) and never reading the ledger back.
`references/evidence.md` § Why the evidence lives in files gives the same reasoning for why these
two logs never merge. One row per write site, not a restatement of `tests/fixtures/run-record.schema.json`'s field shapes:

| kind | written | by |
| --- | --- | --- |
| `run` | once, after config resolution, before the first confirmation | `commands/cycle.md` |
| `session` | once per real Claude Code session — cycle start, and the top of every `/devcycle:continue` | `commands/cycle.md`, `commands/continue.md` |
| `stage` | at every stage boundary | `references/handoff.md` |
| `dispatch` | once per implementer dispatch, at step 4 (report received) — never at step 3 (dispatch), since `endedAt`/`outcome`/round/retry are unknown until the envelope returns | `scripts/task-intake.mjs` |
| `verdict` | once per review round, at step 5 (after `event=review-verdict`) — never at step 4, since `round`/`blockingCount`/`conformance` are unknown until review runs | `scripts/task-verdict.mjs`, `scripts/task-commit.mjs` |
| `commit` | once per task commit, at step 7 | `scripts/task-commit.mjs` |
| `triage` | once per cycle, right after the triage confirmation | `commands/cycle.md` |
| `agent-depth` | once per finished subagent, on every `SubagentStop` from a session with a `session` row in the run `.devcycle/state.md` names — a kind of its own, separate from `dispatch`, so an implementer dispatch is never counted twice | `hooks/dispatch-sensor.mjs` |
| `agent-trace` | once per finished subagent turn in a session with a `session` row in the run — the hooks module's view of that subagent, under the same agentId as its `agent-depth` row; a continued agent writes another | `hooks/devcycle-mod.mjs`, through `hooks/mod-sink.mjs` |
| `event` | `gate-fail` / `gate-pass-clean` / `gate-deferred-foreign-change` once per green-gate run, at step 6 (`gate-deferred-foreign-change` when the whole-suite red is deferred to a concurrent sibling, per `playbooks/executing-waves.md` step 6 and `scripts/foreign-change-check.mjs`); `review-reject` once per `needs-changes` verdict, at step 5, carrying that verdict's `Culprit` slug and `--attributedBy coordinator`; `user-correction-at-gate` at any AskUserQuestion the user answers via "Other", carrying `--culprit <the nearest culprits.json slug, else novel:<slug>> --attributedBy coordinator` chosen by the coordinator from what the correction was about — the stage and the slug only, never the typed text; `depth-breach` alongside every `agent-depth` row marked `breach`; `gate-ran` once per `scripts/plan-check.mjs` run, carrying `result: pass|fail`. **A gate appends it exactly when a run record exists at that moment.** Everything else follows: a run-bearing command's stages append (`commands/cycle.md` mints the record, `commands/continue.md` resumes it), a standalone command's gates have no run to append to, a gate reached before the mint has none yet, and a surface reachable both ways appends only on the entry where the run exists — so a run carrying no `user-correction-at-gate` event says nothing about gates outside that boundary | `scripts/task-commit.mjs`, `scripts/task-verdict.mjs`, and every in-cycle surface that asks; `hooks/dispatch-sensor.mjs` (`depth-breach`); `scripts/plan-check.mjs` (`gate-ran`) |

## Task scripts

The execution stage's per-step writes, one script call each. A script appends a ledger line or a
run-record row only while holding a `<file>.lock` next to its target — a lock whose holder's pid is
gone or reused is reclaimed — and skips a line whose key, or a row whose identifying fields, already
exist, so a re-run after a crash adds nothing twice while the next round or retry still appends.
Each prints one JSON object (`ok`, `action`, `appended` — the keys it wrote and `rr:<kind>` per
run-record row — and the session's `depthBand`) and exits non-zero only on a usage (2) or
environment (3) error.

- `node "${CLAUDE_PLUGIN_ROOT}/scripts/task-dispatch.mjs" --run <run-id> --task <id> --role implementer|reviewer [--round <n>] [--model-decision "<decision>"]`,
  the brief on stdin, immediately before each dispatch: writes it to
  `.devcycle/briefs/<id>-<role>[-round-<n>].md`, appends `dispatched` (`outcome=model <decision>`, the
  `references/model-routing.md` audit shape; `outcome=implementer retry <k>` without the flag)
  or `review-round` (`outcome=round <n>`) with that path as `ref=`, and keeps the dispatch's start
  time for its `dispatch` row.
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/task-intake.mjs" --run <run-id> --task <id> --report <path> --status complete|blocked --agent-type <type> --model <id> --model-source explicit|inherited [--agent-id <id>]`
  once the implementer's envelope returns, against the task's latest `dispatched` line:
  `status: blocked` appends `report-received outcome=blocked` (action `needs-user`); a missing report,
  or one with no `- Evidence:` line, appends `outcome=rejected (missing report file)` (`missing-report`);
  a report failing `authored-claims-check.mjs` or `evidence-completeness-check.mjs` appends
  `outcome=rejected (intake bounce)` with its findings file as `ref=` (`bounce`); a clean one appends
  `outcome=complete` (`review`). All but a missing report write the `dispatch` row.
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/task-verdict.mjs" --run <run-id> --task <id> --round <n> --findings <path> --evidence-class red-green|green-green|convention`
  once the reviewer's envelope returns, against that round's `review-round` line: a findings file
  that is missing, empty or malformed (no `Verdict:`, or `needs-changes` without a valid `Culprit:`)
  appends `review-verdict outcome=rejected (missing findings file)` (`missing-findings`); otherwise
  `outcome=accepted` or `rejected`, the `verdict` row and, on `needs-changes`, the `review-reject`
  event row (`accepted` / `rejected`). A rejected round 3 writes the exhausted-unresolved status
  `references/resume.md` reads. Either script returns `needs-user` instead at a retry cap.
