# On-device checklist — audit hardening, on-device branch mode, pipeline diagram

Generated during execution per `references/checklist.md`. The rendered surface this branch
produces is the Mermaid pipeline diagram in `README.md` — GitHub renders it server-side, and
nothing in this repo can verify it: `scripts/validate.mjs` proves the fence is balanced and
stops there, so a Mermaid syntax error ships green.

The "app" here is GitHub's own markdown rendering. Open the branch's `README.md` on
github.com — not a local preview, whose Mermaid version differs from GitHub's.

## Items

- [ ] The diagram draws as a flowchart, not a `Unable to render rich display` error box
      Where: README.md, "The pipeline" section  ·  How to get there: open the branch on github.com, scroll to "The pipeline"

- [ ] The `implementer` node sits **inside** the "Execution — wave by wave" subgraph box
      Where: the EXECUTION subgraph  ·  How to get there: same view, find the boxed cluster
      Why this is in doubt: `IMPL` is first mentioned at root level (`A_PLAN --> IMPL`) before the
      subgraph declares it, and some Mermaid versions assign subgraph membership by first mention.

- [ ] The four mid-chain artifact nodes are green-filled, not default-grey
      Where: the `root-cause report`, `approved spec`, `wave plan` and `results report` nodes
      Why this is in doubt: they carry their class mid-chain (`DIAG --> A_DIAG[/"…"/]:::art --> BRAINSTORM`),
      a form whose class assignment some versions drop.

- [ ] Solid vs. dashed edges are visually distinguishable, and the dashed ones carry their labels
      Where: e.g. `/devcycle:continue` → Triage, and the "nothing renders — on-device skipped" edge

- [ ] The Legend reads as a separate legend box and does not overlap the flow

- [ ] All four node fills stay legible in **dark** theme
      Where: whole diagram  ·  How to get there: GitHub profile → Settings → Appearance → Dark, reload the README
      Why this is in doubt: the `classDef` fills are pastel with a hardcoded `color:#111`, which GitHub's dark theme does not adjust.

- [ ] The diagram is readable on a narrow viewport rather than clipped
      Where: whole diagram  ·  How to get there: same page at ~400px wide, or on a phone

- [ ] The trimmed prose under the diagram still reads as complete sentences
      Where: README.md, items 1, 2, 3 and 8 of "The pipeline"  ·  How to get there: read the numbered list under the diagram
      Five fragments were deleted because the diagram now states them; confirm no sentence lost its subject or trails off.

## Not verifiable here

The five behavioral scenarios this branch adds (`branch-scope-derivation`, `finding-format`,
`diff-derived-checklist`, and the updates to `criteria-interview` and `checklist-shape`) are
written but **unrun** — the harness needs a credentialed isolated `CLAUDE_CONFIG_DIR` that is
not available on this machine. Whether a real agent run actually emits eleven fields, expands a
branch scope past the raw diff, or leaves another cycle's state file alone is therefore
unproven by this branch. That is a carry-over, not an item a human can check off here.
