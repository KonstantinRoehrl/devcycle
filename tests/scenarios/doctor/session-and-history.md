# Scenario: session-and-history
- Skill under test: devcycle:doctor (`commands/doctor.md` + `skills/doctor/SKILL.md`)
- Type: output-shape

Do all three `/devcycle:doctor` invocation modes reach `scripts/doctor.mjs` with the flags
that mode implies, rather than the agent walking transcripts by hand; does the reported list
rank by dollar impact with a concrete lever per entry instead of reprinting the script's raw
tables; do the script's `UNPRICED MODEL` lines and its `prices as of` vintage survive into the
report; are the script's own two disclosures — sticky skill attribution, the band-fraction
approximation — carried forward rather than smoothed away; and does the run stay standalone,
writing no `.devcycle/state.md`, starting no cycle, and emitting no handoff block?

## Setup

`scripts/doctor.mjs` resolves its transcript root as `os.homedir() + "/.claude/projects"` —
it reads `$HOME` directly and has no `CLAUDE_CONFIG_DIR` awareness, unlike the credential
isolation other scenarios in this suite rely on. So the isolation this scenario needs is a
fresh `$HOME` for the whole subagent process (not just a fresh `CLAUDE_CONFIG_DIR`): a
session-temp directory that becomes the sandboxed `$HOME`, with credentials placed under its
`.claude` the same way the baseline-hygiene protocol refreshes a `CLAUDE_CONFIG_DIR` — so the
init event still confirms `plugins: []`, and `~/.claude/projects` for the subagent's own
process resolves inside the sandbox rather than into the real machine's history.

Populate `$HOME/.claude/projects/` with two synthetic session transcripts before any run
starts (flat one-file-per-session layout, matching `tests/unit/doctor.test.mjs`'s fixture
shape — the metrics keying is per-record `attributionSkill`/`isSidechain`/`attributionAgent`,
not file placement):

```bash
export SANDBOX_HOME="<session-temp directory>"
mkdir -p "$SANDBOX_HOME/.claude/projects/-fixture-project-a"
mkdir -p "$SANDBOX_HOME/.claude/projects/-fixture-project-b"

cat > "$SANDBOX_HOME/.claude/projects/-fixture-project-a/sess-aaaa1111aaaa.jsonl" <<'EOF'
{"sessionId":"sess-aaaa1111aaaa","isSidechain":false,"type":"assistant","timestamp":"2026-07-15T09:00:00.000Z","cwd":"/fixture/project-a","gitBranch":"main","attributionSkill":"devcycle:planning-waves","message":{"model":"claude-opus-5","usage":{"input_tokens":4000,"cache_creation_input_tokens":6000,"cache_read_input_tokens":9000,"output_tokens":1200},"content":[{"type":"tool_use","name":"Task","input":{"description":"implement task 3"}}]}}
{"sessionId":"sess-aaaa1111aaaa","isSidechain":true,"type":"assistant","timestamp":"2026-07-15T09:05:00.000Z","cwd":"/fixture/project-a","gitBranch":"main","attributionSkill":"devcycle:executing-waves","attributionAgent":"implementer","agentId":"agent-a1","message":{"model":"claude-sonnet-5","usage":{"input_tokens":3000,"cache_creation_input_tokens":2000,"cache_read_input_tokens":4000,"output_tokens":900}}}
{"sessionId":"sess-aaaa1111aaaa","isSidechain":false,"type":"assistant","timestamp":"2026-07-15T09:10:00.000Z","cwd":"/fixture/project-a","gitBranch":"main","attributionSkill":"devcycle:planning-waves","message":{"model":"claude-haiku-4-1","usage":{"input_tokens":1500,"cache_creation_input_tokens":500,"cache_read_input_tokens":800,"output_tokens":400}}}
EOF

cat > "$SANDBOX_HOME/.claude/projects/-fixture-project-b/sess-bbbb2222bbbb.jsonl" <<'EOF'
{"sessionId":"sess-bbbb2222bbbb","isSidechain":false,"type":"assistant","timestamp":"2026-06-10T14:00:00.000Z","cwd":"/fixture/project-b","gitBranch":"main","attributionSkill":"devcycle:auditing-a-repo","message":{"model":"claude-fable-5","usage":{"input_tokens":40000,"cache_creation_input_tokens":90000,"cache_read_input_tokens":130000,"output_tokens":6000},"content":[{"type":"tool_use","name":"Task","input":{"description":"sweep for findings","model":"claude-sonnet-5"}}]}}
{"sessionId":"sess-bbbb2222bbbb","isSidechain":false,"type":"assistant","timestamp":"2026-06-10T14:10:00.000Z","cwd":"/fixture/project-b","gitBranch":"main","attributionSkill":"devcycle:auditing-a-repo","message":{"model":"claude-fable-5","usage":{"input_tokens":42000,"cache_creation_input_tokens":95000,"cache_read_input_tokens":140000,"output_tokens":6200}}}
EOF
```

What this buys, computed against `scripts/pricing.mjs` (`asOf: "2026-08-01"`, `claude-opus-5`
$5/$25, `claude-sonnet-5` $2/$10, `claude-fable-5` $10/$50, no entry for `claude-haiku-4-1`):

- **Two stages at very different dollar cost**, so a report that merely reprints the tables
  (no ranking) is distinguishable from one that leads with the expensive one:
  `devcycle:auditing-a-repo` (fixture-project-b, both turns) costs roughly **$4.01**;
  `devcycle:planning-waves` (fixture-project-a's priced turn) costs roughly **$0.09**;
  `devcycle:executing-waves` (the `implementer`-attributed subagent turn) costs roughly
  **$0.02**.
- **One unpriced model.** `claude-haiku-4-1` has no `scripts/pricing.mjs` entry, so that turn's
  cost is excluded and the script emits `UNPRICED MODEL: claude-haiku-4-1 (1 requests)`.
- **One dispatch without an explicit model, one with.** Fixture-project-a's first turn's `Task`
  call carries no `model` field; fixture-project-b's first turn's `Task` call does — the
  printed `dispatches: 2, without an explicit model 1` line gives the skill's "dispatches
  omitting a model" lever something real to point at.
- **A deep-context stage.** Both fixture-project-b turns carry roughly 260,000–277,000 tokens
  of context depth, landing in the script's `200-300k` band, so `devcycle:auditing-a-repo` is
  simultaneously the priciest stage and the deepest one — material for the "stage running
  deep" lever.

Both timestamps (2026-06-10, 2026-07-15) fall inside the `--since`/`--until` window each run
below uses, so all three invocation modes see the same fixture data and only their command
line differs — this scenario grades invocation fidelity and report shape, not the script's own
windowing or session-scoping logic (unit-tested separately in `tests/unit/doctor.test.mjs`).

**Reference layer (required for every run).** `skills/doctor/SKILL.md` points at
`${CLAUDE_PLUGIN_ROOT}/references/output.md` for the report shape. Check out (or copy) the
devcycle plugin somewhere readable from the sandbox and give the agent the substitution in the
environment note, the same as any other scenario in this suite — a dangling pointer grades a
broken setup, not the text.

No `.devcycle/` directory exists anywhere the subagent can reach, and no other devcycle state
is present, so any `.devcycle/state.md` appearing after a run is unambiguously the skill's own
doing.

## Subagent prompt

Three independent fresh headless subagents (`claude -p`, sandboxed `$HOME` as above), one per
invocation mode — `/devcycle:doctor` is stateless per call, so nothing is lost by not chaining
them as turns in one session, and running them separately keeps each transcript's Bash calls
unambiguous about which invocation produced them.

> You are a coding agent, in a brand-new session with no memory of any previous conversation.
> Produce your response to the invocation below, then stop.
>
> === COMMAND (the user invoked `/devcycle:doctor[[ INVOCATION ]]`; follow this exactly) ===
> [Splice here: full body of `commands/doctor.md`.]
> === END COMMAND ===
>
> === SKILL (devcycle:doctor, named by the command) ===
> [Splice here: full body of `skills/doctor/SKILL.md`.]
> === END SKILL ===
>
> Environment notes: the devcycle plugin's files are checked out at <absolute path of the
> devcycle checkout>; where guidance references `${CLAUDE_PLUGIN_ROOT}`, substitute that path.
> No subagent-dispatch tool is available; do not dispatch anything. You may run shell commands
> and read files.

`[[ INVOCATION ]]` and the corresponding line replacing "the user invoked ..." vary per run:

- **Run bare** — invocation ` ` (no flags); user line: `the user invoked /devcycle:doctor`.
- **Run --all** — invocation ` --all`; user line: `the user invoked /devcycle:doctor --all`.
- **Run --since/--until** — invocation ` --since 2026-06-01 --until 2026-07-31`; user line:
  `the user invoked /devcycle:doctor --since 2026-06-01 --until 2026-07-31`.

## Pass criteria

1. **All three invocation modes reach the script with the right flags.** Run bare's Bash call
   is `node "<plugin path>/scripts/doctor.mjs"` with no `--all`, `--since`, or `--until`; run
   `--all`'s call adds `--all`; run `--since`/`--until`'s call adds
   `--since 2026-06-01 --until 2026-07-31`. Every run's transcript shows that Bash call — no
   run instead lists, greps, or `cat`s `.jsonl` files under `.claude/projects` by hand.
2. **The skill ranks by dollar impact and names a lever per entry.** Each run's report leads
   with the stages/models/agent types actually more expensive first — `devcycle:auditing-a-repo`
   ahead of `devcycle:planning-waves` ahead of `devcycle:executing-waves` — and each ranked
   entry names a concrete lever (e.g. the deep `devcycle:auditing-a-repo` stage, the dispatch
   missing a model, the unpriced `claude-haiku-4-1`). A report that reproduces the script's
   `by model:`/`by stage:`/`by agent type:` tables verbatim with no ranking prose and no named
   lever is a fail — interpretation is what the skill adds over the script's raw output.
3. **`UNPRICED MODEL` lines and the price vintage survive into the report.** Every run's report
   states `UNPRICED MODEL: claude-haiku-4-1 (1 requests)` by name and states that its cost is
   excluded from the dollar totals, and every run's report carries `prices as of 2026-08-01`
   forward. Dropping either makes the numbers read as more complete than they are.
4. **The script's own disclosures are carried, not smoothed away.** Every run's report states,
   in its own words, both that skill attribution is sticky (sessions whose devcycle work
   continued past the last skill invocation are under-counted) and that the context-depth
   bands are a fraction-based approximation rather than a measurement of absolute cache-read
   cost. Neither is folded silently into the ranked list without being said.
5. **Standalone is respected.** No run creates `.devcycle/state.md` anywhere in the sandbox, no
   run announces starting a cycle or entering a pipeline stage, and no run emits a handoff
   block. `find <sandbox root> -name state.md` returns nothing after every run.

## Baseline (red)

**Not yet run.** Established without a model run: at `2846b40`, the commit immediately before
`commands/doctor.md` and `skills/doctor/SKILL.md` were added, neither file exists —
`git show 2846b40:commands/doctor.md` and `git show 2846b40:skills/doctor/SKILL.md` both fail
with "path ... is in the working tree, but not in '2846b40'". There is no `/devcycle:doctor`
surface at all at that commit, so a splice of the pre-change tree has nothing to invoke: every
criterion here fails by construction, not by a behavioral defect in any prior text.

What would prove it: the three-run setup above with the command/skill splice slots left empty
(no `/devcycle:doctor` surface for the agent to follow), confirming the model falls back to
manual transcript inspection or declines the invocation outright rather than accidentally
reproducing this report shape from general knowledge.

## Result (green)

**Not yet run.** Blocked on standing up the sandboxed-`$HOME` headless-run protocol this
scenario needs (see Setup) — no scenario in this suite has needed to redirect a subagent's own
`$HOME` before, since every other skill under test reads the repository it's handed rather than
Claude Code's own transcript store. What would prove it: the three runs above against the
working-tree `commands/doctor.md` + `skills/doctor/SKILL.md`, each transcript's Bash tool calls
checked for criterion 1's exact flags, each final report checked against criteria 2–4, and
`find <sandbox root> -name state.md` run after each for criterion 5. The specific risk this run
would settle: whether an agent handed the script's dense tables interprets and ranks them as
the skill instructs, or reports back something close to a verbatim table dump because that is
the path of least resistance.
