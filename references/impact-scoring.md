# Impact scoring

The single owner of how devcycle quantifies what a culprit cost. A skill, command, or agent
that needs any of this names this file and does not restate it.

## The formula

For one key over one window:

    attributed(event) = costByStage[stage] / (dispatches whose startedAt falls in that stage's window)
    impact            = Σ attributed(event), over every event matching the key

`impact` is money: the summed cost of every occurrence. It already scales with frequency, so it
is never multiplied by frequency again — that would yield dollars×count and make the rendered
figure meaningless.

Always rendered as a dollar figure with its frequency beside it — `$X.XX (N occurrences)` —
never a bare unitless score.

## What "unmeasurable" means, and why it is not zero

Two cases return no score at all rather than `0`:

- no events matching the key in the window;
- a stage with cost but no dispatches inside its window, so there is no per-dispatch cost to
  attribute.

A matcher that cannot fire must never read as a clean bill of health.

## The grouping key

The key is `(event, stage)` while the journal carries no attribution. From the release that
turns on culprit attribution it becomes the culprit-id. The formula is unchanged either way.

## Signals that are derived, not written

Four signals are reconstructed from records that already exist, rather than journaled a second
time. Same-round `verdict` lines collapse to the latest before any of this fires — the reviewer's
`conformance = "pass"` line followed by the green gate's own `conformance = "fail"` line for that
round is one event, not two (the same collapse `qualitySignals` documents and both share):

| Signal | Derived from | Stage |
| --- | --- | --- |
| `review-reject` | a `verdict` line with `blockingCount > 0` or `conformance = "fail"` | `"execution"` |
| `first-round-accept` | a `verdict` line with `round = 1`, `blockingCount = 0`, `conformance = "pass"` | `"execution"` |
| `re-dispatch` | a `dispatch` line with `retryIndex > 0` | the stage active at `startedAt`, else `"unattributed"` |
| `escalation` | `dispatch.model` differing across any two dispatches of one `taskId` | the first dispatch's stage, else `"unattributed"` |

`"unattributed"` is a sentinel, not a member of the schema's stage enum or a `costByStage` key —
no stage window ever matches it, so `attributedCost` finds no dispatches and the event scores as
unmeasurable (`impact: null`), never `$0`.
