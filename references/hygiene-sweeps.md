# Hygiene sweeps

The contract every `/devcycle:maintain` hygiene sweep follows, and the dead-code and complexity
sweeps' methods.
Audit-only: maintain reads it; planning never does. What is judged is
`references/quality-criteria.md`'s; this file owns how a sweep finds, verifies and reports it.
Stacks, tool pins, invocations, classes, culprit kinds and default severities live only in
`references/hygiene-sweeps.json`, which `scripts/hygiene-sweep.mjs` reads.

## Flow

Tool or scanner → candidate → cluster → verification → typed outcome → the sweep's report section →
a stable culprit kind in the store. Tool output is evidence, never a finding. `hygiene-sweep.mjs run`
detects stacks, selects and class-gates tools, runs each pinned invocation with all output under its
`--out` directory, normalizes it, runs the built-in scanners, and writes `candidates.json` (clusters
per file or directory, ordered by blast radius: weight × (1 + churn over § Complexity's churn
window), the weight a cluster's file count or, where its candidates carry a `score`, their sum) and `coverage.json`. `run` covers every registered sweep in one pass and tags each
candidate, row and cluster with its sweep; a candidate's `clusterKey` and `anchor` (stable, no line
number) group a cluster. It persists per-file churn and each cluster's `coChange`, takes
`--hotspots <file>` (one repo-relative path per line, the hotspot scope for scanners that scope to
it), and writes `judgment-inputs.json` for the judgment-routed kinds. `hygiene-sweep.mjs finalize`
turns verdicts (`--judgments` for judgment-routed kinds) into pass-file entries, counts and one
`section-<sweep>.md` per sweep; `--depth thorough` orders a section by co-change first, and
`--history <file>` (the history inspector's table, § Report, store and ratchet) re-ranks it.

## Classes and consent

A `static` mode only reads files and always runs. An `executing` mode can run repo code (config
loaders, build scripts) and runs only on this pass's consent; without it the tool falls back to its
static mode, else its row reads `needs-consent`. The coverage run (the repo's documented test command
with coverage, its lcov passed to `finalize --lcov`) is executing too. Both answers are asked every
pass and recorded as a `sweep-consent` row (`consentExecuting`, `consentCoverage`); nothing persists
that could later run repo code without a fresh yes. A tool fetched on demand is reported as
downloaded.

## Verification

One session-tier, read-only `Explore` dispatch per pass serves every sweep. It takes only the clusters
whose `route` is `verification`, listed round-robin across sweeps and each sweep's in blast-radius
order, so every sweep shares the one budget, one batched search per cluster, within the per-dispatch budget
`references/delegation.md` sets, and writes a verdicts file
`[{ "candidateId", "outcome", "note", "severity"? }]`:

- `verified` — the note names the search or comparison that shows it.
- `suspected` — not verifiable within budget, or a known-noisy class. A candidate given no verdict
  becomes `suspected (not verified: budget)`: ranked below verified, never dropped.
- `cleared` — a false positive, the note its reason: dynamic name, framework-owned token, routed or
  lazily loaded, host binding, decorator alias, public entry point. Counted by reason, never a finding.
  A complexity candidate in a generated file, data table or exhaustive enum switch, which the
  criterion does not count, is cleared `cohesive: generated`, `table` or `switch`.

`severity` raises the kind's default with a reason, never lowers it. A verdict may carry `raiseReason`;
a raise never passes the kind's `maxSeverity` unless that reason is one of the kind's `raiseBeyondCapWhen`. A noisy candidate (knip in static
mode, any tool without installed dependencies) never ranks as verified.

## Report, store and ratchet

One finding per cluster, its `canonicalLocation` the cluster anchor with no line, so the store's
persistence works unchanged. The section orders clusters by blast radius; the document's severity-first rank is unchanged. A candidate may carry
`evidence` lines, each rendered beneath it as a sub-bullet. A `watch`-route kind is never verified
and never stored: its candidates are listed under `### Watch` by score, counted as suspected, and raise
no finding. At `--depth thorough`, `--history <file>` re-ranks the clusters of a kind the registry marks
`history` by score × (1 + commits), and raises each such candidate with fix commits one severity
level, held at the kind's cap unless the kind lets `fix-commits` through; the raised severity
persists because the store keeps the higher severity. The file is `{ "files": [{ "file", "commits",
"fixCommits" }] }` with non-negative integer counts, the history inspector's fenced table saved
verbatim; `finalize` exits 1 on any other shape. `finalize --run <id>` appends one set of `sweep-count` rows per
sweep, one row per kind (`sweep`, `category`, `verified`, `suspected`, `cleared`, `complete`), to the
pass's run record, once.
Trending compares against the latest counted pass that started strictly earlier on this machine (run
records are per machine), says so when there is none, and says "not comparable" for a kind either pass
did not sweep completely. A sweep kind's stored record may resolve only when every source behind it
ran in full this pass: `coverage.json`'s `fullKinds`, passed to
`maintenance-findings.mjs apply-pass --sweep-coverage`; a kind no source produces (`sourcedKinds`
omits it) keeps the lens kinds' resolution rules.

## Coverage statement

One statement per sweep. Per kind: tool-checked, heuristic-only or not covered; every failed, unavailable, unconsented or
partial source (a capped or size-skipped scan, a solution tsconfig's unchecked projects) and every
degraded git source by name, each keeping its kind out of `fullKinds`, each blame-using scanner
reporting its own sweep's blame budget; "dependencies not installed" without `node_modules`; "no
<noun> tool for this stack; heuristic scan only" for a stack where none of that sweep's tools
applies and the sweep has a built-in scanner, `<noun>` the sweep's registry noun, and "no <noun>
tool for this stack; not measured" where it has none; each tool's per-sweep notes (a config file not
read statically, a metric a fallback tool cannot measure, files excluded before measurement by
category, lizard's skipped duplicate files); and the registry's `notCovered` list. The
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

## Complexity

lizard is the primary tool for every code stack it covers (JS/TS, Python, Go, Rust, .NET), run from
its pinned version; radon is the Python fallback (`fallbackFor` lizard), superseded while lizard
ran and used only when it did not. radon measures cyclomatic complexity alone, and its coverage
note says the other metrics were not measured. A stack with neither tool reads `not measured`.

Per function the rows carry cyclomatic complexity (`ccn`), cognitive complexity, nesting depth,
parameter count and `nloc`; per file, its line count. A file with any function over a threshold, or
over its line threshold, is one candidate. Its score is the sum of the over-threshold functions'
cognitive complexity (else `ccn`, else 1) plus the lines above the file
threshold, and its evidence lines name each function with the metrics over and their sources, then
the file's churn. Candidates rank by complexity × churn: score × (1 + commits in the churn window), which is
the cluster's blast radius.

Hot versus watch is decided at `run`: a file with at least `config.hotCommits` commits in the churn
window is a `complexity-hotspot`, routed to verification; any other is a `complexity-watch`, complex
but stable, routed to `watch`. A repo-root `.devcycle-hygiene.json` overrides `hotCommits` as it does
`staleTodoDays`. The one churn window (`CHURN_WINDOW` in `scripts/hygiene-sweep.mjs`) is the last
500 commits within the last 6 months; the history inspector's table uses the same window.

Thresholds come from the repo's own root linter config, read statically: ESLint rules, ruff, flake8
and pylint settings, golangci-lint's gocyclo, gocognit, nestif and funlen. Where a repo sets none,
the registry's per-stack defaults apply, each carrying the linter rule and URL it comes from. A
config in a subdirectory, and a setting that is off or not statically readable, keep the default and
say so in the coverage notes. Files `scripts/generated-paths.mjs` classifies as lockfile, generated,
vendored or test-fixture are excluded before scoring and counted by category in the coverage notes.
lizard skips a byte-identical copy of a file it read, and a file over the 1 MiB read cap gets only its
header read and no length; the coverage notes state both.

Verification reads the file: `verified` if the complexity is real, else a `cohesive` clear.
