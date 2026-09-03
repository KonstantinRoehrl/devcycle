# Platform verification notes (Task 2, §10.D gate)

Verified empirically on Claude Code 2.1.217 (macOS, arm64), 2026-07-22. Each section:
what was tried, exact result, consequence for the plan. In quoted command output, the
machine's home directory has been abbreviated to `~` and the checkout to `<repo-root>`;
everything else is verbatim.

## (a) How userConfig values reach skills/commands at runtime

**What was tried.**

1. `claude plugin validate <repo-root>` against the original manifest (typed `enum`/`object`
   userConfig entries) — failed with 10 schema errors:

   ```
   ❯ plugins[0] plugin.json → userConfig.gitPolicy.title: Invalid input: expected string, received undefined
   ❯ plugins[0] plugin.json → userConfig.gitPolicy: Unrecognized key: "enum"
   ❯ plugins[0] plugin.json → userConfig.modelLineup.type: Invalid option: expected one of "string"|"number"|"boolean"|"directory"|"file"
   ❯ plugins[0] plugin.json → userConfig.modelLineup.default: Invalid input
   ...
   ```

2. Official docs (code.claude.com/docs/en/plugins-reference, "User configuration") confirm the
   schema: per option `type` (`string|number|boolean|directory|file`), `title` (required),
   `description` (required), optional `sensitive`, `required`, `default`, `multiple`, `min`/`max`.
   No `enum`, no `object`. Runtime exposure, quoted: "Each value is available for substitution as
   `${user_config.KEY}` in MCP and LSP server configs and hook commands. Non-sensitive values can
   also be substituted in skill and agent content." Values are stored in user `settings.json`
   under `pluginConfigs[<plugin-id>].options`.

3. Runtime probe: a temporary command `commands/probe-config.md` containing literal
   `${user_config.gitPolicy}`, `${user_config.onDeviceGate}`, `${user_config.crossModelReview}`,
   and `${CLAUDE_PLUGIN_ROOT}` placeholders, installed and invoked via
   `claude -p "/devcycle:probe-config"`.

   With **no options set** (fresh install; CLI reports "8 userConfig options not yet set"):

   ```
   - `GITPOLICY=${user_config.gitPolicy}`
   - `ONDEVICEGATE=${user_config.onDeviceGate}`
   - `CROSSMODEL=${user_config.crossModelReview}`
   - `PLUGINROOT=<repo-root>/`
   ```

   With **two options set** (`claude plugin install devcycle@devcycle --config
   gitPolicy=push-allowed --config crossModelReview=true`; verified stored under
   `pluginConfigs["devcycle@devcycle"].options` in user settings.json):

   ```
   - `GITPOLICY=push-allowed`
   - `ONDEVICEGATE=${user_config.onDeviceGate}`
   - `CROSSMODEL=true`
   - `PLUGINROOT=<repo-root>/`
   ```

**Exact result.** `${user_config.KEY}` template substitution in skill/command content WORKS for
values the user has explicitly set (via `--config` or `/plugin configure`). It does NOT apply
declared `default` values: an unset option passes through as the literal `${user_config.KEY}`
string, even when the manifest declares a `default`. `${CLAUDE_PLUGIN_ROOT}` substitutes in
content (for a local-path marketplace install it resolves to the marketplace source directory,
not the cache copy). Uninstalling the plugin clears its stored options.

**Consequence for the plan.**

- `.claude-plugin/plugin.json` was corrected in this task (Task 2 owns the schema fix):
  every option gained a required `title`; `enum` keys were dropped (allowed values moved into
  `description` text; skills must treat out-of-range values as invalid and fall back to the
  documented default); **P9's `modelLineup` object is not expressible and became four flat
  string options: `implementerModel`, `taskReviewerModel`, `walkthroughModel`,
  `branchReviewModel`** (same defaults as P9). Wave-3 tasks must use these flat keys.
- Skills/commands must never treat `${user_config.KEY}` inline text as always-resolved. Required
  authoring pattern: quote the placeholder and instruct the model — "if this still reads as a
  literal `${user_config...}` placeholder, the option is unset; use the documented default
  `<value>`." Both probe runs show the model reliably distinguishes substituted from raw text,
  so defaults live in skill prose, not in the substitution mechanism.
- No `.devcycle/config.json` fallback is required: the injection mechanism itself works and the
  unset-default gap is fully handled by the authoring pattern above. Flagged for coordinator
  judgment in the task report nonetheless, since "defaults are not injected" is weaker than the
  naive reading of P9.

## (b) Description character budget

**What was tried.** Skills docs (code.claude.com/docs/en/skills, "Skill descriptions are cut
short"), settings schema strings and constants extracted from the Claude Code 2.1.217 binary,
and a `claude -p "/context"` probe.

**Exact result.**

- Per-entry cap: combined `description` + `when_to_use` is truncated at **1,536 characters**
  in the skill listing (binary default `HWg=1536`; configurable via `skillListingMaxDescChars`).
- Whole-listing budget, shared across ALL installed skills/commands from all plugins plus
  personal skills: **1% of the model's context window, at 4 chars/token** (binary:
  `IWg=0.01, zDu=4, DWg=200000`; overridable via `skillListingBudgetFraction` setting or
  `SLASH_COMMAND_TOOL_CHAR_BUDGET` env var). That is **8,000 chars on a 200k-token model**;
  larger-context models scale up (the `/context` probe ran at 967k tokens → ~38.7k chars).
  On overflow, Claude Code truncates descriptions starting with the least-invoked skills.
- `claude -p "/context"` works non-interactively and reported the whole Skills category at
  ~4k tokens with this machine's full plugin set installed. Per-component token readouts are
  deliberately not recorded here: they cannot be reproduced headlessly, and a number no reader
  can re-derive is what let this section's own measurement rot.

**Consequence for the plan.** `DESCRIPTION_BUDGET_TOTAL = 6000` in `scripts/validate.mjs` is
**kept**: there is no platform hard limit it violates (it sits under the worst-case 8,000-char
shared budget, and each entry is well under the 1,536-char per-entry cap given the ≤500-char
per-description constraint). Note that the binding constraint in practice is ≤500 chars ×
8 entries = 4,000 chars; 6000 is a generous fail-stop, and one plugin consuming most of a
200k-model's shared 8,000-char listing would crowd out other plugins' descriptions — keep
descriptions lean.

**Re-derived from this repo's frontmatter, 2026-08-20.** Eight commands — `continue` 92 +
`cycle` 140 + `doctor` 262 + `learn` 215 + `maintain` 225 + `onboard` 309 + `review` 147 +
`verify` 112 = **1,502 chars** — 25% of the 6,000-char `DESCRIPTION_BUDGET_TOTAL` and 19% of
the worst-case 8,000-char shared listing on a 200k-token model. Five agents carry
88 + 57 + 167 + 107 + 112 = **531 chars**, and those sit outside that budget: `scripts/validate.mjs` sums `commands/`
frontmatter and nothing else, because playbooks are loaded by path, appear in no roster, and
carry no frontmatter at all (`scripts/validate.mjs:58-60` says so in its own comment).
Reproduce by summing the `description:` field of every file in `commands/` and in `agents/`;
`node scripts/validate.mjs` independently sums the commands half and fails above 6,000.

## (c) `workflows/*.js` invocation from the plugin cache path

**What was tried.** A temporary probe `workflows/probe.js` (Node script echoing its own path,
cwd, env, and JSON argv) was shipped through a real install, then invoked directly from the
cache path:

```
$ node ~/.claude/plugins/cache/devcycle/devcycle/0.1.0/workflows/probe.js '{"ref":"HEAD","specPath":"docs/spec.md"}'
{"ok":true,"node":"v26.4.0","scriptPath":"~/.claude/plugins/cache/devcycle/devcycle/0.1.0/workflows/probe.js","cwd":"<repo-root>","pluginRootEnv":null,"echoedArgs":{"ref":"HEAD","specPath":"docs/spec.md"}}
```

**Exact result.** Works cleanly: the install copies `workflows/` into the version-keyed cache
directory verbatim, Node (v26.4.0 on this machine) executes it from there, cwd stays the
invoking directory (the target repo), and JSON argv round-trips. `CLAUDE_PLUGIN_ROOT` is NOT
in the environment of a plain shell — but it IS substituted in skill/command *content* (see
(a)), so the resolved absolute path reaches the Bash command via the skill text. The probe was
removed after verification (it must not ship).

**Consequence for the plan.** Pinned invocation form for P6/P7 consumers — skills invoke
workflows as:

```
node "${CLAUDE_PLUGIN_ROOT}/workflows/review-panel.js" '<json-args>'
```

with args as a single JSON argv[2] string and results as JSON on stdout. Do not rely on a
`CLAUDE_PLUGIN_ROOT` environment variable inside the script itself; pass anything the script
needs via argv. Two cache facts to carry forward: (1) the cache is version-keyed
(`.../devcycle/devcycle/<version>/`) and is NOT refreshed by reinstall at the same version
after source edits — bump the version or uninstall/reinstall during development; (2) a
local-path marketplace install copies the folder's *current contents*, including gitignored
files (`scripts/redaction-terms.local.txt` appeared in the cache) and internal dirs
(`.superpowers/`, `docs/`, `.github/`) — a git-backed (GitHub) install ships git contents
instead, so nothing gitignored leaks in the published flow, but internal tracked dirs will
ship with the plugin unless the marketplace `source` is later narrowed.

## (d) Local marketplace add, install, and superpowers dependency resolution

**What was tried / exact result.**

```
$ claude plugin marketplace add <repo-root>
✔ Successfully added marketplace: devcycle (declared in user settings)

$ claude plugin install devcycle@devcycle
✔ Successfully installed plugin: devcycle@devcycle (scope: user)
8 userConfig options not yet set — run /plugin configure devcycle@devcycle in Claude Code, or pass --config KEY=VALUE.
```

First install attempt (with the original `"dependencies": ["superpowers"]`) loaded FAILED:

```
❯ devcycle@devcycle
  Status: ✘ failed to load
  Error: Dependency "superpowers@devcycle" is not installed — run `claude plugin install superpowers@devcycle`, or check that its marketplace is added
```

A bare dependency name resolves **within the declaring plugin's own marketplace** (docs,
plugin-dependencies page: "Plugin name. Resolves within the same marketplace as the declaring
plugin."). Cross-marketplace dependencies need the object form plus the root marketplace's
`allowCrossMarketplaceDependenciesOn` allowlist (already present in `marketplace.json`).
After correcting `plugin.json` to:

```json
"dependencies": [{ "name": "superpowers", "marketplace": "superpowers-marketplace" }]
```

and reinstalling, `claude plugin list --json` shows `devcycle@devcycle` enabled with **no
`errors` field** (the marker for `dependency-unsatisfied` and friends), resolving against the
already-installed `superpowers@superpowers-marketplace` 6.1.1. A live `claude -p` session
confirms the plugin is active (its agents appear in `/context` output).

**Consequence for the plan.** The corrected dependency object form is now in
`.claude-plugin/plugin.json` and must be preserved. Users without the superpowers marketplace
configured will have the dependency auto-resolved only if `obra/superpowers-marketplace` is in
their configured marketplaces; otherwise install reports it — README (Task 4 scope) should
tell users to add the superpowers marketplace first. `claude plugin validate <repo-root>`
passes (one cosmetic warning: the marketplace manifest has no `description` field — worth
adding when `marketplace.json` is next touched, outside Task 2's file set).

[Superseded 2026-07-23: superpowers install mechanics are deliberately linked, not
documented — see the decision log, `docs/decisions/README.md`.]

[Superseded 2026-07-23, second correction: the pin above moved to
`claude-plugins-official`. superpowers is published in both marketplaces, and dependency
satisfaction is keyed on `name@marketplace` — a user with `superpowers@claude-plugins-official`
enabled still hit `dependency-unsatisfied` under the `superpowers-marketplace` pin
(reproduced in an isolated config; a bare `"superpowers"` entry resolves as
`superpowers@devcycle` and also fails). The marketplace `description` was added in the
same change. See `docs/decisions/README.md`.]

## (e) The `agent_type` a plugin hook receives inside a subagent

**What was tried.** The browser guard (`hooks/block-main-thread-browser.mjs`) allowlists the
`on-device-driver` subagent by comparing the hook input's `agent_type`. Whether the harness passes
the bare frontmatter `name:` or the plugin-namespaced dispatch id decides whether the guard permits
the one agent it exists to permit, and no unit test in this repo can observe it: every unit test
feeds the hook a hand-written body.

The field was therefore read off the running harness, in the on-device stage of the cycle that
fixed the guard (Claude Code 2.1.237, macOS arm64, 2026-08-20). Because the hook renders
`agent_type` only on its deny path, the reading took two passes over the installed plugin's hook
file — first a copy whose `ALLOWED_AGENT_TYPES` was emptied, so every origin was denied and named
itself, then the real one. The installed file was restored afterwards and verified by sha against
`git show 58e5611:hooks/block-main-thread-browser.mjs`.

1. **Observed, all three origins.** Under the emptied allowlist:

   ```
   coordinator main thread          (agent_type seen: (absent))
   devcycle:on-device-driver        (agent_type seen: "devcycle:on-device-driver")
   general-purpose                  (agent_type seen: "general-purpose")
   ```

   `(absent)` is the hook's rendering for `undefined`; an empty or whitespace-only string renders
   `(empty)`. So on the main thread the key is missing from the stdin JSON entirely.

2. **Corroborated from the installed binary** (header of
   `tests/unit/block-main-thread-browser.test.mjs`, Claude Code 2.1.235): the hook-input builder
   emits `agent_type: o` where `o = n?.agentType ?? hookRegistry.mainThreadAgentType()`. The hook
   therefore receives whatever the session records as `agentType` — which is why the counts below
   describe the same field the readings above came from.

3. That same field is written into every transcript record, so the shape can be counted across
   agents this walkthrough did not dispatch. Over this repo's own sessions, 2026-08-20:

   ```
   ❯ grep -roh '"agentType":"[^"]*"' ~/.claude/projects/<this repo's transcript dir> \
       | sort | uniq -c | sort -rn
     449 "agentType":"devcycle:implementer"
     342 "agentType":"devcycle:task-reviewer"
     141 "agentType":"general-purpose"
     108 "agentType":"workflow-subagent"
      42 "agentType":"Explore"
      23 "agentType":"devcycle:red-team-reviewer"
       5 "agentType":"fork"
       1 "agentType":"claude-code-guide"
   ```

   Every plugin-provided agent appears namespaced; a bare `implementer`, `task-reviewer` or
   `red-team-reviewer` never appears. Built-in agent types (`general-purpose`, `Explore`, `fork`)
   carry no prefix, which is exactly what the namespace disambiguates.

**Exact result.** A plugin agent's `agent_type` is `<plugin>:<frontmatter name>` —
`devcycle:on-device-driver` for this plugin's driver, read off the running harness. On the main
thread the key is absent from the stdin JSON entirely, not an empty string. A second guard now relies on this: `hooks/block-reviewer-git-write.mjs` denies destructive git from
the `task-reviewer`/`red-team-reviewer` origins, pinning both the bare and `devcycle:`-namespaced
spellings for the same reason the browser guard does.

**Consequence for the plan.** The guard's original `agentType === "on-device-driver"` comparison
matched nothing it ever saw: it denied the driver as readily as the main thread, so the on-device
stage could not run at all. That is not a deduction — it was reproduced against the released hook
in the same session, one file apart:

| installed hook | main thread | `devcycle:on-device-driver` | `general-purpose` |
| --- | --- | --- | --- |
| released 0.14.1 | denied | **denied** — the bug | denied |
| fixed (this file's guard) | denied | **permitted, reached Chrome** | denied |

The released hook's denial also carries no `(agent_type seen: …)` suffix, so on that version a
spelling mismatch was indistinguishable from an ordinary main-thread denial — which is why the
defect surfaced in an audit rather than as a symptom.

Both spellings are now pinned in `ALLOWED_AGENT_TYPES` and asserted in
`tests/unit/golden-path.test.mjs` against the agent's frontmatter `name:` and the plugin's own name.
The bare spelling is kept because it is what the frontmatter declares and what a future harness
change could plausibly pass — a by-hand run confirms the guard admits it today, so the fix does not
depend on the harness continuing to namespace. Stripping a `<plugin>:` prefix instead was rejected
because it would also admit another plugin's agent that happens to share the name.

## (f) The `PostToolUse` contract the workload commit-sensor relies on

**What was tried.** `hooks/workload-sensor.mjs` (issue #139) reads its origin and target the same
way `hooks/block-main-thread-browser.mjs` does — total stdin read, JSON-parsed, non-object shapes
treated as empty — rather than probing a new mechanism, so this entry corroborates rather than
re-derives. Verified against the platform docs (code.claude.com/docs/en/hooks.md, `PostToolUse`
and "Hook input" sections) and against § (e) above, which already established the `agent_type`
field's presence/absence contract from a live harness reading.

**Exact result.**

- `PostToolUse` fires **after** the matched tool has already run — a hook here observes a
  completed action, it cannot approve or veto it. The docs state plainly that `PostToolUse` hooks
  "cannot block the tool call since it has already run"; exit 0 with no stdout is therefore the
  hook's only correct response to anything it cannot act on (absent state file, non-active stage,
  no real diff, subagent origin, malformed input) — there is no deny channel to fall back to.
- The stdin JSON for a `PostToolUse(Bash)` call carries `cwd` (the invoking shell's working
  directory) and `tool_name`/`tool_input.command` (here always `"Bash"` / the executed command
  string) alongside the fields already documented in § (e): `agent_type`/`agent_id` are present
  only when the call originated inside a subagent and absent on the main thread — the sensor reuses
  that same absent/present read to skip subagent-origin calls without spawning `git`.
- A plugin's `hooks/hooks.json` `PostToolUse` block is auto-discovered on install/enable exactly
  like its `PreToolUse` block (no separate registration step), and `${CLAUDE_PLUGIN_ROOT}` resolves
  in its `command` string the same way § (c) already established for skill/command content.

**Consequence for the plan.** The sensor's fail-safe posture (QC1) is not a defensive choice on top
of the contract — it is the only posture the contract allows: since `PostToolUse` cannot block or
retry a tool call, every unrecognized or partial shape it sees must resolve to "no output, exit 0,"
matching the canonical no-op `hooks/block-main-thread-browser.mjs`'s deny path already models for
`PreToolUse`. No new probe was required; the existing `agent_type` reading and the `${CLAUDE_PLUGIN_ROOT}`
substitution both transfer unchanged to this hook.
