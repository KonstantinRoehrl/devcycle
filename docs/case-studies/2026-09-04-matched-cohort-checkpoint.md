# Matched-cohort payoff — checkpoint, 2026-09-04

**Status: not yet publishable.** This directory is where devcycle's own before/after payoff
case study (`YYYY-MM-DD-matched-cohort.md`) will land once the data supports it. As of this
date it does not, so this is a checkpoint, not a case study — a dated record of how close the
corpus is, so the question is not re-investigated from scratch next time.

The gate is deliberate: `scripts/doctor.mjs` refuses to claim a trend until a matched cohort
(same step × profile × request-kind × workload band) holds **n ≥ 3 in each of two adjacent
in-band versions**. Publishing a payoff number off an underpowered cohort — or off sessions
doctor itself flags as a collection gap — would undermine exactly the credibility the case
study is meant to build.

## What doctor said (run 2026-09-04, `node scripts/doctor.mjs`, full devcycle-tagged corpus)

`## At a glance` — the matched-cohort table came back empty:

> | Step | matchKey | n | conf | workload-adj cost Δ% (derived) | main-turn Δ | sub-turn Δ | depth Δ | conformance Δ |
> | --- | --- | --- | --- | --- | --- | --- | --- | --- |
>
> _No rows: no matched cohort spans two adjacent in-band versions yet._

And, from the Cost-by-version section:

> Direction of travel: insufficient data (no matched cohort spans two versions with n>=3)

`## Read this first` carried a collection-gap warning:

> ⚠ COLLECTION GAP — 9 committing cycle(s) recorded no workload, so they are absent from
> ## Workload (observed) and every matched-cohort comparison below. This is under-collection,
> not absence of work (see ### Compliance → missing-workload). Cycles on plugin versions
> predating the commit-sensor hook legitimately carry no band and are not counted here.

`### Compliance` broke those 9 down by request kind:

> - CANDIDATE: missing-workload commits=4 requestKind=bug sessions=3 versions=[0.17.3..0.18.0]
> - CANDIDATE: missing-workload commits=6 requestKind=refactor sessions=3 versions=[0.18.2..0.18.2]
> - CANDIDATE: missing-workload commits=10 requestKind=feature sessions=3 versions=[0.18.1..0.18.2]

## Current cohort sizes

`## Workload (observed)` does carry records — **27 runs across 0.15.0 → 0.18.2** now carry a
workload record, where every version before 0.15.0 carries none. Counted off that table, per
version:

| Version | Runs with a workload record (observed) |
| --- | --- |
| 0.15.0 | 5 |
| 0.16.0 | 4 |
| 0.16.1 | 2 |
| 0.17.0 | 1 |
| 0.17.1 | 1 |
| 0.17.2 | 3 |
| 0.17.3 | 4 |
| 0.18.0 | 3 |
| 0.18.1 | 3 |
| 0.18.2 | 1 |

The matched-cohort table is empty despite these 27 records because the bar is per *matched*
cohort, not per version: once each version's runs are split by profile × request-kind × band,
no single key reaches n ≥ 3 **and** lines up against the same key in an adjacent version. The
records are spread thin across kinds and bands, and the two freshest versions (0.18.1, 0.18.2)
— where continuous collection should now be strongest — are exactly where the 9-cycle gap
bites hardest (10 feature + 6 refactor commits at 0.18.1–0.18.2 recorded no workload at all).

## Plain-language takeaway

The structural fix from #139 is working — the commit-sensor hook is populating workload
records where older versions had none — but the corpus is not yet powered for a published
before/after number. Two things still have to happen, and neither can be shortcut:

1. **Close the remaining collection gap on the newest versions.** The 16 feature/refactor
   commits at 0.18.1–0.18.2 that recorded no workload are the freshest, most relevant data,
   and they are missing. Until the commit-sensor hook covers those cycles, the newest matched
   cohorts start underweight.
2. **Accumulate enough same-shaped cycles per adjacent-version pair.** Even with the gap
   closed, a matched cohort needs ≥3 runs of the same (profile, kind, band) in each of two
   adjacent in-band versions. Today the records fragment below that threshold.

## Re-check procedure

Re-run `node scripts/doctor.mjs` (or `/devcycle:doctor`) and read `## At a glance`. The moment
a row appears there — a matched cohort with n ≥ 3 across two adjacent in-band versions — this
checkpoint is superseded: write `docs/case-studies/YYYY-MM-DD-matched-cohort.md` quoting that
row's real numbers (workload-adjusted cost Δ, review rounds / blocking findings / conformance
failures per cohort), run `scripts/redaction-check.mjs` on it, and cite it from the README's
value-proposition section. Until then, the README makes no payoff claim it cannot back.
