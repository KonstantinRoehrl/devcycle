# Contributing

devcycle's components are markdown instructions, so the test suite tests *behavior*, not
code: scenario files that replay a prompt against a real model and grade the response.

## The scenario harness

`tests/scenarios/<component>/<scenario>.md` — one structured markdown file per scenario,
each with:

- **Setup** — the sandbox repo to build (throwaway, in a temp directory) and how the skill
  text is spliced into the prompt.
- **Subagent prompt** — the exact prompt, with a marked slot for the skill/command text
  under test.
- **Pass criteria** — numbered, individually checkable assertions about the response's
  shape and content.
- **Baseline (red)** and **Result (green)** — dated evidence sections: the red run shows
  the failure without the guidance text (proving the criteria catch real behavior), the
  green run shows the committed text passing. Changes ship with both.

Runs are fresh headless sessions — `claude -p`, an isolated config directory containing
nothing but credentials (fresh `CLAUDE_CONFIG_DIR`; no installed plugins, no global user
instructions) — so nothing on the runner's machine leaks into the result. **Never populate
that config directory with a live production credential** pulled from wherever your own
tooling normally keeps one. Provision a test-only credential for scenario runs, or skip
the run if none is available; either way, delete any scratch credential files the run
leaves behind before you're done.

**To re-run a scenario:** build the sandbox per its Setup, splice the current skill text
into the prompt's marked slot, run it headless as above, and grade the response against
the Pass criteria. **To add one:** copy an existing scenario in the same component
directory (e.g. `tests/scenarios/scoping-interview/batched-questions.md`), write the
criteria first, record the red baseline before touching the skill text, then the green
run against your change — and append dated regression sections rather than overwriting
old evidence.

A few authoring pitfalls: copying an existing scenario carries over its Setup
tool-permission clause verbatim — re-derive it for the new scenario, since a sandbox that
forbids the reads its own Pass criteria need is grading a broken sandbox, not the skill
under test. When spliced skill/command text points onward to another plugin file and a
Pass criterion depends on it, the sandbox must place that file too — grep sibling
scenarios for the same dangling reference before calling the fix done. When a scenario
run can mutate the sandbox, snapshot the clean state after Setup and before the red run,
and restore it before the green run. Verify any citations against the working tree or
`git show <ref>:path`, never `${CLAUDE_PLUGIN_ROOT}` — the install cache is version-keyed
and lags the branch, so an accurate citation against it can still look fabricated.

Scenario evidence is encouraged, best-effort — not a merge gate. Nothing in CI runs these
(there is no model credential available to GitHub Actions); they're produced locally, by
whoever is making the change, when it's practical to do so. Skipping them for a given
change is fine — verify behavior by whatever local means fits, note in the PR that formal
scenario evidence wasn't produced, and move on.

## Deterministic tests for the workflow scripts

The two Node scripts under `workflows/` are ordinary deterministic code, and unlike the
scenario harness they have real automated tests: `tests/unit/` runs them end to end with
fake `claude`/`codex` executables placed first on `PATH` — no model call, no API key —
so CI runs them on every PR. If you change `review-panel.js` or `mechanical-sweep.js`,
extend these tests with the behavior you changed.

## Before opening a PR

Run the validators and the workflow-script tests locally. CI (`.github/workflows/validate.yml`)
runs the first four; `doctor.mjs` and the gitleaks scan are local-only — there's no CI step for
either, so they're the two a reviewer won't catch for you:

```
node scripts/validate.mjs             # manifests, frontmatter, description budget, fences — CI
node scripts/redaction-check.mjs      # no machine paths or deny-listed terms — CI
node scripts/duplication-check.mjs    # cross-skill prose duplication — CI
node --test tests/unit/*.test.mjs     # workflow-script tests (stubbed CLIs, keyless) — CI
node scripts/doctor.mjs               # token/context profile; --depth is the context gate's probe — local only
git diff main...HEAD | gitleaks stdin --redact --no-banner  # secret scan over the branch; local only, skip if gitleaks isn't installed
```

The commands above use the repo-relative form (`node scripts/<engine>.mjs`), correct for
running by hand against this checkout. An engine invocation written into skill or command
markdown instead uses `${CLAUDE_PLUGIN_ROOT}/scripts/<engine>.mjs`, because that text runs
from the installed plugin, not this repo.

`scripts/doctor.mjs` prices what it measures against `scripts/pricing.mjs`, the data module
that holds per-model dollar rates and context windows with no CLI of its own — update that
file when prices change.

Writing a new `scripts/*.mjs`? Reuse `doctor.mjs`'s exported helpers
(`findTranscriptFiles`, `owningSession`, `readRecords`, `inWindow`) for corpus enumeration,
project-path escaping, and missing/unreadable-directory handling rather than
reimplementing them.

`plugin.json`'s `userConfig` descriptions are a third hand-kept copy of the config knobs,
alongside README's config table and the owning skill's own explanation — update all three
by hand together when one changes; `validate.mjs` checks only that the key exists, never
that the description text is current.

**PR titles must be Conventional Commits** (`type(scope)?!: subject`). PRs are
squash-merged and the title becomes the squash subject, which drives the semver bump
(`fix:`→patch, `feat:`→minor, `!`/`BREAKING CHANGE`→major), the changelog entry, and the
release tag (`devcycle--vX.Y.Z`). Reserve `feat:` for substantial user-facing
improvements; routine work — engine swaps, doc edits, refactors, small fixes — takes
`refactor:`/`fix:`/`docs:`/`chore:` so the automated bump reflects real impact. A
malformed title fails CI; one that slipped through would ship no release. Scenario
evidence for behavior changes is encouraged per the harness above, but not required to
merge.

## What belongs in `docs/`

`marketplace.json` sets the plugin `source` to `./`, so the repository tree *is* the shipped
payload — there is no build step that could filter anything out. Every file committed here is
downloaded by every user who installs the plugin, which makes `docs/` a budget, not a
scratchpad.

Commit a doc only if a future implementer needs it to make a correct change: the decision log,
empirically verified platform behavior, the memos explaining why a skill diverges from its
upstream, open defects. Keep run reports, benchmarks, dry runs, on-device checklists and
results, plans, and specs out of the repository — they are records of one run on one machine,
they date immediately, and nobody installing the plugin has a use for them. `.devcycle/` is
gitignored and is where those belong.

`docs/known-issues.md` is the one place open defects are recorded. Fixing a defect means
deleting its entry in the same commit.

## Releasing

Run the **Prepare release** workflow from `dev`, giving it the release PR title. The title is
the whole input: it must be a Conventional Commit, its type sets the bump (`feat` → minor,
`fix`/`perf` → patch, `!` or a `BREAKING CHANGE:` trailer → major), and it becomes both the
`CHANGELOG.md` entry and — because the PR is squash-merged — `main`'s commit subject. A title
outside the convention is refused rather than treated as a patch, since it would ship no bump.

Prepare commits `chore(release): prepare vX.Y.Z` to `dev` and opens the `main` ← `dev` PR.
Squash-merge it **with that same title** once checks pass. `Release` then tags
`devcycle--vX.Y.Z` and publishes the GitHub release from that version's CHANGELOG section.
After every release, merge `main` back into `dev`.

**Nothing pushes to `main`.** The version bump arrives inside the release PR, so `main` only
ever changes through a checked pull request — which is what lets a ruleset require exactly
that. Never hand-edit the version.

Two consequences of squash-merging worth remembering. A `CHANGELOG.md` fix made on `dev` does
not clean up `main`: the individual commits stay out of the merge base, so those entries are
absent from `main` and need their own PR against it. And no ref-range on `dev` can tell you
what is unreleased — `main..dev` reports long-shipped work as new — which is why the release
notes come from the PR title rather than from a commit range.
