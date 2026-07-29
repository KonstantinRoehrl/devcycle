# Scenario: lens-construction
- Skill under test: devcycle:reviewing-code (lens construction, step 1)
- Type: output-shape

Given a criteria set of nine confirmed criteria spanning two stacks, does the skill build
between two and five lens charters **grouped by kind** — never one lens per criterion, never
a single lens swallowing all nine — and does every charter name what its criteria are
measured against?

The skill is invoked by other skills and never by a user, so this scenario stands in for the
caller: the prompt hands it the review request (`scope`, `criteria`, no `specPath`) the way
`devcycle:auditing-a-repo` hands it one, and grades only what the skill returns before any
reviewer is dispatched.

## Setup

In a scratch directory, create a sandbox repo `orderweb` whose code spans two stacks and
whose conventions are written down, so a charter that claims a repo convention has a file to
be wrong about:

```bash
mkdir -p orderweb && cd orderweb && git init -b main
mkdir -p api web tests
cat > CONTRIBUTING.md <<'EOF'
# Conventions
- Every request body is validated by a Pydantic model before it reaches a handler.
- Database access goes through `api/db.py`; no module builds SQL of its own.
- No inline styles in `web/`; every color and spacing value comes from `web/tokens.css`.
EOF
cat > api/db.py <<'EOF'
import sqlite3
def connect():
    return sqlite3.connect("orders.db")
def fetch_order(order_id):
    con = connect()
    return con.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
EOF
cat > api/orders.py <<'EOF'
import sqlite3
from api.db import connect
def place_order(payload):
    con = connect()
    con.execute("INSERT INTO orders (sku, qty) VALUES ('%s', %s)" % (payload["sku"], payload["qty"]))
    con.commit()
    return {"ok": True}
def total(items):
    return sum([i["price"] * i["qty"] for i in items for _ in range(1)])
EOF
cat > web/cart.js <<'EOF'
export function renderCart(items, root) {
  root.innerHTML = items
    .map((i) => `<div style="color:#c00" onclick="remove(${i.id})">${i.name}</div>`)
    .join("");
}
EOF
cat > web/tokens.css <<'EOF'
:root { --danger: #c00; --gap: 8px; }
EOF
cat > tests/test_orders.py <<'EOF'
from api.orders import total
def test_total():
    assert total([{"price": 100, "qty": 2}]) == 200
EOF
git add -A && git commit -m "chore: sandbox baseline"
```

Then give the sandbox the plugin surface the skill points at:

```bash
mkdir -p plugin/references
cp <absolute path of the devcycle checkout>/references/quality-criteria.md plugin/references/
cp <absolute path of the devcycle checkout>/references/findings.md plugin/references/
cp <absolute path of the devcycle checkout>/references/config.md plugin/references/
cp <absolute path of the devcycle checkout>/references/output.md plugin/references/
```

**Reference layer (required for the green run).** Four files, not three: the skill's opening
line reports per `${CLAUDE_PLUGIN_ROOT}/references/output.md`, and its lens-construction
section refuses to restate the catalog and sends the reader to
`${CLAUDE_PLUGIN_ROOT}/references/quality-criteria.md` for the sourcing precedence criterion
4 is graded against. `findings.md` and `config.md` are named by the sections after this one
and must be readable or the run grades a broken sandbox rather than the text. Substitute
every `${CLAUDE_PLUGIN_ROOT}` in the spliced skill text with the sandbox's `plugin`
directory path.

The run is standalone: no `.devcycle/` directory, no spec file anywhere in the sandbox, and
no web access.

## Subagent prompt

Given verbatim to a fresh subagent (working directory: the `orderweb` sandbox). For the
green run the block marked SKILL CONTENT carries the full body of
`skills/reviewing-code/SKILL.md` with `${CLAUDE_PLUGIN_ROOT}` substituted per Setup; the
baseline run omits that block.

```
[SKILL CONTENT: full body of skills/reviewing-code/SKILL.md, ${CLAUDE_PLUGIN_ROOT}
replaced by the sandbox's plugin directory]

You are the shared review engine, invoked by the audit stage of a devcycle pipeline in
this repo. Here is the review request.

scope: {paths: ["api/db.py", "api/orders.py", "web/cart.js", "web/tokens.css",
"tests/test_orders.py"]}

criteria (nine, all confirmed by the user at the audit's criteria gate):
1. correctness and logic errors, edge cases, null handling
2. security — input validation and the injection classes relevant to this stack
3. error handling and failure modes
4. resource leaks
5. performance — algorithmic complexity and repeated I/O
6. duplication vs. reuse
7. conformance to this repo's own documented conventions
8. accessibility, for the UI in scope
9. Python typing coverage and honesty

specPath: none — no spec governs this scope.

Resolved configuration: profile=standard, reviewDepth=single, crossModelReview=false,
branchReviewModel resolves to the session tier.

Construct the review lenses for this request and report them: for each lens, its key, its
charter, and which of the nine numbered criteria it carries. Then STOP and wait — do not
dispatch reviewers and do not begin reviewing.
```

## Pass criteria

1. **The charter count is between 2 and 5 inclusive.** Six or more fails; one fails. Both
   directions are live here: nine criteria invite a lens apiece, and "just review everything
   in one pass" collapses the panel.
2. **No charter covers exactly one criterion.** This is the criterion a near-miss trips: a
   five-lens split that parks criterion 8 (accessibility) or criterion 9 (Python typing)
   alone satisfies criterion 1 and still fails here, because a one-criterion lens is not a
   charter a reviewer can hold.
3. **Every criterion appears in exactly one charter.** All nine of the caller's numbered
   criteria are carried; none is dropped as awkward (criterion 9 spans only one of the two
   stacks, criterion 8 only the other), and none is listed under two lenses to look thorough.
4. **Every charter names what its criteria are measured against**, per the precedence in
   `references/quality-criteria.md`: a repo convention or a named external source. The
   charter carrying criterion 7 names `CONTRIBUTING.md` — the file that exists in this
   sandbox — not "the repo's conventions" in the abstract. `measured against: best
   practices`, `industry standards`, or an omitted source fails, however sensible the
   grouping around it.
5. **No spec lens is constructed.** The request carries no `specPath`, so a lens keyed
   `spec`, or any charter that grades the code against a spec, requirements document, or
   ticket, fails — there is no such file in the sandbox to read, and inventing the lens
   would make the panel invocation invalid at the script's own argument check.
6. **The charters are charters, not comma-joined criterion names.** Each is a subject a
   reviewer could hold and this scope makes concrete — "correctness and failure modes along
   the order-placement path", "the API boundary's input validation and injection surface" —
   rather than an echo such as `lens 2: security, resource leaks, performance`. A lens whose
   charter is only the list of criteria it carries fails.

**Not covered by this sandbox:** the review itself. The run stops before reviewers are
dispatched, so nothing here grades the refutation pass, dedup, ranking, or the finding
shape — `../auditing-a-repo/finding-format.md` and `engine-delegation.md` cover the parts
downstream of the charters. The planted defects (the `%`-formatted INSERT, the unclosed
connections, the inline style, the `innerHTML` click handler) exist to make the charters
concrete and to give a later run something real to find; no criterion here grades whether
they were found.

**The stop is the prompt's, not the skill's.** `skills/reviewing-code/SKILL.md` says nothing
about reporting lenses and waiting — it is a review engine, and left alone it would review.
The prompt imposes the stop so lens construction can be graded before the charters are
consumed by anything. A run that reports its lenses and then reviews anyway has failed to
follow the prompt, not the skill: grade criteria 1–6 against the reported lens set and record
the overrun as a protocol deviation on the run, never as a failed criterion.

## Baseline (red)

**Not yet run (2026-07-29).** Same isolated-config blocker recorded in
`../auditing-a-repo/criteria-interview.md`: the harness requires a fresh `CLAUDE_CONFIG_DIR`
holding only credentials, and on the machine this scenario was written the CLI in an
isolated config directory answers `Not logged in`; a run in the machine's real config
directory would load the installed devcycle plugin organically, which
`../reviewing-the-branch/engine-selection.md`'s baseline-hygiene note excludes as
contaminated.

Established without a model run — a text check over the repository at the pre-change commit,
not a behavioral result:

- `skills/reviewing-code/SKILL.md` does not exist at `934ecdb` (`git cat-file -e
  934ecdb:skills/reviewing-code/SKILL.md` fails), and no surface file there uses the
  vocabulary these criteria grade: `git show 934ecdb:skills/reviewing-the-branch/SKILL.md |
  grep -c charter` and the same over `references/audit-criteria.md` both return `0`, as does
  `grep -c lenses` over the branch-review skill. Before this change the only lens set in
  devcycle was the panel script's own fixed built-ins, chosen by the script and never
  derived from a caller's criteria — so the pre-change text cannot satisfy criteria 1–4 or 6
  at all.

What would prove it: the run above with the SKILL CONTENT block omitted entirely (there is
no pre-change body of this skill to splice). Expected red on criteria 1, 2, 4 and 6 — an
unguided agent handed nine numbered criteria and asked for lenses most often returns nine —
and plausibly on 5, since "review it against the requirements" is a habitual lens even with
no requirements file in reach.

## Result (green)

**Not yet run (2026-07-29).** Blocked by the same missing credentialed isolated config. What
would prove it: the run above against the working-tree `skills/reviewing-code/SKILL.md` with
`${CLAUDE_PLUGIN_ROOT}` replaced by the sandbox plugin path, grading criteria 1–6 against the
reported lens set, and `git status --short` run in the sandbox afterwards to confirm the
stop was hard — no reviewer output, no findings file, no modification to `api/`, `web/` or
`tests/`.
