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
instructions) — so nothing on the runner's machine leaks into the result.

**To re-run a scenario:** build the sandbox per its Setup, splice the current skill text
into the prompt's marked slot, run it headless as above, and grade the response against
the Pass criteria. **To add one:** copy an existing scenario in the same component
directory (e.g. `tests/scenarios/scoping-interview/batched-questions.md`), write the
criteria first, record the red baseline before touching the skill text, then the green
run against your change — and append dated regression sections rather than overwriting
old evidence.

Scenario evidence is encouraged, best-effort — not a merge gate. Nothing in CI runs these
(there is no model credential available to GitHub Actions); they're produced locally, by
whoever is making the change, when it's practical to do so. Skipping them for a given
change is fine — verify behavior by whatever local means fits, note in the PR that formal
scenario evidence wasn't produced, and move on.

## Before opening a PR

Run both validators locally; CI runs the same checks:

```
node scripts/validate.mjs          # manifests, frontmatter, description budget, fences
node scripts/redaction-check.mjs   # no machine paths or deny-listed terms
```

**PR titles must be Conventional Commits** (`type(scope)?!: subject`). PRs are
squash-merged and the title becomes the squash subject, which drives the semver bump
(`fix:`→patch, `feat:`→minor, `!`/`BREAKING CHANGE`→major), the changelog entry, and the
release tag (`devcycle--vX.Y.Z`). A malformed title fails CI; one that slipped through
would ship no release. Scenario evidence for behavior changes is encouraged per the
harness above, but not required to merge.
