# On-device checklist contract

The single owner of what an on-device checklist is: whether a branch needs one, where it lives,
what its header and items look like, which dimensions it covers, how each item closes, how the
app is launched for the walk, and the verdicts the walk records.
`playbooks/executing-waves.md` generates one mid-wave from the plan; `playbooks/verifying-on-device.md`
generates one from a branch diff and walks either. Every surface that generates, walks or skips a
checklist names this file, and none restates it.

## Applicability

Whether anything the branch changed renders. Rendered means visual UI only: the pages, screens
and components a browser or device displays. CLI and TUI output, plugin command and prompt text,
APIs, CI, tests, docs and internal refactors do not render.

- **The trace.** Start from the branch's changed files, derived per `references/branch.md`
  § Deriving a branch's file set. Trace routes, navigation and component usage outward (which
  screens render these components, which routes reach those screens), repeating until an
  iteration pulls in no new surface. Items are written against those surfaces, not against the
  changed files: a diff in a shared component is verified wherever it renders.
- **The conservative rule.** A file whose effect on visual output the diff cannot rule out counts
  as rendered: shared styles, theme tokens, build or bundler config, asset pipelines, templates,
  i18n strings. Any doubt counts as rendered.
- **The result** is `renders`, or `nothing renders (<reason>)`, where the reason names what the
  diff touched (e.g. `only .github/workflows/*, README.md`). Nothing renders means no checklist.

## Paths

- **Plan-derived (in-cycle)** — `docs/<feature>/on-device-checklist.md` in the target repo.
  The path is pinned because `playbooks/reviewing-the-branch.md`'s handoff consumes it. Record it
  in the `checklist:` field of `.devcycle/state.md`. A checklist the on-device stage generates
  diff-derived in-cycle, because branch review's trace found a rendered surface while the field
  read `none`, takes this path and this record too.
- **Diff-derived (standalone `/devcycle:verify`)** — `.devcycle/on-device-checklist-<branch-slug>.md`,
  where `<branch-slug>` is the branch name with every character outside `[A-Za-z0-9._-]`
  replaced by `-` (`feat/csv export` → `feat-csv-export`). Scratch for the run: never
  committed. Where else a standalone run may record this path is
  `playbooks/verifying-on-device.md`'s rule, not this file's.
- **Results report (in-cycle)** — `docs/<feature>/on-device-results.md`, beside the checklist, so
  it derives from the `checklist:` path and needs no state-file row. `scripts/on-device-routing.mjs`
  reads it there.

## Checklist header

A checklist opens with two header lines, above its first item:

```markdown
Launch: <exact command(s) that start the app, run from the repo root>
Ready: <a check that the app is up: a URL that must answer, or a log line to wait for>
```

An item whose launch differs carries its own `Launch:` and `Ready:` lines. A generator that
cannot name the command writes `Launch: none (<why>)` rather than guess one.

## Item shape

Every item is an UNCHECKED box naming one concrete outcome a human can observe on the running
app. No item is pre-checked and no item carries `(auto)` at generation time. Items are
concrete and user-verifiable — never "looks good", never a code-level assertion.

```markdown
- [ ] <one concrete observable outcome>
      Tier: <structural | agent-observable | needs-eyes>
      Where: <route / screen / module>  ·  How to get there: <click path from app root>
      Feasibility: <what it needs>
```

`Tier:` is required on every item, set by the generator per § Tiers. The two navigation fields
are **optional** for plan-derived items, where the plan and the implementation conversation
already supply that context, and **required** for diff-derived
ones, where no plan exists to imply them: a walkthrough of someone else's branch cannot start
without being told where to look. `Feasibility:` is optional: an item that needs something the
walkthrough machine may not have (a physical device, a second account, a specific browser, a
paid service) names it, so the walk can offer to waive it up front instead of failing it midway.

Every axis of the spec's or plan's verification matrix (widths, aspect ratios, themes,
platforms) is its own item. No "check responsive" catch-all.

## Dimensions

Cover every dimension applicable to the change:

- visual rendering vs intent
- layout / alignment / spacing
- interaction feel (drag, hover, focus)
- responsive behavior at real breakpoints
- theme parity, where the surface supports themes
- keyboard / accessibility
- empty / loading / error states
- animation timing

## Tiers

The tier decides how an item closes:

| Tier | What the item asserts | How it closes |
| --- | --- | --- |
| `structural` | DOM structure, CSS values, or exact text on a page | the driver reads it; with fresh output showing the assertion holds, the coordinator ticks it `(auto: .devcycle/evidence/<file>)`, no human answer |
| `agent-observable` | an outcome the driver sees without pixels or feel that is not a pure DOM/CSS/text assertion: a request fired, a clean console, a navigation landing on the right route, state surviving a reload | the agent proposes a verdict with its evidence; the human confirms or overrides it in ONE batched answer |
| `needs-eyes` | visual rendering, alignment, contrast, interaction feel, animation, anything display-dependent | one question per item |

- **Tagging moves only toward the human.** The walk may demote an item (`structural` →
  `agent-observable` → `needs-eyes`) when the observation proves weaker than its tag assumed,
  such as a colour claim that depends on display gamut. It never promotes one.
- **`(auto)` means passed, never failed.** A `structural` read that contradicts its item is not
  ticked: it goes into the batch as a proposed `FAILED` with a proposed severity.
- **`structural` is exactly the predicate of § The `(auto)` boundary**, and its tick names the
  evidence file under `.devcycle/evidence/` that showed it.
- **A confirmed batch verdict is a human verdict**, marked `(confirmed from batch)`.

## The `(auto)` boundary

```
A SCRIPT OR SCREENSHOT NEVER CHECKS OFF A CHECKLIST ITEM.
```

One exception, keyed to an observable predicate: an item asserting DOM structure, CSS values,
or exact text that a structural browser check has verified, fresh output in hand, may be
checked off with the tag `(auto)`. The intended engine is claude-in-chrome — it navigates,
screenshots, and reads the DOM/CSS/text/network of a page in the user's own Chrome, so the
user can hand the agent an already-authenticated session, which a separate browser context
(e.g. Playwright's) cannot do without re-authenticating. When claude-in-chrome is not
available, nothing is auto-checked: every item stays a human item. Everything a browser check
cannot structurally see (feel, smoothness, visual alignment, contrast, legibility) stays
unchecked for the human.

| Rationalization | Reality |
|---|---|
| "claude-in-chrome confirmed the page" | A structural read covers only DOM/CSS/text — check off exactly those items, `(auto)`-tagged, nothing more |
| "The screenshot looks right" | A screenshot cannot show jank, focus order, interaction feel, or a breakpoint reflow |
| "We're behind schedule" | Pressure does not convert human items into script items |
| "The code clearly implements it" | Rendered outcome and code intent diverge exactly often enough to need this checklist |

## Launch contract

The coordinator launches the app under every `onDeviceGate` value; the driver never launches.

- **Launch.** Before the agent pass, start the header's `Launch:` command(s) as background
  processes, exactly as written, and record each one in `.devcycle/on-device-launch.json`, so a
  resumed or later session can find and stop it. `Launch: none (<why>)` starts nothing and goes
  straight to the fallback.
- **Ready.** Poll the header's `Ready:` check with a bounded timeout. The driver is dispatched
  only once it passes.
- **Teardown.** At stage end, whether complete, blocked or stopped for a user decision, stop every
  recorded process and remove the record. A session that finds a record an earlier session left
  stops those processes before it launches again.
- **Fallback.** A launch that fails or never becomes ready is reported with its output; the
  human starts the app, and the walk continues.
- **Boundaries.** Never install dependencies or change the repo to make a launch work. The driver
  keeps its Bash rule (read state, never write git), so the launched processes have one owner.

## Verdicts

The results report records each item's verdict verbatim from this set:

- `passed`
- `FAILED`, with severity `high`, `medium` or `low`
- `waived`, with its reason
- `unverified`: `auto-ok` residue, or a `Feasibility:` item nobody could run

Two markers qualify a verdict: `(auto: <evidence path>)` on a `structural` item the coordinator
ticked, and `(confirmed from batch)` on a proposed verdict the human confirmed.

Each report line opens with `#<n>`, the item's 1-based position in the checklist, which ledger
decisions join on. A re-walk after a fix round keeps the line and rewrites its verdict to
`passed (re-walk, round <n>)`, or leaves it `FAILED`.
