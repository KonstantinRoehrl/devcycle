# Delegation — coordinator duties, the stage budget, research dispatches, return envelopes

The single owner of who does the work inside a devcycle stage. `references/handoff.md` owns
what happens at a boundary; this file owns what happens between them. Stage skills point here
rather than restating any of it.

## Coordinator duties

The coordinator does exactly these things itself, and delegates everything else by default:

- interact with the user — interviews, confirmations, gates;
- dispatch subagents;
- run the green gate and read its exit status;
- create commits;
- append the ledger;
- update `.devcycle/state.md`;
- emit handoff blocks.

The list is positive and closed, so "is this micro-work?" is never a judgment call. Anything
not on it — searching, mapping, reading source, producing diffs, drafting fix briefs, triaging
failures — is a dispatch.

**Exempt from delegation**, read directly however deep the session has run: files whose exact
path is already known and whose contents the coordinator must reason about itself —
`.devcycle/state.md`, `.devcycle/ledger.md`, the plan's dispatch map, and a spec under
approval. These are small and bounded; fetching them through a subagent would cost more than
it saves.

## The stage budget

Within one stage, the coordinator is **over budget** once either counter trips:

- **~30 tool calls** made in this stage, or
- **~15 files read** in this stage.

File reads are themselves tool calls, so the read counter is the tighter of the two and binds
first in a read-heavy stage; the call counter catches stages that are busy in other ways.

Over budget means two things: delegate whatever work remains that is not a duty above, and
stop at the next boundary rather than continuing through it.

A third counter binds alongside them, and it is measured rather than estimated: **context
depth**. A running session can read its own transcript, so its exact depth per request is
observable —

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --depth
```

— which prints the depth, the fraction of the running model's context window, and the band:
**over budget at ≥15% of the window, hard stop at ≥20%**. At `over-budget` the two
consequences above apply unchanged (delegate the rest, stop at the next boundary). At
`hard-stop`, `references/handoff.md` forces the boundary's context action to a clear.

**A probe that fails degrades to advisory, never to a pass.** No session id, no matching
transcript, or no usage record exits non-zero with a one-line reason; treat depth as unknown
and let the two tool-call counters bind alone. An unknown depth is never evidence of a
shallow one.

## Research dispatches

Repo research — locating code, mapping surfaces, tracing usage, discovering docs — is a
subagent dispatch that returns **a map, not file dumps**, on the fast tier per
`references/config.md`. A dispatch names its model explicitly; `references/config.md` owns how
an omitted one resolves.

The procedure, canonical here and named rather than restated by the stages that run it:

1. **The coordinator resolves graph availability and injects the result into the dispatch
   prompt.** A graph is available when a `graphify` skill is listed among this session's
   available skills AND the target repo (never this plugin's own repo) has `graphify-out/`
   and/or a root `GRAPH_REPORT.md`.
2. **When available**, the dispatch prompt tells the subagent to read the report and query the
   graph for what the step needs, including `document`-type nodes for relevant docs (graphify
   tags markdown separately from code).
3. **When unavailable, stale, or thin for the area in question**, the dispatch prompt tells
   the subagent to research by plain reading and search, and to find docs two-phase: list
   `*.md` files repo-wide (excluding `node_modules/`, `vendor/`, `dist/`, `build/`, `.git/`,
   and equivalents), index only each file's title or first heading, and read in full only the
   entries judged relevant.
4. **Read-only either way** — never trigger a graphify build or `--update` — and **silent
   either way**: no note about which mode ran, and no docs found is nothing to report.

The coordinator never tells a subagent to go invoke graphify. A subagent's own skill list may
differ from the coordinator's, and `devcycle:executing-waves` already establishes the rule this
follows: content a subagent must fetch can be silently skipped, while injected content cannot.

Each caller supplies its own relevance filter: `devcycle:scoping-interview` judges against the
request itself, since scope is not yet confirmed; `devcycle:planning-waves` judges against the
confirmed scope in `.devcycle/scope.md`; `devcycle:auditing-a-repo` judges against the
confirmed audit criteria.

## Read discipline

Applies to every dispatched agent and to the coordinator's own exempt reads. Measured on the
real corpus: 22.5% of main-thread reads re-read a file already read in the same session, only
25.7% of reads bound the range, and 1.4M tokens of Bash output was file contents printed
around `Read`.

- **Locate with `Grep`/`Glob`, confirm with `Read`.** A search returns line numbers; that is
  usually the whole answer. Opening the file is the second step, not the first.
- **Bound the read.** Once a search has named the lines, `Read` with `limit`/`offset` rather
  than pulling the whole file.
- **Read a file once.** What you already read this session is still in context; re-reading it
  buys nothing and is billed again on every later request.
- **Never print file contents through Bash.** `cat`, `sed -n`, `head`, and `tail` on a source
  file bypass `Read`'s truncation and its de-duplication. Bash stays correct for what it is
  for — running tests, `git diff`, `git status`, exit statuses.

The brief names this section; it is never restated per skill.

## Return envelopes

What a dispatch hands back to the coordinator is a short envelope of paths and counts — never
the content itself. `references/evidence.md` owns the report shape and
`references/findings.md` owns the finding shape; this file owns only the envelope.

**Implementer** — the dispatch's entire final output:

```
status: complete | blocked
report: .devcycle/reports/<task-id>.md
files: <comma-separated paths>
on-device items: <count> | none
deviations: <count> | none
```

**Task reviewer** — the dispatch's entire final output:

```
verdict: <per references/evidence.md>
blocking findings: <count>
findings: .devcycle/findings/<task-id>-round-<n>.md | none
```

The coordinator opens a report or findings file only when a decision needs content the
envelope cannot carry.

**Why the envelope carries counts and not just paths.** Both counted fields drive a
coordinator duty that fires *without* reading the file. `devcycle:executing-waves` requires the
on-device checklist to be generated the moment a task produces rendered changes, in that same
wave; a coordinator that never opens the report would never learn a task produced any, and the
checklist would silently not exist. The deviations count works the same way — it tells the
coordinator whether opening the file is a decision it has to make. An envelope that dropped
either field would trade a real gate for a token saving.

## The short paths

`devcycle:fast-path` and `devcycle:sweeping-mechanical-changes` are in-session by design. The
**delegation default does not apply to them**; the **counters do**. A short path that reaches
the budget means triage judged the change trivial and was wrong: say so and escalate to the
full pipeline. It is a signal, not a licence to keep going.
