# devcycle

An opinionated Claude Code pipeline: from a feature, bug, or refactor description to a
verified, publish-ready implementation. Thin overlay on [superpowers]; policy is config.

## Install
    /plugin marketplace add KonstantinRoehrl/devcycle
    /plugin install devcycle

## Quickstart
    /devcycle:cycle add CSV export to the report page

## Configuration
| Knob | Values | Default |
| --- | --- | --- |
| gitPolicy | local-commits-only / push-allowed / open-pr | local-commits-only |
| modelLineup | model per role | opus/sonnet mix |
| reviewDepth | single / panel | single |
| crossModelReview | true / false | false |
| onDeviceGate | human-required / auto-ok | human-required |

Details: [DESIGN.md](DESIGN.md) · [CHANGELOG.md](CHANGELOG.md)

[superpowers]: https://github.com/obra/superpowers
