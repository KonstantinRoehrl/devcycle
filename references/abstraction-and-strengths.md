# Abstraction and strengths — the longitudinal criterion and the strengths rule

Two criteria only whole-scope reviews and `/devcycle:maintain` apply; split from
`references/quality-criteria.md` so planning, which reads that catalog on every cycle, no longer
loads them. This file is the single owner of the Strengths rule.

## Abstraction — does an existing abstraction still earn its complexity

Distinct from `references/quality-criteria.md` § Reuse before rebuild (write-time reuse of
existing components) and from "architecture and separation of concerns" (whether today's layering
is sound): this criterion asks whether an **existing** abstraction — a module, interface, wrapper,
or layer already in the tree — still earns its complexity **over time**. It is the longitudinal
question `/devcycle:maintain` adds; `/devcycle:review` may also select it for a single-shot audit.

Two hypotheses are tested against each candidate:

- **H1 — unnecessary:** it forwards without adding policy, has one implementation and one consumer,
  isolates no volatility, protects no invariant. Its complexity is not paid for.
- **H2 — justified:** it centralizes a shared policy, backs several implementations or consumers,
  isolates a volatile dependency, protects an invariant, points dependencies the right way, or
  earns its seam through testing value or a history of convergence.

Weigh H1 against H2 on this evidence: consumer count, implementation count, shared policy,
protected invariants, volatility isolation, dependency direction, testing value, and historical
convergence.

**The deletion test — perform it, don't just reason about it.** Imagine the module removed and its
logic inlined at every call site. If the calling code's total complexity *vanishes* with it, that
is evidence for H1 (a pass-through — `REMOVE`/`SIMPLIFY`). If the same complexity *reappears*,
redistributed across every caller instead of centralized, that is evidence for H2 (`KEEP` — the
abstraction was doing real work). This is a mechanical technique the lens actually runs, giving each
verdict a specific, checkable justification rather than an impression.

**Outcomes:** `KEEP | WATCH | SIMPLIFY | REMOVE | CONSOLIDATE`. **`KEEP` with a stated justification is a successful analysis, not a null result** — learning which abstractions
have earned their keep matters as much as which have not. The lens must be structurally unable to
develop an anti-abstraction bias: a candidate that survives the deletion test is reported as a
defended `KEEP`, carrying the same weight a `REMOVE` does.

**Historical convergence is corroborating evidence, not a precondition.** At `standard` maintenance
depth no history agent runs (`references/config.md` § The profile); the lens then reasons from
consumer/implementation/invariant evidence alone and **states in the finding that historical
evidence was not available**, the same "state what wasn't checked" discipline the audit stage uses.
At `thorough` depth the history inspector's churn and convergence signal feeds this evidence
directly.

**Vocabulary hygiene.** Findings from this criterion name the same shape of thing the same way every
time — `module`, `interface`, `implementation`, `seam`, `adapter` — never a different generic term
(`component`, `service`, `boundary`) per finding, so a report stays comparable across candidates,
the same reason `culprits.json` keeps a stable vocabulary for friction patterns.

Measured against: `references/quality-criteria.md` (the repo's convention owner for what a review
measures against). No dedicated agent — this is judgment over evidence a generic read-only reviewer
already gathers.

## Strengths — not only defects

`playbooks/reviewing-code.md`'s own charter asks *what is wrong with this code* — every criterion
in `references/quality-criteria.md`, and the whole findings vocabulary in `references/findings.md`,
is built to answer that one question. **Abstraction**, above, already proves this is incomplete on
its own: a `KEEP` verdict, reached by the same deletion test as a `REMOVE`, is named there as "a
successful analysis, not a null result" precisely because an audit that only ever reports what to
change trains its reader to distrust everything it doesn't mention. That precedent generalizes to
every criterion in `references/quality-criteria.md`, not only Abstraction — a review is asked to
find what to change, but a repo's durable knowledge is not just its defect list.

Concretely: any lens, on any criterion in `references/quality-criteria.md` or this file, may
surface a **strength** — a pattern that concretely and measurably does the right thing, to the same
evidentiary bar a defect finding would need (a traced `file:line`, not an impression) — alongside
its defects. This is not a consolation prize for a lens that found nothing wrong, and it is not
softening: a lens still reports every defect it finds at full severity. A strength is additive, reported through
`findings.md`'s own `## Strengths` shape, which is deliberately lighter than the severity-ordered
defect list and never dilutes, delays, or substitutes for it.

Reported this way, a strength earns its place the same way a promoted lesson does in
`docs/devcycle/lessons.md` — it doesn't just note something wasn't wrong, it names a pattern
future work should replicate. An audit that finds a stack's error-handling convention unusually
disciplined, or a caching layer that legitimately earns its complexity, has found something a
team should keep doing on purpose — not just the absence of a problem.
