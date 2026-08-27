# Config changelog — the userConfig knob history

The single owner of every `userConfig` addition, rename, and deprecation and the version
each landed in. Two consumers read it: `${CLAUDE_PLUGIN_ROOT}/playbooks/profiling-sessions.md`'s config-drift mode
(`scripts/doctor.mjs`'s `--drift` flag) and `${CLAUDE_PLUGIN_ROOT}/playbooks/learning-from-sessions.md`, which calls
into that same mode rather than re-implementing stale-key detection. Neither restates
the history below; both parse it.

Append-only: every future `userConfig` change adds a new record here in the same PR that
ships it — a written discipline `bump-version.yml`'s automation does not (and should not)
enforce mechanically, alongside the existing "no phase double-defined" rule. A record
written before its release carries `version: "unreleased"`; the release step replaces that
marker with the version the change lands in, since only the release computes that number.

```yaml
- version: "0.4.0"
  change: added
  key: implementerModel
  default: auto
  note: "one of four flat model-selection knobs added this release (taskReviewerModel, branchReviewModel, walkthroughModel alongside it)"
- version: "0.4.0"
  change: added
  key: taskReviewerModel
  default: auto
- version: "0.4.0"
  change: added
  key: branchReviewModel
  default: auto
- version: "0.4.0"
  change: added
  key: walkthroughModel
  default: auto
- version: "0.4.1"
  change: added
  key: gitPolicy
  default: local-commits-only
  note: "earliest evidenced CHANGELOG entry (a hardening fix, respecting permission/branch-push restrictions); exact introduction version unconfirmed from CHANGELOG prose"
- version: "0.8.0"
  change: added
  key: profile
  default: standard
  note: "preset governing reviewDepth/onDeviceGate; superseded per-knob defaults below it"
- version: "0.8.0"
  change: added
  key: reviewDepth
  values: [single, panel, auto]
  note: "auto added same release, hands the knob back to the profile column"
- version: "0.8.0"
  change: added
  key: onDeviceGate
  values: [human-required, auto-ok, auto]
  note: "earliest evidenced CHANGELOG entry for the knob's auto-value support; exact original introduction version unconfirmed from CHANGELOG prose"
- version: "0.8.0"
  change: added
  key: crossModelReview
  default: false
  note: "earliest evidenced CHANGELOG entry; exact original introduction version unconfirmed from CHANGELOG prose"
- version: "0.9.2"
  change: added
  key: reviewDepth
  note: "depth-gate and model-routing predicates refined per the token-audit follow-through (#28/#29) — not a new key, a behavior refinement of the existing one"
- version: "0.13.0"
  change: added
  key: implementerModel
  note: "allowed values widened: alongside `auto` and a single model id, a comma-separated pool of ids resolved by complexity band, with every path clamped to the orchestrator's own tier"
- version: "0.13.0"
  change: added
  key: taskReviewerModel
  note: "allowed values widened: alongside `auto` and a single model id, a comma-separated pool of ids resolved by complexity band, with every path clamped to the orchestrator's own tier"
- version: "0.13.0"
  change: added
  key: walkthroughModel
  note: "allowed values widened: alongside `auto` and a single model id, a comma-separated pool of ids resolved by complexity band, with every path clamped to the orchestrator's own tier"
- version: "0.13.0"
  change: added
  key: branchReviewModel
  note: "allowed values widened: alongside `auto` and a single model id, a comma-separated pool of ids resolved by complexity band, with every path clamped to the orchestrator's own tier"
- version: "0.13.1"
  change: added
  key: docTrackingPolicy
  values: [standard, all-local, all-tracked]
  default: standard
  note: "settles which devcycle artifacts a host repo commits — lessons and promotions tracked, single-run specs and plans kept local; the repo's own .gitignore always wins"
- version: "unreleased"
  change: added
  key: learnStalenessSessions
  default: 5
  note: "one of two non-profile integer knobs gating the finish stage's /devcycle:learn staleness nudge (learnStalenessDays alongside it); whichever threshold crosses first triggers the one-line nudge"
- version: "unreleased"
  change: added
  key: learnStalenessDays
  default: 14
  note: "days since the last /devcycle:learn before the finish stage nudges; paired with learnStalenessSessions, whichever crosses first"
```

## Root cause — `devcycle:continue` cost regression at 0.12.0 (#82)

Not a `userConfig` change, so it stays below the fenced knob history above rather than inside it
(only the first fenced YAML block is parsed for config drift). This section deliberately names
`handoff.md` in bare prose, not as a `${CLAUDE_PLUGIN_ROOT}` citation, so the context-budget
walker does not pull handoff's reference subtree into every playbook that cites this file.

`devcycle:continue`'s measured cost regression at 0.12.0 is the v0.12 playbook-architecture
overhaul: pre-0.12 `continue` was an inline command; post-0.12 it runs the full resume protocol
and loads the recorded stage's playbook (assumption — attributed to the v0.12 overhaul, not
re-measured here). It is compounded by forward-fill attribution of the 132 pre-instrumentation
sessions predating trustworthy run records (instrumentation landed in commit `b25b51c`,
`feat(instrumentation): add trustworthy run-record instrumentation (#45)` — verified; the
132 count is an assumption carried from prior profiling). Cost joins to the
`[startedAt, endedAt)` stage window at `scripts/doctor.mjs:727-737` (`within(t, s.startedAt,
s.endedAt)` — verified), so the entry-time `startedAt` fix (handoff.md's stage-record paragraph)
attributes resume cost correctly going forward; the historical no-record sessions cannot be
re-measured retroactively. The actual context-load reduction is a deferred, measurement-driven
follow-up.
