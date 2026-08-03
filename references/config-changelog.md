# Config changelog — the userConfig knob history

The single owner of every `userConfig` addition, rename, and deprecation and the version
each landed in. Two consumers read it: `devcycle:doctor`'s config-drift mode
(`scripts/doctor.mjs`'s `--drift` flag) and `devcycle:distilling-learnings`, which calls
into that same mode rather than re-implementing stale-key detection. Neither restates
the history below; both parse it.

Append-only: every future `userConfig` change adds a new record here in the same PR that
ships it — a written discipline `bump-version.yml`'s automation does not (and should not)
enforce mechanically, alongside the existing "no phase double-defined" rule.

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
```
