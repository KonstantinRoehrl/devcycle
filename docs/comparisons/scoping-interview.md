# Comparison memo: scoping-interview vs superpowers:brainstorming

- Upstream read live: `~/.claude/plugins/cache/superpowers-marketplace/superpowers/6.1.1/skills/brainstorming/SKILL.md` (v6.1.1, read 2026-07-22).
- Verdict: **build** — the interview discipline (batched questions, hard stop, follow-up cap, `<tbd>` markers) has no upstream counterpart; upstream explicitly mandates the opposite questioning style. The skill is a pre-stage in front of brainstorming, not a replacement for it.

## (a) What upstream already covers (referenced, never restated)

The plugin skill defers to these upstream sections by reference:

- The HARD-GATE against any implementation action before a presented, approved design — and the "this is too simple to need a design" anti-pattern.
- Scope assessment and decomposition of oversized multi-subsystem requests.
- Proposing 2–3 approaches with trade-offs and a recommendation.
- Presenting the design in sections with incremental approval; writing the spec to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`; spec self-review; the user review gate.
- The visual companion for genuinely visual questions.

None of that is duplicated: design exploration, approach selection, and spec writing stay entirely upstream. `devcycle:scoping-interview` only establishes *what is being asked* before that process starts.

## (b) What scoping-interview adds (§12.4 — this is the skill's entire content)

1. **Research before questions.** Read the relevant code/docs first so every question is informed by what the repo already shows; never ask what the repo can answer. (Upstream has a related "explore project context" checklist step *inside* brainstorming; the delta is that §12.4 makes it a binding precondition of the scoping pre-stage's questions — the skill states its own version for its own stage rather than referencing a step of a process that has not started yet.)
2. **Batched questioning.** Questions go out via AskUserQuestion, 1–4 per call, each with concrete options plus Other — never trickled one-per-message.
3. **Summary confirmation in slot 1** of the first batch: the agent's one-paragraph reading of the request, to confirm or correct before anything else.
4. **Hard STOP after asking.** No drafting, no assumed answers, no continuing analysis until the user answers.
5. **At most ONE follow-up round**, and only when an answer changes scope or invalidates prior research.
6. **Explicit `<tbd>` markers** for remaining unknowns — never silently defaulted.
7. **Exemption:** small reversible implementation choices are decided, not asked.
8. **P2 handoff** into `superpowers:brainstorming` as the required final output of the stage (Context action: Continue, per the §4 lifecycle table).

## (c) Conflicts and resolutions

1. **Batching vs one-question-at-a-time (the KNOWN CONFLICT).** Upstream instructs "ask questions one at a time to refine the idea" and lists "**One question at a time** — Don't overwhelm with multiple questions" as a key principle. §12.4 mandates the opposite: batched AskUserQuestion, 1–4 per call, not trickled. The dossier flags this explicitly (§11): *"Pre-stage + KNOWN CONFLICT: superpowers asks one question at a time; the user's standard is batched AskUserQuestion (1–4 with options). Resolution direction: scoping-interview batches; do not modify upstream brainstorming, but the /cycle instructions may note the user's batching preference carries into the brainstorm stage. Compare and settle explicitly."* Settled per the approved design spec (D8), verbatim: *"**Interview batching:** plugin skills batch via AskUserQuestion (1–4 questions + options + Other); upstream `superpowers:brainstorming` is not modified; `/devcycle:cycle` notes that the batching preference carries into the brainstorm stage."* Concretely: our skills batch; upstream brainstorming ships untouched; `commands/cycle.md` carries the batching preference into the brainstorm stage as a note layered on top of the upstream skill.
2. **Post-brainstorm transition.** Upstream brainstorming's terminal state is invoking `superpowers:writing-plans`. In the devcycle pipeline the next stage is `devcycle:planning-waves` (which itself layers on upstream writing-plans). *Resolution:* not scoping-interview's concern — the skill hands off *into* brainstorming and stops; `commands/cycle.md` owns the stage walk and directs the post-brainstorm transition to `devcycle:planning-waves`.
3. **Overlapping clarifying questions.** Both skills interview the user, risking a double interrogation. *Resolution:* scoping-interview settles scope, intent, and constraints of the raw request and hands brainstorming a confirmed scope summary plus open `<tbd>` items as explored context; brainstorming's questioning then targets design refinement, not re-establishing scope. The boundary is recorded in the skill's handoff instructions.
