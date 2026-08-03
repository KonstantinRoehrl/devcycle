# Scenario: severity-ranking-and-actionability
- Skill under test: devcycle:doctor
- Type: output-shape

Does doctor rank findings by severity (not dollars), offer skip/issue/cycle-entry-point
per finding, and produce one systemic recommendation when two findings share a root
cause?

## Setup

Two synthetic transcript sessions under a sandboxed `~/.claude/projects/` fixture:
- `sess-v091.jsonl` — 3 turns attributed to `devcycle:planning-waves`, plugin path
  `.../devcycle/devcycle/0.9.1/...`, median cost $0.40.
- `sess-v092.jsonl` — 3 turns attributed to `devcycle:planning-waves`, plugin path
  `.../devcycle/devcycle/0.9.2/...`, median cost $0.95 (a real regression vs. the 0.9.1
  cohort) — plus one turn on an unpriced model `claude-haiku-4-1` in the same session,
  sharing the same root cause note ("0.9.2's planning stage under-specifies its research
  dispatch model").

## Pass criteria

1. **Ranked by severity, dollars secondary.** The regression finding's severity
   (critical/high/medium/low per `references/findings.md`) determines its position in
   the list; the dollar figure appears as a supporting field on the finding, not as the
   sort key.
2. **The version regression is named with both versions and the delta.** The report
   states `0.9.1` → `0.9.2` and the percentage/dollar delta.
3. **Actionability is offered and skippable.** One batched multi-select question offers
   skip / draft-issue / cycle-entry-point per finding, plus an explicit "just the
   overview, no action" option.
4. **A cycle-entry-point choice returns a one-line request string** — doctor does not
   itself invoke `/devcycle:cycle`.
5. **One systemic recommendation ties the regression and the unpriced-model finding
   together**, naming the shared root cause rather than listing them as two unrelated
   items.
6. **The report is persisted** at `.devcycle/doctor/<today>-report.md`.

## Baseline (red)

Not yet run — requires the credentialed isolated-session protocol
`CONTRIBUTING.md` documents, and (per this repo's existing `tests/scenarios/doctor/`
precedent) a sandboxed `$HOME` beyond `CLAUDE_CONFIG_DIR`. Expected red: pre-Task-9
`skills/doctor/SKILL.md` has no severity vocabulary, no actionability step, and no
persisted-artifact behavior — the report would rank by dollars alone and end at the
ranked list with no follow-up offered.

## Result (green)

Not yet run — same blocker. What would prove it: the run above against the
working-tree skill/command text, checked against criteria 1-6.
