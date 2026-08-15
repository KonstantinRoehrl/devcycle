# Contributing

Most of devcycle is markdown instructions rather than code, so the suite that guards it is
structural: it asserts that the instructions point at files that exist, agree with each
other, and keep the invariants a run depends on. Everything under `tests/` is deterministic
Node — no model call, no API key — and CI runs all of it on every PR.

## The golden-path fixture

`tests/unit/golden-path.test.mjs`, with its data in `tests/fixtures/golden-path/`, walks a
synthetic `.devcycle/` tree through every stage transition and asserts the pipeline's wiring
holds: the stage enum in `commands/cycle.md` is the single source of truth and
`commands/continue.md` handles every stage in it; every
`${CLAUDE_PLUGIN_ROOT}/playbooks/…` path named anywhere in the surface resolves to a file
that ships; the state file and ledger fixtures parse at every stage; each bounded loop
declares a cap; a `committed` ledger event carries the green gate's outcome; and no workflow
pushes the release branch directly.

**What it does not do:** it does not exercise model behaviour. Nothing in it proves a stage
produces good output, that an interview actually batches its questions, or that a stop gate
is honoured at runtime — only that the text and the artifacts that encode those rules are
present and consistent. The fixture's own header says so; keep that boundary honest rather
than writing a test whose name implies a behavioural claim it cannot make.

Assertions that cut across the surface — commands, playbooks, references, agents, workflows —
belong in this file. That is deliberate: every other suite under `tests/unit/` is scoped to
one script, and a parallel golden-path suite would just split the same subject in two. When
you add a rule to a playbook that a file can be read to confirm, add the assertion here in
the same change; a rule with no mechanism is the thing this fixture exists to prevent.

Behaviour that genuinely needs a model to judge has no runner in this repo, by choice: there
is no model credential available to GitHub Actions, and a check that can only be run by hand
gets skipped and then ignored. Verify that class of change locally by whatever means fits and
say in the PR how you did; the prose scenario harness that used to hold it was retired
2026-08-06 (see `docs/DECISIONS.md`).

## Deterministic tests for the scripts and workflows

The Node code under `scripts/` and `workflows/` has ordinary unit tests in `tests/unit/`, one
suite per script. The two workflow engines are run end to end with fake `claude`/`codex`
executables placed first on `PATH`, so a full pipeline is exercised without a model call. If
you change `review-panel.js`, `mechanical-sweep.js`, or any `scripts/*.mjs`, extend that
script's suite with the behavior you changed.

## One owner per concept

A rule lives in exactly one file, and every other file that needs it names that file by path
rather than restating it. For anything cross-cutting that owner is a `references/*.md` file;
`references/quality-criteria.md` § Universal criteria states the criterion reviews measure
against, as "duplication vs. reuse". Adding a pointer next to a retained copy is worse than
either alone — the reader now has to work out which copy is authoritative — so a change that
moves a rule deletes the prose it moved. `scripts/duplication-check.mjs` is the mechanized
floor here, not the whole rule: it catches near-identical prose, and a second pass over content
words catches a fair share of the same rule restated in different words, but neither pass
judges whether the surviving copy is the right owner.

## Before opening a PR

Run the validators and the unit suite locally. CI (`.github/workflows/validate.yml`)
runs everything except `doctor.mjs` — that one is local-only, so it's the one a reviewer won't
catch for you:

```
node scripts/validate.mjs             # manifests, command frontmatter, description budget, routing table, fences — CI
node scripts/redaction-check.mjs      # no machine paths, session ids, or deny-listed terms — CI
node scripts/duplication-check.mjs    # duplicated prose across commands/playbooks/agents/references, and within a file — CI
node --test tests/unit/*.test.mjs     # the whole unit suite, golden path included (stubbed CLIs, keyless) — CI
gitleaks git --no-banner --redact     # credentials, over the full history — CI
node scripts/doctor.mjs               # token/context profile; --depth is the context gate's probe — local only
```

Pass the test files as a glob, exactly as above and as CI does: a bare `tests/unit/` directory
argument fails spuriously.

The two scanners divide the work and neither subsumes the other. gitleaks owns credentials and
tokens: it is rule-maintained, and it reads **history**, so a secret that was committed and
removed one commit later still fails the build. `redaction-check.mjs` owns the privacy classes
that are specific to how devcycle runs and that no generic scanner knows about — absolute
home-directory paths, session ids, and the escaped project-directory form that binds a
transcript path to one person's machine. It reads the current tree only. Verbatim transcript
*excerpts* are detected by neither; that class is held by review, and by keeping
excerpt-carrying artifacts out of the tracked tree in the first place.

The commands above use the repo-relative form (`node scripts/<engine>.mjs`), correct for
running by hand against this checkout. An engine invocation written into a command, playbook,
reference or agent instead uses `${CLAUDE_PLUGIN_ROOT}/scripts/<engine>.mjs`, because that text
runs from the installed plugin, not this repo.

`scripts/doctor.mjs` prices what it measures against `scripts/pricing.mjs`, the data module
that holds per-model dollar rates and context windows with no CLI of its own — update that
file when prices change.

Writing a new `scripts/*.mjs`? Reuse `doctor.mjs`'s exported helpers
(`findTranscriptFiles`, `owningSession`, `readRecords`, `inWindow`) for corpus enumeration,
project-path escaping, and missing/unreadable-directory handling rather than
reimplementing them.

`plugin.json`'s `userConfig` descriptions are a third hand-kept copy of the config knobs,
alongside README's config table and `references/config.md`'s own explanation — update all
three by hand together when one changes; `validate.mjs` checks only that the key exists, never
that the description text is current.

**PR titles must be Conventional Commits** (`type(scope)?!: subject`), and so must every
commit subject on the PR — CI checks both. PRs are
squash-merged and the title becomes the squash subject, which drives the semver bump
(`fix:`→patch, `feat:`→minor, `!`/`BREAKING CHANGE`→major), the changelog entry, and the
release tag (`devcycle--vX.Y.Z`). Reserve `feat:` for substantial user-facing
improvements; routine work — engine swaps, doc edits, refactors, small fixes — takes
`refactor:`/`fix:`/`docs:`/`chore:` so the automated bump reflects real impact. A
malformed title fails CI; one that slipped through would ship no release. Evidence for
behavior changes goes in the PR description; the structural checks above are the only
merge gate.

## What belongs in `docs/`

`marketplace.json` sets the plugin `source` to `./`, so the repository tree *is* the shipped
payload — there is no build step that could filter anything out. Every file committed here is
downloaded by every user who installs the plugin, which makes `docs/` a budget, not a
scratchpad.

Commit a doc only if a future implementer needs it to make a correct change: the decision log,
empirically verified platform behavior, the memos explaining why a devcycle stage diverges from
its superpowers upstream, open defects. Keep run reports, benchmarks, dry runs, on-device checklists and
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
After every release, merge `main` back into `dev`. The `Back-merge` workflow opens that PR
automatically after every release and fails weekly while `dev` is behind `main`, so a skipped or
forgotten merge surfaces before the next release rather than as conflicts in its PR. Review and
merge it; the automation opens it but never merges it.

`Prepare release` opens its own PR, which requires **Settings → Actions → General → Allow GitHub
Actions to create and approve pull requests** to be enabled. Without it the workflow fails after
pushing the bump, with that instruction in its log; re-running it once the setting is on opens the
missing PR without bumping again.

**Nothing pushes to `main`.** The version bump arrives inside the release PR, so `main` only
ever changes through a checked pull request — which is what lets a ruleset require exactly
that. Never hand-edit the version.

Two consequences of squash-merging worth remembering. A `CHANGELOG.md` fix made on `dev` does
not clean up `main`: the individual commits stay out of the merge base, so those entries are
absent from `main` and need their own PR against it. And no ref-range on `dev` can tell you
what is unreleased — `main..dev` reports long-shipped work as new — which is why the release
notes come from the PR title rather than from a commit range.

### Watching a fix past release: the maintainer-cohort check

`doctor.mjs` tells one user whether a `resolved-in:` fix held for *their* own runs, but no local
journal sees whether it held fleet-wide. After a `resolved-in:` release ships, watch
`gh issue list --label culprit:<slug> --label from-doctor` for that culprit-id: if new issues
keep arriving post-release, the fix did not hold across the userbase even though it may show
`held` in an individual doctor report.

This is a maintainer habit, not a script. Automating it would need issue-tracker credentials no
local run has, and would be one more surface to keep honest for a signal only a human should
weigh.
