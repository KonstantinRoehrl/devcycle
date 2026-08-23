# Routing — intent to entry point, and what each command may do

The single owner of the user-facing surface. No existing reference fits: `${CLAUDE_PLUGIN_ROOT}/references/config.md`
owns knobs, profiles and model routing, `${CLAUDE_PLUGIN_ROOT}/references/delegation.md` owns who does the work once a
stage is running, and neither maps a user's intent to an entry point or says what a command may
do before its first confirmation. Every entry point appears exactly once; `scripts/validate.mjs`
fails the build if a command is missing from this table or if its `consequence` disagrees with
its frontmatter.

`consequence` is one of:

- `read-only` — writes nothing outside a report. Must **not** carry `disable-model-invocation`.
- `confirm-first` — may write, but takes no irreversible action before its first user
  confirmation. The deliberate exception class; each member names its justification below.
- `side-effectful` — writes before any confirmation gate. Must carry `disable-model-invocation`.
- `resume` — acts on existing state and must never be silently substituted. Must carry
  `disable-model-invocation`.

| intent | entry point | consequence | model-invocable |
| --- | --- | --- | --- |
| build a feature, fix a bug, refactor | `cycle` | confirm-first | yes |
| resume an interrupted cycle | `continue` | resume | no |
| review a branch, a repo, or a file set | `review` | read-only | yes |
| assess a repo's longitudinal health over time | `maintain` | read-only | yes |
| check a branch's behaviour on the device | `verify` | read-only | yes |
| turn sessions and memory into landed rules | `learn` | side-effectful | no |
| profile cost, depth, model routing, config drift | `doctor` | read-only | yes |
| bootstrap devcycle in a repo | `onboard` | side-effectful | no |

**`cycle`'s justification.** Model-invocable by deliberate exception (`DESIGN.md` §4 amendment
4, reversed 2026-07-24) so a wrapper skill can call the pipeline programmatically. It creates
no branch and makes no commit before its first user confirmation, and it surfaces a state-file
collision rather than overwriting one.

**`maintain` vs its neighbours.** `maintain` assesses a repository's longitudinal health — how
its abstractions and history trend over time — and in Phase 1 it does so by running a whole-repo
audit that stops at a ranked findings document, so its behaviour is close to `review` at repo
scope; the longitudinal difference (cross-pass memory and the abstraction/history lenses) is not
yet behavioural and lands in a later phase. It still differs in intent from `review` (single-shot,
the code as it stands now), from `doctor` (pipeline cost, depth and model routing — not the code),
and from `learn` (distilling sessions into landed rules — not assessing the repo).

**Naming.** Commands are verbs, playbooks are gerunds, agents are role nouns. `doctor` is the
single recorded exception, justified by `brew doctor` / `flutter doctor` / `npm doctor`.
