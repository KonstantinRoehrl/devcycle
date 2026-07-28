# Audit criteria — catalog, precedence, and seed index

The single owner of what an audit measures against and where those standards come from.
`devcycle:auditing-a-repo` reads this at discovery and does not restate it. Nothing here
chooses criteria: the user does, at the skill's step 1. This file supplies the proposal's
raw material and the rules for sourcing it.

## Precedence

Binding, and cited per finding:

1. **The repo's own documented convention** — `CONTRIBUTING.md`, `ARCHITECTURE.md`,
   `CLAUDE.md` / `AGENTS.md`, ADRs, style guides, linter/formatter/CI config. A repo that
   has decided something outranks generic advice that disagrees, including advice that is
   more fashionable.
2. **The vendor's or project's current official documentation** for the stack in question.
3. **Community standards** with broad adoption.
4. **Anything else** — a blog post, a remembered rule of thumb — which is the weakest source
   and is named as such when it is the only one.

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

Derived per detected stack, never assumed. The examples below are illustrative anchors for
what "stack-specific" means, **explicitly not an exhaustive list** and not a menu to pick
from — a stack absent here still gets its own criteria, derived from its own conventions
and official documentation:

- **ML / data science** — data leakage between train and evaluation, reproducibility
  (seeds, pinned data versions, deterministic pipelines), silent label/schema drift.
- **iOS / macOS** — main-thread violations, retain cycles, lifecycle correctness.
- **.NET** — DI lifetimes, sync-over-async, EF Core N+1 queries.
- **C / C++** — memory safety, ownership, bounds, undefined behavior.
- **Python** — typing coverage and honesty, packaging and dependency pinning.

## Reuse before rebuild

Library-provided functionality is preferred over a custom implementation absent a
documented reason, and new code reuses the repo's existing reusable components — a
file-access component, an image-upload flow, an existing client wrapper — rather than
re-implementing similar logic beside them. **Failure to reuse is a forbidden pattern:
every instance is flagged**, with the existing component the new code should have used
named by path.

## Multi-file feature chains

For any non-trivial feature, map the full chain — entry point → state → API/service layer
→ persistence — and verify the interaction across it. A finding about a feature names the
whole chain, not one file in isolation: an isolated read of one file cannot see the defects
that live between files.

## Data contracts

Datatypes are verified across every boundary they cross. Where a frontend and a backend
exist, DTOs are verified against the actual endpoints **and** against the database schema —
not merely against each other, which agrees happily while both disagree with the data. A
mismatch anywhere along that chain is a finding.

## Accessibility

Whenever the scope contains a UI, concretely: semantic markup and roles, keyboard
navigation, focus management, color contrast, screen-reader labeling. "Consider
accessibility" is not a finding.

## Seed best-practice index

A starting point for external sourcing, grouped by area. Non-exhaustive by design. **If a
link has moved, 404s, or is visibly stale, find the current authoritative version rather
than citing the dead one** — and cite what you actually read.

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

The audit still runs: repo conventions plus this seed index are enough for a real sweep.
Record the limitation in the coverage statement, naming which confirmed criteria were
measured against the seed alone rather than against a source verified live. Never silently
degrade — an audit that could not check current guidance and does not say so reads as one
that did.
