# Impact scoring

The single owner of how devcycle quantifies what a culprit cost. A playbook, command, or agent
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

The key is the culprit-id when the event carries one, else `(event, stage)`. A run written by a
version whose writers journal the culprit (`playbooks/executing-waves.md` steps 5–6,
`references/ledger.md`'s `event` row) keys by culprit; an older run keys by `(event, stage)` and
renders as unattributed. The formula is unchanged either way.

## The win ledger

The symmetric half of the formula, owned here and implemented in `scripts/impact-ledger.mjs`: one
period carries a single net figure by pricing wins against the same per-occurrence cost the culprit
side already computes. A win entry in `references/culprits.json` (`kind: "win"`) may declare two
optional fields, both absent by default — an entry without them behaves exactly as before:

- `observes` — the impact keys whose occurrences count as this win happening. It is what makes a
  win countable at all: the journal names win *events* (`first-round-accept:execution`) while the
  vocabulary names win *slugs* (`first-round-clean-accept`), and `observes` is the only thing that
  joins the two namespaces. A win with no `observes` is counted only by its own slug and
  `novel:<slug>`, which the journal does not emit, so it scores zero occurrences.
- `prevents` — the culprit keys a held win avoids paying for. Its savings is `occurrences ×
  mean(cost-per-occurrence over every prevented key)` — the **mean**, not the sum, so declaring
  more prevented keys never inflates the figure.

Cost-per-occurrence is measured over a **baseline window that extends backwards past the period**,
never inside it: a cost measured inside the period would drive a successful win's baseline toward
zero occurrences, and the metric would then punish success. A win whose savings cannot be priced —
no occurrences in the period, no `prevents`, or any prevented key unpriced in the baseline —
renders `unmeasurable`, never `$0`; one unpriced win makes the whole period's win savings, and so
its net, unmeasurable.

A key on the `unattributed` sentinel is excluded from both the savings and cost totals **and from
the poison set** — it counts only into `excluded.events`. Because such a key is unmeasurable by
construction, letting it poison the total to null would render the net unmeasurable in most real
periods, so it is dropped before the sticky-unmeasurable fold rather than folded into it.

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

An explicit `review-reject` event beats the derived one: a run whose `events` carry any explicit
`review-reject` derives none from its verdict lines, so a run written by a version that journals
rejections at the writer is never double-counted, while an older run keeps its derived ones.
