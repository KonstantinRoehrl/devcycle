# Reinforcement policy — the bars the learn loop reinforces on

The single owner of the numeric thresholds devcycle's learn loop reads when it decides to
escalate a culprit or reinforce a win. A playbook, command, or script that needs one of these
numbers names this file and does not restate it.

Every threshold lives here, in one machine-readable block, so no dollar amount, percentile, or
count is ever written twice. Code and tests read the block through
`scripts/reinforcement-policy.mjs`; nothing hardcodes a copy.

## The fields

- **`severityPercentileByProfile`** — the cost percentile that marks a culprit "severe" for each
  pipeline profile (`lean`, `standard`, `thorough`). A leaner profile spends fewer rounds
  chasing findings, so it sets a higher bar; a thorough profile sets a lower one and reinforces
  more readily. Each value is a percentile strictly inside `(0, 100)`.
- **`culpritRecurrenceBar`** — how many independent runs must name a culprit before it escalates.
- **`winRecurrenceBar`** — how many independent runs must ground a win before it reinforces.
- **`graduationRuns`** — how many runs a reinforced entry survives before it graduates out of the
  probationary set.
- **`minPricedKeysForPercentile`** — the smallest corpus of priced keys from which a cost
  percentile may be derived. Below it, the derived cutoff degrades to `null` (read downstream as
  the recurrence bar) rather than a `$0` fast-track — a missing cost is never coerced to zero.

## Why the win bar is strictly higher than the culprit bar

The two bars are deliberately asymmetric, and `parsePolicy` throws unless
`winRecurrenceBar > culpritRecurrenceBar`. An unnecessary culprit escalation is cheap and loud:
it surfaces, a human reverts it, and the cost is one wasted round. An under-evidenced win
reinforcement is the opposite — it fails quietly and late, teaching the loop a lesson that was
never really earned, and nothing surfaces it. So the win side demands more corroboration than
the culprit side, and an edit that flattens the asymmetry fails the gate loudly instead of
shipping a silently weakened bar.

## The machine block

These values are initial assumptions to calibrate, not measured optima. They are grounded in the
spec's § 2 Calibration against the 2026-09-10 corpus, whose five priced culprit keys set the
minimum-sample floor and the starting percentiles. Revise them here, in this block, and the
readers pick up the new numbers with no code change.

<!-- reinforcement-policy:begin -->
```json
{
  "severityPercentileByProfile": { "lean": 70, "standard": 60, "thorough": 50 },
  "culpritRecurrenceBar": 2,
  "winRecurrenceBar": 3,
  "graduationRuns": 3,
  "minPricedKeysForPercentile": 3
}
```
<!-- reinforcement-policy:end -->

## Consumers

`scripts/reinforcement-policy.mjs` parses this block and exposes it to the rest of the plugin;
`scripts/validate.mjs` reads it on every run and fails the gate if the block goes missing or any
invariant breaks. Any other reader goes through `scripts/reinforcement-policy.mjs` rather than
re-parsing the file.
