# Quality criteria — catalog, precedence, and seed index

The single owner of what any devcycle review or plan measures against, and where those
standards come from. `${CLAUDE_PLUGIN_ROOT}/playbooks/reviewing-code.md` reads it at discovery
and again when it builds review lenses, and `${CLAUDE_PLUGIN_ROOT}/playbooks/planning-waves.md`
reads it when it derives a plan's quality constraints — neither restates it. Nothing here
chooses criteria: at an audit the user does, at that playbook's criteria interview, and
planning filters by the confirmed scope.

## Precedence

Binding, and cited per finding:

1. **The repo's own documented convention** — `CONTRIBUTING.md`, `ARCHITECTURE.md`,
   `CLAUDE.md` / `AGENTS.md`, ADRs, style guides, linter/formatter/CI config. A repo that
   has decided something outranks generic advice that disagrees, including advice that is
   more fashionable.
2. **The vendor's or project's current official documentation** for the stack in question.
3. **Community standards** with broad adoption.
4. **Anything else** — a blog post, a remembered rule of thumb — the weakest source, and
   named as such when it is the only one.

Every finding names what it is measured against: a repo convention, or a named external
source. **A finding measured against neither is an unsupported opinion and is not reported.**

## Universal criteria

Apply regardless of stack:

- correctness and logic errors, edge cases, off-by-ones, null/undefined handling;
- dead, unreachable, bloated, or undocumented code;
- docs-vs-reality drift — documentation that exists and is wrong: a README flag, endpoint,
  or setup step the code no longer honours (distinct from undocumented code above, which is
  documentation that is missing);
- duplication vs. reuse;
- architecture and separation of concerns — layering violations, leaked responsibilities,
  and boundaries crossed by code that should not know what is on the other side;
- error handling and failure modes — swallowed exceptions, missing retries or timeouts
  where warranted, inconsistent error shapes;
- concurrency and race conditions;
- resource leaks;
- performance — algorithmic complexity, avoidable work on hot paths, chatty or repeated
  I/O, unbounded growth; universal, so a stack the anchors below do not enumerate is still
  audited for it;
- security — input validation, the injection classes relevant to the stack, authz/authn
  boundaries, secrets in code or config, unsafe deserialization, vulnerable dependencies;
- data contracts, including migration and versioning safety;
- config and environment handling;
- testing coverage *and* whether the existing tests are meaningful;
- accessibility, for any UI in scope;
- observability — logging quality, error traceability, adherence to the observability
  stack already in use;
- dependency health;
- token and context cost, wherever a repo's content is read by an agent — prompts, skills,
  instruction files: restated content, context loaded wholesale for a narrow decision,
  duplication across files that then has to be kept in sync;
- conformance to the project's own stated conventions — the documents in Precedence rule 1
  above, audited as a subject rather than only used as a yardstick.

## Stack-specific anchors

Derived per detected stack, never assumed. The examples below are illustrative anchors,
**explicitly not an exhaustive list** and not a menu to pick from — a stack absent here still
gets its own criteria, derived from its own conventions and official documentation:

- **ML / data science** — data leakage between train and evaluation, reproducibility
  (seeds, pinned data versions, deterministic pipelines), silent label/schema drift.
- **iOS / macOS** — main-thread violations, retain cycles, lifecycle correctness.
- **.NET** — DI lifetimes, sync-over-async, EF Core N+1 queries.
- **C / C++** — memory safety, ownership, bounds, undefined behavior.
- **Python** — typing coverage and honesty, packaging and dependency pinning.

## Reuse before rebuild

Library-provided functionality is preferred over a custom implementation absent a documented
reason, and new code reuses the repo's existing reusable components — a file-access component,
an image-upload flow, an existing client wrapper — rather than re-implementing similar logic
beside them. **Failure to reuse is a forbidden pattern: every instance is flagged**, with the
existing component the new code should have used named by path.

## Abstraction — does an existing abstraction still earn its complexity

Distinct from **Reuse before rebuild** above (write-time reuse of existing components) and from
"architecture and separation of concerns" (whether today's layering is sound): this criterion asks
whether an **existing** abstraction — a module, interface, wrapper, or layer already in the tree —
still earns its complexity **over time**. It is the longitudinal question `/devcycle:maintain`
adds; `/devcycle:review` may also select it for a single-shot audit.

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

Measured against: this catalog (the repo's convention owner for what a review measures against). No
dedicated agent — this is judgment over evidence a generic read-only reviewer already gathers.

## Strengths — not only defects

`playbooks/reviewing-code.md`'s own charter asks *what is wrong with this code* — every criterion
above, and the whole findings vocabulary in `references/findings.md`, is built to answer that one
question. **Abstraction**, above, already proves this is incomplete on its own: a `KEEP` verdict,
reached by the same deletion test as a `REMOVE`, is named there as "a successful analysis, not a
null result" precisely because an audit that only ever reports what to change trains its reader to
distrust everything it doesn't mention. That precedent generalizes to every criterion in this
catalog, not only Abstraction — a review is asked to find what to change, but a repo's durable
knowledge is not just its defect list.

Concretely: any lens, on any criterion above, may surface a **strength** — a pattern that
concretely and measurably does the right thing, to the same evidentiary bar a defect finding
would need (a traced `file:line`, not an impression) — alongside its defects. This is not a
consolation prize for a lens that found nothing wrong, and it is not softening: a lens still
reports every defect it finds at full severity. A strength is additive, reported through
`findings.md`'s own `## Strengths` shape, which is deliberately lighter than the severity-ordered
defect list and never dilutes, delays, or substitutes for it.

Reported this way, a strength earns its place the same way a promoted lesson does in
`docs/devcycle/lessons.md` — it doesn't just note something wasn't wrong, it names a pattern
future work should replicate. An audit that finds a stack's error-handling convention unusually
disciplined, or a caching layer that legitimately earns its complexity, has found something a
team should keep doing on purpose — not just the absence of a problem.

## Multi-file feature chains

For any non-trivial feature, map the full chain — entry point → state → API/service layer →
persistence — and verify the interaction across it. A finding about a feature names the whole
chain, not one file in isolation: an isolated read of one file cannot see the defects that
live between files.

## Data contracts

Datatypes are verified across every boundary they cross. Where a frontend and a backend exist,
DTOs are verified against the actual endpoints **and** against the database schema — not merely
against each other, which agrees happily while both disagree with the data. A mismatch anywhere
along that chain is a finding.

## Accessibility

Whenever the scope contains a UI, concretely: semantic markup and roles, keyboard navigation,
focus management, color contrast, screen-reader labeling. "Consider accessibility" is not a
finding.

## Seed best-practice index

A starting point for external sourcing, non-exhaustive by design. **If a link has moved, 404s,
or is visibly stale, find the current authoritative version rather than citing the dead one** —
and cite what you actually read.

- **Web / frontend** — MDN Web Docs; the WAI-ARIA Authoring Practices Guide; WCAG 2.2; the
  framework's own current docs (React, Vue, Angular, Svelte).
- **Backend / API** — the OWASP Top Ten and the OWASP Cheat Sheet Series; the language's
  official style and packaging guides; the framework's own deployment and security docs.
- **Databases** — the engine's own manual for indexing, isolation levels, and migration
  safety.
- **Mobile** — Apple's Human Interface Guidelines and Swift API Design Guidelines; Android's
  app architecture and quality guidelines.
- **ML** — the framework's reproducibility guidance (PyTorch, TensorFlow, scikit-learn) and
  the project's own model-evaluation docs.
- **Infrastructure / CI** — the provider's well-architected guidance; the CI platform's
  security hardening guide.

## When web tools are unavailable

The audit still runs: repo conventions plus this seed index are enough for a real sweep. Record
the limitation in the coverage statement, naming which confirmed criteria were measured against
the seed alone rather than against a source verified live. Never silently degrade — an audit
that could not check current guidance and does not say so reads as one that did.

## Forward use

How this catalog reaches the stages that write code, rather than only the ones that judge code
afterwards.

- **Filter by scope.** `${CLAUDE_PLUGIN_ROOT}/playbooks/planning-waves.md` selects only the
  criteria that apply to the stacks the confirmed scope actually contains and to the areas
  `.devcycle/scope.md` names. The whole catalog is never carried forward.
- **Per-task excerpt.** An implementer brief carries only the constraint lines whose subject
  that task's own `**Files:**` touch — never the catalog, and never another task's lines.
- **Name the source.** Every constraint derived from this file names what it is measured
  against, per Precedence above. A constraint with no named source is an unsupported opinion
  in a plan exactly as it is in a finding.
- **The cost rule.** This catalog is long, and "token and context cost" is one of its own
  universal criteria. Splicing it wholesale into a brief, a plan, or a skill load is the
  anti-pattern it names.
