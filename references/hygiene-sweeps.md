# Hygiene sweeps

The contract every `/devcycle:maintain` hygiene sweep follows, and the dead-code sweep's method.
Audit-only: maintain reads it; planning never does. What is judged is
`references/quality-criteria.md`'s; this file owns how a sweep finds, verifies and reports it.
Stacks, tool pins, invocations, classes, culprit kinds and default severities live only in
`references/hygiene-sweeps.json`, which `scripts/hygiene-sweep.mjs` reads.

## Flow

Tool or scanner → candidate → cluster → verification → typed outcome → the sweep's report section →
a stable culprit kind in the store. Tool output is evidence, never a finding. `hygiene-sweep.mjs run`
detects stacks, selects and class-gates tools, runs each pinned invocation with all output under its
`--out` directory, normalizes it, runs the built-in scanners, and writes `candidates.json` (clusters
per file or directory, ordered by blast radius: files × (1 + churn over the smaller of 500 commits
or 6 months)) and `coverage.json`. `hygiene-sweep.mjs finalize` turns verdicts into pass-file
entries, counts and the section.

## Classes and consent

A `static` mode only reads files and always runs. An `executing` mode can run repo code (config
loaders, build scripts) and runs only on this pass's consent; without it the tool falls back to its
static mode, else its row reads `needs-consent`. The coverage run (the repo's documented test command
with coverage, its lcov passed to `finalize --lcov`) is executing too. Both answers are asked every
pass and recorded as a `sweep-consent` row (`consentExecuting`, `consentCoverage`); nothing persists
that could later run repo code without a fresh yes. A tool fetched on demand is reported as
downloaded.

## Verification

One session-tier, read-only `Explore` dispatch per pass serves every sweep. It takes the clusters in
`candidates.json` order, one batched search per cluster, within the per-dispatch budget
`references/delegation.md` sets, and writes a verdicts file
`[{ "candidateId", "outcome", "note", "severity"? }]`:

- `verified` — the note names the search or comparison that shows it.
- `suspected` — not verifiable within budget, or a known-noisy class. A candidate given no verdict
  becomes `suspected (not verified: budget)`: ranked below verified, never dropped.
- `cleared` — a false positive, the note its reason: dynamic name, framework-owned token, routed or
  lazily loaded, host binding, decorator alias, public entry point. Counted by reason, never a finding.

`severity` raises the kind's default with a reason, never lowers it. A noisy candidate (knip in static
mode, any tool without installed dependencies) never ranks as verified.

## Report, store and ratchet

One finding per cluster, its `canonicalLocation` the cluster anchor with no line, so the store's
persistence works unchanged. The section orders clusters by blast radius; the document's
severity-first rank is unchanged. `finalize --run <id>` appends one `sweep-count` row per kind
(`sweep`, `category`, `verified`, `suspected`, `cleared`, `complete`) to the pass's run record, once.
Trending compares against the latest counted pass that started strictly earlier on this machine (run
records are per machine), says so when there is none, and says "not comparable" for a kind either pass
did not sweep completely. A sweep kind's stored record may resolve only when every source behind it
ran in full this pass: `coverage.json`'s `fullKinds`, passed to
`maintenance-findings.mjs apply-pass --sweep-coverage`; a kind no source produces (`sourcedKinds`
omits it) keeps the lens kinds' resolution rules.

## Coverage statement

Per kind: tool-checked, heuristic-only or not covered; every failed, unavailable, unconsented or
partial source (a capped or size-skipped scan, a solution tsconfig's unchecked projects) and every
degraded git source by name, each keeping its kind out of `fullKinds`; "dependencies not installed" without `node_modules`; "no dead-code tool for this stack;
heuristic scan only" for a stack no registry tool names; and the registry's `notCovered` list. The
sweep runs in every pass and at every depth (`lean`, `standard`, `thorough`), whatever the
`<concern>`; the statement says when it was partial.

## Safety

Read-only: output only in scratch, no `--fix`, no formatter in write mode, tsc's build info and
dotnet's home directories pointed at scratch, never `cargo machete --with-metadata`, every tool
spawned from an argv array without a shell. The registry's validation pins the forbidden flags.

## Dead code

knip runs from a scratch config with every plugin off unless executing consent was given; its unused
files and dependencies are then noisy. tsc is the repo's own when installed, else the pin; on a solution-style tsconfig it checks each
referenced project. Other
stacks' tools use the raw adapter: their output reaches verification verbatim. Built-in scanners cover
commented-out code, stale TODOs (older than `staleTodoDays`, which a repo-root `.devcycle-hygiene.json`
`{ "staleTodoDays": <n> }` overrides), unused environment variables, CSS custom properties, classes
and keyframes, Angular inputs and outputs, and static assets.
