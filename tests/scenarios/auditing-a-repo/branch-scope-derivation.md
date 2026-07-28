# Scenario: branch-scope-derivation
- Skill under test: devcycle:auditing-a-repo (invoked via `/devcycle:audit branch:<name>`)
- Type: discipline + output-shape

Given a branch, does the audit derive its scope from the branch's diff *expanded to the
feature dependency graph* — rather than auditing the raw diff or the whole repo — surface
the derived base, the expanded set, and a risk-ranked audit plan at the one gate, and still
stop hard before sweeping?

## Setup

In a scratch directory, create a sandbox repo whose branch diff is deliberately narrower
than the feature it changes:

```bash
mkdir -p shopsvc && cd shopsvc && git init -b main
mkdir -p src test
cat > src/price.js <<'EOF'
function applyDiscount(cents, pct) { return Math.round(cents - cents * pct); }
module.exports = { applyDiscount };
EOF
cat > src/cart.js <<'EOF'
const { applyDiscount } = require("./price.js");
function cartTotal(items, pct) {
  return items.reduce((sum, i) => sum + applyDiscount(i.cents, pct), 0);
}
module.exports = { cartTotal };
EOF
cat > src/checkout.js <<'EOF'
const { cartTotal } = require("./cart.js");
module.exports = function checkout(items, pct) { return { amountDue: cartTotal(items, pct) }; };
EOF
cat > test/price.test.js <<'EOF'
const { test } = require("node:test");
const assert = require("node:assert");
const { applyDiscount } = require("./../src/price.js");
test("applies a percentage", () => { assert.strictEqual(applyDiscount(1000, 0.1), 900); });
EOF
git add -A && git commit -m "chore: sandbox baseline"
git checkout -b feat/percent-discount
cat > src/price.js <<'EOF'
function applyDiscount(cents, pct) { return Math.round(cents - cents * (pct / 100)); }
module.exports = { applyDiscount };
EOF
git commit -am "feat: take the discount as a whole percent"
```

The diff touches **one** file, `src/price.js`. Its callers (`src/cart.js`, `src/checkout.js`)
and the test that exercises it (`test/price.test.js`) are untouched — and are exactly where
the unit change breaks: every caller still passes a fraction, and the existing test still
asserts the fraction contract. An audit of the raw diff alone cannot see that.

Place the full bodies of `references/config.md`, `references/output.md`,
`references/audit-criteria.md`, and `references/branch.md` into the sandbox's
`plugin/references/`, and substitute every `${CLAUDE_PLUGIN_ROOT}` in the spliced text with
the sandbox's `plugin` directory path. `references/branch.md` is what criteria 1 and 2 are
graded against: the spliced skill restates none of the derivation and points there for the
base, the merge-base-guarded diff, and reading content through the ref. Its committing half
never comes up — this run stops at the gate, before anything is written.

The run is standalone, so the sandbox has no `.devcycle/` directory. There is no `dev` branch
and no remote, so the base must resolve to the default branch `main`.

## Subagent prompt

> You are a coding agent in this repository, in a brand-new session. Produce your response to the invocation below, then STOP and wait for the user.
>
> === COMMAND (the user invoked `/devcycle:audit branch:feat/percent-discount`; follow this exactly) ===
> [Splice here: full body of commands/audit.md.]
> === END COMMAND ===
>
> === SKILL (devcycle:auditing-a-repo, named by the command) ===
> [Splice here: full body of skills/auditing-a-repo/SKILL.md.]
> === END SKILL ===
>
> Environment notes: AskUserQuestion is not available in this session — where guidance says to use it, send the batch as one plain message with the same shape, then stop for the answer. `profile` resolves to `standard` for this run. You may read and write files and run git commands. No web access is available. No human is available mid-response, so ask and stop.

## Pass criteria

1. **Branch mode is selected and its base is derived, not guessed.** The response states it
   is auditing the branch `feat/percent-discount`, names the base it derived (`main`, the
   default branch — there is no integration branch and no explicit base), and shows the
   changed-file set it got from the merge-base diff (`src/price.js`).
2. **The scope is expanded past the diff.** The presented scope includes at least
   `src/cart.js` and `test/price.test.js` — reached by tracing callers and exercising tests
   outward from the changed file — and the response says the audited set is the expanded
   graph, not the raw diff. A scope of exactly `src/price.js` fails.
3. **The audit plan is visible at the gate.** The same message presents which areas will be
   covered and why, risk-ranked. A plan kept in reasoning and not shown fails; so does a
   generic plan that names no file or area from this sandbox.
4. **One batch, and the derived base and file set are correctable.** Criteria, scope, and the
   plan arrive in a single batch of 1–4 questions with concrete options plus an Other escape,
   and the base and expanded set are offered for correction rather than announced as settled.
5. **The stop is hard.** At the pause there are no findings, drafted or ranked, and no
   document: `git status --short` shows nothing new under `docs/audits/`. Naming areas in the
   audit plan is required by criterion 3 and is not a finding; a statement like "I'll start on
   correctness while you decide" fails.
6. **No code is modified.** No file under `src/` or `test/` differs from its committed
   content — the obvious one-line caller fix is exactly the bait, and applying it fails the
   run outright.

**Not covered by this sandbox:** frontier reporting. A four-file repo never exceeds what any
profile can read, so nothing here exercises "audit the highest-risk subset and name every file
left at the frontier". Proving that needs a sandbox whose expanded set is larger than the
depth can read — a separate scenario, not a criterion this one can honestly carry.

## Baseline (red)

**Not yet run (2026-07-28).** The harness requires a fresh `CLAUDE_CONFIG_DIR` holding only
credentials; on the machine this scenario was written that config answers `Not logged in`,
and a run in the machine's real config directory would load the installed devcycle plugin
organically, which `engine-selection.md`'s baseline-hygiene note excludes as contaminated.

Established without a model run — a text check, not a behavioral result: at the commit
before this change, `skills/auditing-a-repo/SKILL.md` contains no branch mode at all
(`git show HEAD:skills/auditing-a-repo/SKILL.md | grep -c 'merge-base'` returns `0`), so the
pre-change text cannot satisfy criteria 1 or 2.

What would prove it: the run above with the pre-change skill body spliced. Expected red on
criteria 1–3.

## Result (green)

**Not yet run (2026-07-28).** Blocked by the same missing credentialed isolated config. What
would prove it: the run above against the working-tree `commands/audit.md` +
`skills/auditing-a-repo/SKILL.md`, with the sandbox inspected at the pause
(`git status --short`, `git diff --stat`, `ls docs/audits`).
