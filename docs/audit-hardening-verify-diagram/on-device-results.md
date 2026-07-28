# On-device results: audit hardening, on-device branch mode, pipeline diagram

Walked on 2026-07-28 against `feat/audit-hardening-verify-diagram` at `92bf34c`, pushed to
origin so GitHub's own renderer — the surface under test — could be used. Page:
`https://github.com/KonstantinRoehrl/devcycle/blob/feat/audit-hardening-verify-diagram/README.md`.
Engine: claude-in-chrome, driving the user's own Chrome.

The walkthrough was stopped after item 1 by the user, who judged the diagram acceptable as it
stands. The 18 diagram items below are therefore **waived, not verified** — nobody looked at
them, and this report does not claim they pass.

## Verified

- Diagram draws as a flowchart, not an "Unable to render rich display" error box: **passed** —
  human verdict on the rendered page; boxes, arrows and labels present.
- `branch:<name>` renders literally, angle brackets and all: **passed (auto)** — rendered text
  read from the DOM in both places it appears. Numbered item 2 reads "a `branch:<name>` token
  scopes it to one branch"; the plugin table's `/devcycle:audit` row reads "a `branch:<name>`
  token — not a bare argument — scopes it to that branch's diff". Markdown did not eat the
  angle brackets in either.
- "What's in the plugin" table renders as a table with the `/devcycle:audit` row readable:
  **passed (auto)** — it is a real `<table>` with `scrollWidth == clientWidth` (1012 = 1012),
  so the row wraps rather than pushing the table into a horizontal scroll that would hide the
  right-hand column; the row's full text is present in the DOM.

## Waived by the user — unverified

Items 2–19 of the checklist, all of them observations only a human on the rendered page can
make: the two standalone amber terminals, the `cycle closed` terminal's shape and label, the
`implementer` node's subgraph membership, the four mid-chain artifact fills, the
parallelogram/pill fill sweep, the long loop back-edge, the four labels leaving
`ranked findings document`, the two leaving `results report`, solid-vs-dashed distinction, the
`/devcycle:audit` entry node's full label, the legend box and its seven rows, the legend's
loop-arrow claim, telling the four node categories apart without relying on fill colour, dark
theme legibility, narrow-viewport readability, the expand control, and the prose under the
diagram (numbered items 1, 2, 3 and 8, plus the twice-rewritten audit paragraph).

The accessibility item is worth naming separately as a known unclosed question rather than a
mere skip: "the orchestrator does this itself" and "dispatched to a fresh subagent" are both
plain rectangles distinguished only by pastel blue vs. pastel red, so a reader with a red/green
or blue/red colour deficiency has nothing else to go on. That was raised by the checklist and
has not been looked at.

## Tooling note

Screenshot capture was unusable on this page: every `Page.captureScreenshot` timed out after
30s against the 2538px-tall sandboxed Mermaid frame (six attempts). DOM reads and scrolling
worked throughout. Structural reads of the diagram itself were impossible for a second,
independent reason — GitHub renders Mermaid inside a cross-origin
`viewscreen.githubusercontent.com` frame whose source arrives by postMessage, so no diagram
item could have been `(auto)`-checked even with screenshots working. The two `(auto)` items
above are main-document text, outside that frame.
