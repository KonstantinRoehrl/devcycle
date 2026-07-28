# On-device checklist — audit hardening, on-device branch mode, pipeline diagram

Generated during execution per `references/checklist.md`, and refreshed after the branch-review
rounds that restructured the diagram. The rendered surface this branch produces is the Mermaid
pipeline diagram in `README.md` plus the prose and table directly under it — GitHub renders all
of it server-side, and nothing in this repo can verify it: `scripts/validate.mjs` proves the
fence is balanced and stops there, so a Mermaid syntax error ships green.

The "app" here is GitHub's own markdown rendering. Open the branch's `README.md` on
github.com — not a local preview, whose Mermaid version differs from GitHub's.

## Items

- [x] The diagram draws as a flowchart, not a `Unable to render rich display` error box
      Where: README.md, "The pipeline" section  ·  How to get there: open the branch on github.com, scroll to "The pipeline"

- [ ] The two standalone terminals render as amber pills carrying their full text
      Where: `findings document delivered` (end of the audit branch) and `results report delivered` (end of the on-device branch)
      Why this is in doubt: both are declared inline as the target of a labelled dashed edge with
      the class suffix on the same line (`.-> AUDITSTOP(["…"]):::entry`). Some Mermaid versions
      attach a trailing `:::class` on an edge line to the edge rather than the node, which would
      leave these two grey while every other entry/terminal node is amber.

- [ ] The `cycle closed` terminal reads as an amber pill labelled "cycle closed", not a plain box labelled `STOP`
      Where: bottom of the chart, after `branch, pushed branch, or PR`
      Why this is in doubt: `STOP` is referenced bare twice (from the audit branch and from the
      planning NO-GO edge) before the line that gives it its shape, label and class. Versions
      that fix a node's shape at first mention render the raw id in a default rectangle.

- [ ] The `implementer` node sits **inside** the "Execution — wave by wave" subgraph box
      Where: the EXECUTION subgraph  ·  How to get there: same view, find the boxed cluster
      Why this is in doubt: `IMPL` is first mentioned at root level (`A_PLAN --> IMPL`) before the
      subgraph declares it, and some Mermaid versions assign subgraph membership by first mention.

- [ ] The four mid-chain artifact nodes are green-filled, not default-grey
      Where: the `root-cause report`, `approved spec`, `wave plan` and `branch, pushed branch, or PR` nodes
      Why this is in doubt: they carry their class mid-chain (`DIAG --> A_DIAG[/"…"/]:::art --> BRAINSTORM`),
      a form whose class assignment some versions drop. Note `results report` is no longer one of
      them — a review round moved it to the end of its line — so it should be green either way;
      if it is grey while the four above are green, something else is wrong.

- [ ] Every parallelogram node is green, and every pill is amber — no artifact or terminal fell back to grey
      Where: whole diagram  ·  How to get there: sweep the chart once counting shapes against fills

- [ ] The loop arrow from `ranked findings document` back up to `/devcycle:cycle request` is followable
      Where: the dashed edge labelled "each finding you act on starts its own new cycle"
      Why this is in doubt: it is the only edge that runs against the top-down flow, and it spans
      almost the whole chart to reach the top entry node. A back-edge that long is what Mermaid
      routes worst — check it does not sweep across unrelated nodes, does not sit on top of
      another edge, and that a reader can trace where it starts and where it lands.

- [ ] All four labels leaving `ranked findings document` stay attached to their own arrow and stay readable
      Where: "in cycle — you pick findings to act on", "in cycle — nothing picked",
      "standalone — the audit stops here, it starts nothing", "each finding you act on starts its own new cycle"
      Why this is in doubt: four labelled edges leave one node, two of them long sentences. Labels
      that stack or overlap here destroy the in-cycle/standalone distinction the diagram exists to make.

- [ ] Both labels leaving `results report` stay attached to their own arrow and stay readable
      Where: "in cycle" and "standalone — ends at the report, no cycle to finish"

- [ ] Solid vs. dashed edges are visually distinguishable, and the dashed ones carry their labels
      Where: e.g. `/devcycle:continue` → Triage, and the "nothing renders — on-device skipped" edge

- [ ] The `/devcycle:audit` entry node shows its whole label including the `branch:name` token
      Where: top-left entry pills  ·  How to get there: read the node text character by character
      Why this is in doubt: the label holds two colons inside the quoted string and sits directly
      against the `:::entry` class suffix. A renderer that mis-splits on the colon truncates the
      label — and it would truncate at exactly the token this branch added.

- [ ] The Legend reads as a separate legend box, shows all seven rows, and does not overlap the flow
      Where: the LEGEND subgraph  ·  How to get there: same view, find the second boxed cluster
      Why this is in doubt: a review round added a seventh row; the box has to grow without
      colliding with the chart it sits beside.

- [ ] The legend's claim "arrow back up the flow = a loop" matches the picture
      Where: legend row 7, then the chart  ·  How to get there: read the row, then find the arrow it describes
      A reader who takes the legend at its word should be able to locate exactly one arrow running
      back up the flow. If they cannot find it, or find edges that look like it but aren't, the row misleads.

- [ ] The four node categories are told apart by something other than fill colour
      Where: legend rows 1–4 against the chart
      Why this is in doubt: artifact (parallelogram) and entry (pill) have distinct shapes, but
      "the orchestrator does this itself" and "dispatched to a fresh subagent" are both plain
      rectangles differing only in pastel blue vs. pastel red — a reader with red/green or
      blue/red colour deficiency cannot tell an orchestrator stage from a subagent stage.

- [ ] All four node fills stay legible in **dark** theme
      Where: whole diagram  ·  How to get there: GitHub profile → Settings → Appearance → Dark, reload the README
      Why this is in doubt: the `classDef` fills are pastel with a hardcoded `color:#111`, which GitHub's dark theme does not adjust.

- [ ] The diagram is readable on a narrow viewport rather than clipped
      Where: whole diagram  ·  How to get there: same page at ~400px wide, or on a phone

- [ ] Expanding the diagram shows the whole chart legibly
      Where: whole diagram  ·  How to get there: use GitHub's zoom/expand control on the rendered chart
      The chart is dense enough that the inline size may not be where it gets read. If GitHub
      offers no such control on this page, record that instead of checking the box.

- [ ] The prose under the diagram still reads as complete sentences
      Where: README.md, items 1, 2, 3 and 8 of "The pipeline"  ·  How to get there: read the numbered list under the diagram
      Five fragments were deleted when the diagram was added, because the diagram now states them:
      "Skipped when your input is already concrete" (1), "runs in place of scoping" and "Pick
      nothing and the cycle closes at the report" (2), "Skipped for features, refactors, and bugs
      whose cause is already known" (3), and "Skipped when nothing renders" (8). Confirm no
      sentence lost its subject or trails off.

- [ ] Item 2, the Audit paragraph, reads cleanly after being rewritten twice more
      Where: README.md, numbered item 2  ·  How to get there: read that paragraph aloud, start to finish
      Later review rounds rewrote this paragraph past the original trim: the `branch:<name>`
      sentence was reworded and rewrapped, and the eleven-fields sentence became a long em-dash
      aside ("— among them its `file:line` location, … a fix-effort estimate —"). Check the aside
      opens and closes, that no clause got doubled or orphaned across the rewrap, and that the
      paragraph still says what the diagram's audit branch shows.

- [x] (auto) `branch:<name>` renders literally everywhere it appears, angle brackets and all
      Where: numbered item 2, and the `/devcycle:audit` row of the "What's in the plugin" table
      Why this is in doubt: markdown eats an unbackticked `<name>` as an HTML tag and shows
      nothing. On the rendered page the token either reads `branch:<name>` or silently reads
      `branch:` — and only the rendered page shows which.

- [x] (auto) The "What's in the plugin" table renders as a table, with the `/devcycle:audit` row readable
      Where: README.md, "What's in the plugin"  ·  How to get there: scroll past the numbered list
      That row was rewritten into a long semicolon-joined sentence; check the cell wraps rather
      than pushing the table into a horizontal scroll that hides the right-hand column.

## Walkthrough outcome

Walked 2026-07-28 against the branch pushed to GitHub. Three items closed — one human verdict
and two `(auto)` from DOM reads of the main document. The remaining eighteen, every one of them
a diagram observation, were **waived by the user**, who judged the diagram fine as it stands.
Unchecked boxes below mean nobody looked, not that anything failed. Details, including why no
diagram item could ever have been `(auto)`-checked, are in `on-device-results.md` beside this
file.

## Not verifiable here

The eight behavioral scenarios covering this branch's audit and on-device work — the five in
`tests/scenarios/auditing-a-repo/` (`branch-scope-derivation`, `criteria-interview`,
`finding-format`, and `frontier-reporting` and `branch-name-validation`, the last two written
during the review rounds) and the three in `tests/scenarios/verifying-on-device/`
(`checklist-shape`, `diff-derived-checklist`, `no-script-checkoff`) — have no model run against
the skill text as it now stands.

Six of them have never been run at all: the harness needs a fresh, credentialed
`CLAUDE_CONFIG_DIR` holding only auth, and on this machine that config answers `Not logged in`,
while a run in the real config directory would load the installed devcycle plugin and
contaminate the baseline. Their red baselines are established by text inspection of the
pre-change commit, not by a model run. The remaining two, `checklist-shape` and
`no-script-checkoff`, do carry real red and green runs from 2026-07-22 — but against the skill
text as it stood then; their regression sections for this branch's changes are recorded as not
yet run.

So whether a real agent run emits eleven fields per finding, expands a branch scope past the raw
diff, rejects a branch name with shell metacharacters, reports the frontier instead of silently
truncating, or builds a checklist from a diff for a branch it never planned, is unproven by this
branch. That is a carry-over, not an item a human can check off here.
