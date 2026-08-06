# Reviewing Code

The review engine devcycle's whole-scope reviews share. `${CLAUDE_PLUGIN_ROOT}/playbooks/auditing-a-repo.md` and
`${CLAUDE_PLUGIN_ROOT}/playbooks/reviewing-the-branch.md` both invoke it; a user never does, and it has no command.
It is the answer to one question — *given this scope and these criteria, what is wrong with
this code?* — and nothing else.

Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.

## The review request

The caller supplies:

- **`scope`** — `{ref: "<base>..<branch>"}` for a branch's diff, or `{paths: [...]}` for a
  file set. Exactly one.
- **`criteria`** — the confirmed criteria set (an audit) or the spec's requirements plus the
  default criteria (a branch review).
- **`specPath`** — optional; present when a spec governs the scope.

## What this skill owns

### 1. Lens construction

Read `${CLAUDE_PLUGIN_ROOT}/references/quality-criteria.md` — it owns the catalog, the
sourcing precedence and the seed index, and is not restated here — and group the criteria
the caller gave into **2–5 lens charters**.

Grouping is **by kind, not by count**: related criteria share a lens so each reviewer has a
coherent charter it can actually hold ("correctness and data contracts across boundaries",
"the repo's own documented conventions"), and a lens is never one criterion wide. Below two
lenses the review stops being a panel; above five the cost multiplies while each charter
thins. Each charter names what its criteria are measured against, so the findings can carry
it.

When a `specPath` is present, one lens is spec compliance.

### 2. Engine selection

Keyed to `reviewDepth`, resolved per `${CLAUDE_PLUGIN_ROOT}/references/config.md` (that file
owns the resolution order; it is not repeated here).

**`panel`** — invoke the panel with the constructed lenses:

```bash
node "${CLAUDE_PLUGIN_ROOT}/workflows/review-panel.js" '{"scope":{"ref":"<base>..<branch>"},"specPath":"<path>","lenses":[{"key":"<key>","charter":"<charter>"}],"crossModel":<crossModelReview>}'
```

Its args are a single JSON argv: `scope` carries exactly one of `ref` or `paths`,
`specPath` is omitted when no spec governs the scope, `lenses` takes built-in keys and
`{key, charter}` objects mixed, and `crossModel` is true only when `crossModelReview` is.
The JSON report is stdout ONLY — progress goes to stderr. Record the engine as
`panel [+ cross-model lens]` when the cross-model lens ran.

**`single`** — the same constructed lenses run as inline read-only reviewers, followed by
the same per-finding refutation pass, producing the same finding shape. It is a complete
review in its own right, not a degraded panel.

**Graceful degradation `panel→single` — a first-class path, not an apology.** When
`review-panel.js` is missing or exits non-zero, the panel engine is unavailable: **an exit
code of 1 means the panel itself failed, never that findings exist, and it is never a review
verdict.** Fall back to `single` and disclose it in the engine line as
`panel→single (panel unavailable: <reason>)`. A fallback silently presented as a panel run
makes the review unauditable.

**The model.** When `branchReviewModel` resolves to an explicit id, export it before
invoking: `DEVCYCLE_PANEL_MODEL=<id> node ...` — omitting it silently replaces the user's
binding choice with the CLI's default. When it resolves to the session tier, omit the export.

### 3. Fresh context (bias control — non-negotiable)

A reviewer that watched the code being written inherits the author's assumptions and reviews
the intention instead of the code. So:

- Reviewers receive ONLY the scope, the criteria and the spec path — never the authoring
  conversation, task reports, or implementer reasoning.
- A caller that carries authoring context does not review directly: it dispatches fresh
  reviewers and acts on their findings.

This rule and its rationale live here. Callers name it and do not restate it.

### 4. Verify → dedup → rank

Every finding is adversarially verified against the code before it is reported: a second
reader tries to REFUTE it, and confidence follows what that reader found. Unverified
findings are marked, never dropped. Findings are then deduplicated across lenses and ranked.
The severity vocabulary, the core fields, the evidence discipline and the machine ordering
are owned by `${CLAUDE_PLUGIN_ROOT}/references/findings.md` — read it there and follow it;
none of it is restated here.

## What this skill returns

Findings in the shape `references/findings.md` defines, plus an **engine line** naming what
actually ran — one of `single`, `single + user-run code-review`, `panel`,
`panel [+ cross-model lens]`, `panel→single (panel unavailable: <reason>)`. No variants: the
caller records this value verbatim.

## What this skill does NOT own

Deliberately, so callers stay thin without this skill growing a second personality: the
criteria interview, spec-requirement enumeration, the ledger cross-check, the rounds and cap
loop, the audit's ranked document, the coverage statement, the audit's step-6 stop, and every
state-file and hand-off duty. Those belong to whichever stage invoked it.

## Red flags — if you catch yourself thinking any of these, return to the walk

| Rationalization | Reality |
| --- | --- |
| "One lens per criterion is more thorough" | It is more expensive and thinner per reviewer. Group by kind into 2–5 charters. |
| "The panel exited 1, so the review found problems" | Exit 1 means the panel failed. It is never a verdict. Degrade to `single` and say so. |
| "I already know this code, I'll review it myself" | That is exactly the bias this skill exists to prevent. Dispatch fresh reviewers. |
| "The finding is obviously real, verification is a formality" | The refutation pass is the machinery; skipping it turns a panel into three opinions. |
| "I'll just say the engine was `panel`" | The engine line is what makes the review auditable. It records what ran. |
