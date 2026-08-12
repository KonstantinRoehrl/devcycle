# Onboarding a repo

## Announce

"I'm using the onboarding-a-repo playbook to scaffold tier-2 setup for this repo."

## Idempotency check, first

Before detecting anything, check for an existing scaffold: a root `CLAUDE.md` with a
`## devcycle onboarding` section, or per-package `CLAUDE.md` stubs already naming a detected
stack. If found, **stop and ask** (`AskUserQuestion`) whether to update the scaffold against
freshly detected commands or leave it untouched — never overwrite silently. An Other answer to it appends `user-correction-at-gate`, the rule `${CLAUDE_PLUGIN_ROOT}/references/ledger.md` owns. A `CLAUDE.md`
without that section is not yet onboarded: proceed to detection and append the section rather
than overwriting the file.

## Detection — read, never guessed

Read, in this order, whichever exist:

1. `package.json` `scripts` — the `test`/`build`/`lint` keys.
2. `pyproject.toml` (`[tool.pytest.ini_options]`, `[project.scripts]`) or `setup.cfg`.
3. `Cargo.toml` or `go.mod` — the stack's own `test`/`build` conventions.
4. `Makefile` targets literally named `test`, `build`, or `lint`.
5. Any CI workflow file (`.github/workflows/*.yml`, `.gitlab-ci.yml`, …) — the commands it
   actually invokes. **A CI config that already runs a command beats a manifest script of the
   same name** when the two disagree: CI is what actually gates merges.

**Monorepo.** More than one manifest below root, each in its own directory → scaffold each
package directory its own `CLAUDE.md` stub, in addition to the root file.

**Package manager.** Note the lockfile beside the manifest
(`package-lock.json`/`yarn.lock`/`pnpm-lock.yaml`, `poetry.lock`/`uv.lock`, `Cargo.lock`,
`go.sum`) to name the exact invocation (`npm test` vs `pnpm test`).

## Output

0. **Branch check, before any write** — `${CLAUDE_PLUGIN_ROOT}/references/branch.md`'s
   Committing rule, which already covers this playbook's standalone case.

1. **Root `CLAUDE.md`.** Create one holding only a `## devcycle onboarding` section, or append
   that section to an existing file — never a blind overwrite of content above or below it.
   The section names the detected stack and the exact, copy-pasteable commands, and nothing
   else — no restated devcycle process prose:

   ```markdown
   ## devcycle onboarding

   Stack: <detected, e.g. "Node.js (npm), TypeScript">
   Test: `<exact command>`
   Build: `<exact command>`
   Lint: `<exact command, or "none detected">`
   ```

2. **Per-package `CLAUDE.md` stubs**, one per detected package directory in a monorepo, same
   shape, naming only that package's own commands.

3. **A proposed permission allowlist** for Claude Code's `settings.json` `permissions.allow`
   array — the detected test/build/lint invocations plus `git status`, `git diff`, `git log` —
   **presented in the response for the user to review, never written to `settings.json` until
   the user confirms it.**

4. **The verification command** is the scaffolded `CLAUDE.md`'s own `Test:` line — where the
   green gate and this repo's CI find it. No separate state file.

5. **Commit the scaffold**, scoped per
   `${CLAUDE_PLUGIN_ROOT}/references/commit-convention.md`'s "Scoping the commit": the root
   and per-package `CLAUDE.md` files are the only thing this run authored. If
   `git check-ignore` covers a written path, write it and skip the commit for that file; the
   repo's own ignore rules decide.

## Entry point

`/devcycle:onboard`, standalone: no `.devcycle/state.md` touch, no handoff block.

Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.
