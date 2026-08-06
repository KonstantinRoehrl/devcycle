# Onboarding a repo

## Announce

"I'm using the onboarding-a-repo skill to scaffold tier-2 setup for this repo."

## Idempotency check, first

Before detecting anything, check for an existing scaffold: a root `CLAUDE.md` with a
`## devcycle onboarding` section, or per-package `CLAUDE.md` stubs already naming a
detected stack. If found, **stop and ask** (`AskUserQuestion`) whether to update/merge
the existing scaffold against freshly detected commands, or leave it untouched — never
overwrite silently. A repo with a `CLAUDE.md` that has no `## devcycle onboarding`
section is not yet onboarded; proceed to detection and append a new section to it rather
than overwriting the file.

## Detection — read, never guessed

Read, in this order, whichever exist:

1. `package.json` `scripts` block — the `test`/`build`/`lint` keys, if present.
2. `pyproject.toml` (`[tool.pytest.ini_options]`, `[project.scripts]`) or `setup.cfg`.
3. `Cargo.toml` (`[package]` plus `cargo test`/`cargo build` as the stack's own
   convention).
4. `go.mod` (`go test ./...`/`go build ./...` as Go's own convention).
5. `Makefile` targets — any target literally named `test`, `build`, or `lint`.
6. Any CI workflow file (`.github/workflows/*.yml`, `.gitlab-ci.yml`, etc.) — the
   commands it actually invokes. **A CI config that already runs a command is stronger
   evidence than a guessed convention**: prefer it over a manifest script of the same
   name if the two ever disagree (e.g. `package.json` has a `test` script but CI invokes
   a different one — CI is what actually gates merges).

**Monorepo detection.** More than one manifest file (from the list above) found below
root, each in its own directory → treat as a monorepo: scaffold each package directory
its own `CLAUDE.md` stub, in addition to the root file.

**Package manager detection.** Alongside the manifest, note the lockfile present
(`package-lock.json`/`yarn.lock`/`pnpm-lock.yaml`, `poetry.lock`/`uv.lock`,
`Cargo.lock`, `go.sum`) to name the exact invocation (`npm test` vs `pnpm test`).

## Output

0. **Branch check, before any write.** Follow `${CLAUDE_PLUGIN_ROOT}/references/branch.md`'s
   Committing rule: if the checkout is on the default branch or an integration branch,
   create a topic branch first. This skill is standalone and owns no
   `.devcycle/state.md`, so skip that rule's `branch:`-line write — just create the
   branch and write everything below on it.

1. **Root `CLAUDE.md`.** If none exists, create one containing only a
   `## devcycle onboarding` section (see shape below). If one exists, append a
   `## devcycle onboarding` section to it — never a blind overwrite of existing
   content above or below that section.

   The section names the detected stack, the test/build/lint commands (exact,
   copy-pasteable), and nothing else — no restated devcycle process prose, per the
   migration rule DESIGN.md §12 states ("when a skill ships, the corresponding
   global-CLAUDE.md section is deleted in the same step"). Shape:

   ```markdown
   ## devcycle onboarding

   Stack: <detected, e.g. "Node.js (npm), TypeScript">
   Test: `<exact command>`
   Build: `<exact command>`
   Lint: `<exact command, or "none detected">`
   ```

2. **Per-package `CLAUDE.md` stubs**, one per detected package directory in a monorepo,
   each scoped to its own directory using the same shape as the root section, naming
   only that package's own commands.

3. **A proposed permission allowlist** for Claude Code's `settings.json`
   `permissions.allow` array, covering the detected safe commands (the exact test/
   build/lint invocations found above) plus `git status`, `git diff`, `git log` —
   **presented in the response for the user to review, never written to
   `settings.json` until the user confirms it.**

4. **The verification command**, recorded in the scaffolded `CLAUDE.md` itself (the
   `Test:` line above) — sufficient for `${CLAUDE_PLUGIN_ROOT}/playbooks/executing-waves.md`' green gate and this
   repo's own CI to find; no separate state file.

5. **Commit the scaffold**, scoped per
   `${CLAUDE_PLUGIN_ROOT}/references/commit-convention.md`'s "Scoping the commit" — read
   it there and follow it: the scaffold (root and any per-package `CLAUDE.md`) is the only
   thing this run authored. If `git check-ignore` covers a written path, write it and skip
   the commit for that file; the repo's own ignore rules decide.

## Entry point

`/devcycle:onboard`, standalone: no `.devcycle/state.md` touch, no handoff block — the
same shape as `devcycle:doctor`/`devcycle:audit`.

Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.
