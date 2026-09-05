# Routing — intent to entry point, and what each command may do

The single owner of the user-facing surface. No existing reference fits: `${CLAUDE_PLUGIN_ROOT}/references/config.md`
owns knobs, profiles and model routing, `${CLAUDE_PLUGIN_ROOT}/references/delegation.md` owns who does the work once a
stage is running, and neither maps a user's intent to an entry point or says what a command may
do before its first confirmation. Every entry point appears exactly once. `scripts/validate.mjs`
fails the build when a command is missing from this table, when a row names no command, when a
command is listed twice, when a `consequence` cell is not one of the classes below (or that list
is unreadable), when the classes below and the classes the script's own clauses act on disagree in
either direction, when a `consequence` disagrees with the command's `disable-model-invocation`
frontmatter, when a `confirm-first` row names no justification in the prose below, or when a
command's own description names `read-only`, `side-effectful` or `confirm-first` and its row
assigns a different one. `resume` is not scanned in a description, because `continue.md`'s opens
with the verb.

`consequence` is one of:

- `read-only` — never modifies the repo's source and starts no cycle; its writes are confined to
  its own report and the devcycle-owned records that same pass derives
  (`${CLAUDE_PLUGIN_ROOT}/references/config.md` § Doc tracking owns which of those are committed).
  Anything it writes beyond those — `review`'s PR comments, `doctor`'s filed issues — is an opt-in
  step it confirms before posting, never automatic.
  Must **not** carry `disable-model-invocation`.
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
| triage, fix, and reply to a PR's review comments | `reconcile` | confirm-first | yes |

**`reconcile`'s justification.** Model-invocable by deliberate exception so a wrapper skill can
call the reconcile stage programmatically after a review lands. It makes no commit and posts no
reply before its first user confirmation, and it surfaces conflicting cycle state rather than
overwriting one. It earns its own verb rather than folding into `review` because the
call-site names the intent — reconciling an existing PR's comments, not producing new findings.

**`cycle`'s justification.** Model-invocable by deliberate exception (`docs/design/README.md` §4
amendment 4, reversed 2026-07-24) so a wrapper skill can call the pipeline programmatically. It creates
no branch and makes no commit before its first user confirmation, and it surfaces a state-file
collision rather than overwriting one.

**`maintain` vs its neighbours.** `maintain` assesses a repository's longitudinal health — how
its abstractions and history trend over time — by running a whole-repo audit that stops at a
ranked findings document. Its abstraction and history lenses and its cross-pass memory are
behavioural today, so it reads the code across passes rather than only as it stands now; that is
what sets it apart from `review` (single-shot, the code as it stands now), from `doctor` (pipeline
cost, depth and model routing — not the code), and from `learn` (distilling sessions into landed
rules — not assessing the repo). Its cross-pass memory — the per-finding
`docs/devcycle/maintenance-findings/` store — is a devcycle-owned record of the kind the
`read-only` definition above admits, not a write outside one. Whether that store is committed or
stays local is the doc-tracking policy's call, never this class's
(`${CLAUDE_PLUGIN_ROOT}/references/config.md` § Doc tracking, whose `commit` cells
`git check-ignore` can still veto).

**Naming.** Commands are verbs, playbooks are gerunds, agents are role nouns. `doctor` is the
single recorded exception, justified by `brew doctor` / `flutter doctor` / `npm doctor`.
