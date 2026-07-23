# devcycle

An opinionated idea-to-verified-implementation pipeline for Claude Code: hand it a feature,
bug, or refactor description and it turns out a verified, publish-ready implementation. It's a
thin overlay on [superpowers] — no forking — and repo-agnostic; anything policy-related (git
behavior, model choice, review depth) is config, not baked-in prose.

## Install

```
claude plugin marketplace add KonstantinRoehrl/devcycle
claude plugin install devcycle@devcycle
claude plugin marketplace add obra/superpowers-marketplace
```

The third command satisfies devcycle's [superpowers] dependency (adding its marketplace
auto-installs it). Until then `claude plugin list` shows devcycle as failed to load — that
resolves itself once the marketplace is added.

## Quickstart

```
/devcycle:cycle add CSV export to the report page
```

## Configuration

| Knob | Values | Default |
| --- | --- | --- |
| `gitPolicy` | `local-commits-only` / `push-allowed` / `open-pr` | `local-commits-only` |
| `implementerModel` | model id | `claude-opus-4-8` |
| `taskReviewerModel` | model id | `claude-sonnet-5` |
| `walkthroughModel` | model id | `claude-sonnet-5` |
| `branchReviewModel` | model id | `claude-opus-4-8` |
| `reviewDepth` | `single` / `panel` | `single` |
| `crossModelReview` | `true` / `false` | `false` |
| `onDeviceGate` | `human-required` / `auto-ok` | `human-required` |

## Learn more

Pipeline rationale, architecture, and upstream-comparison notes: [DESIGN.md](DESIGN.md).
Release history: [CHANGELOG.md](CHANGELOG.md).

[superpowers]: https://github.com/obra/superpowers
