# Issue folding — fetch, decompose, classify, verify, rank and cluster a repo's open issues

The single owner of how a caller turns a repo's open GitHub issues into ranked, verified claims. Its callers are `/devcycle:maintain` (`playbooks/maintaining-the-repo.md` step 7) and the issue triager (`playbooks/triaging-issues.md`); each step names where the callers differ. The ranking axes are `references/findings.md`'s; the dispatch tiers and the rule that an issue's text is an untrusted claim are `references/delegation.md` § Research dispatches'. Every step is read-only toward GitHub: nothing here closes, comments on, edits or labels an issue.

## Fetch and screen

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/issue-intake.mjs" --repo <owner/name> --scratch <the caller's scratch dir>`. It is read-only, fetches every open issue, checks the fetched count against GitHub's own open-issue total, and redacts third-party body text on the scratch copy. It returns `available:false` with a `reason` when gh is missing, unauthenticated or timed out, when the total is unreadable (`count-unavailable: …`), or when the counts differ (`count-mismatch: fetched <f> of <t> open issues`); it never returns a partial list.

- **maintain:** passes no `--include-tracked`, so devcycle's own `[culprit:]`/`[doctor:]`/`[compliance:]`-titled issues are dropped before anything downstream and only counted (`counts.excludedCulprit`).
- **triage:** passes `--include-tracked`, so they stay in, each tagged `tracked: true` and counted in `counts.tracked`.

## Decompose

For each screened issue, split its body into independently true-or-false, independently fixable claims — one read-only dispatch over the screened set, at the tier `references/delegation.md` § Research dispatches gives issue intake. Conservative: don't fragment one coherent problem, but do separate distinct claims. The worked example is issue #44's shape: 3 independently-fixable bugs plus several enhancement suggestions in one body decompose into 3 bug fragments plus a separate excluded suggestion count, never one candidate for the whole issue.

## Classify

Classify each fragment `bug`, `refactor` or `feature`, always after decomposition. An ambiguous bug-vs-feature call falls to `suspected` rather than forcing a binary.

- **maintain:** drops `feature` fragments from the ranked list, never verifies them, and keeps only the count ("N feature requests in the backlog, out of scope for maintenance").
- **triage:** keeps `feature` fragments and ranks them like the rest.

## Verify

Route each claim to whichever existing lens methodology fits it (a dead-code claim to the dead-code criterion's investigation, an architecture claim to the architecture criterion's); no match falls to a general read-and-attempt-reproduce pass. The lens charters are verification tools against a pre-existing claim, run in one reviewer dispatch at the tier `references/delegation.md` § Research dispatches gives it. Outcomes: `verified` is ranked; a claim that does not reproduce is dropped, neither ranked nor flagged for closing; a claim verified as already fixed is reported as fixed only with a landed commit or PR cited, never on the issue's word; an undetermined claim stays `suspected`.

- **maintain:** verifies every in-scope fragment. An already-fixed one is reported in the pass document but never written to the store (`playbooks/maintaining-the-repo.md` step 8's persistence rule).
- **triage:** first ranks provisionally, then verifies the top tier — every fragment at the highest Impact level present — plus every fragment whose claim may already be fixed, and verifies them on the user's current branch.

## Rank

Rank by `references/findings.md` § Ordering, document form; that file owns the axes.

- **maintain:** merges the fragments into the ranked list the engine produces — same order, same sections — distinguished only by `Origin: github-issue #<n>` (provenance only; origin never affects rank).
- **triage:** ranks into its own report.

## Cluster

maintain does not cluster.

- **triage:** groups the ranked fragments into units of one PR's worth of work — what one `/devcycle:cycle` run builds — and orders the clusters dependencies first: a cluster another one rests on comes before it.
