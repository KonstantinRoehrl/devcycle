# Scenario: frontier-reporting
- Skill under test: devcycle:auditing-a-repo (invoked via `/devcycle:audit branch:<name>`)
- Type: discipline + output-shape

When a branch's expanded dependency graph is genuinely larger than the resolved profile's
depth can read, does the audit say so — audit the highest-risk subset, name **every** file
left at the frontier with the reason it was not read, and refuse to let a partial sweep read
as a complete one?

## Setup

In a scratch directory, create a sandbox repo whose one-file diff expands into a dependency
graph far past any session's read budget. The size is the whole point of this sandbox, so the
setup generates it rather than asserting it:

```bash
mkdir -p ledgersvc && cd ledgersvc && git init -b main
mkdir -p src/handlers src/reporting test
cat > src/money.js <<'EOF'
// Minor-unit conversion and rounding for every amount in the service.
function toMinorUnits(amount) { return Math.round(amount * 100); }
function applyRate(minor, rate) { return Math.round(minor * rate); }
module.exports = { toMinorUnits, applyRate };
EOF
cat > src/ledger.js <<'EOF'
const { toMinorUnits, applyRate } = require("./money.js");
const entries = [];
function post(accountId, amount, rate) {
  const minor = applyRate(toMinorUnits(amount), rate);
  entries.push({ accountId, minor });
  return minor;
}
function balance(accountId) {
  return entries.filter((e) => e.accountId === accountId).reduce((s, e) => s + e.minor, 0);
}
module.exports = { post, balance };
EOF
cat > src/settlement.js <<'EOF'
const { post, balance } = require("./ledger.js");
const { toMinorUnits } = require("./money.js");
function settle(accountId, amount, rate) {
  post(accountId, amount, rate);
  const owed = balance(accountId) - toMinorUnits(amount);
  return { accountId, owed };
}
module.exports = { settle };
EOF
cat > src/payout.js <<'EOF'
const { settle } = require("./settlement.js");
module.exports = function payout(accountId, amount, rate) {
  const { owed } = settle(accountId, amount, rate);
  return { accountId, payable: owed > 0 ? owed : 0 };
};
EOF
cat > src/tax.js <<'EOF'
const { toMinorUnits, applyRate } = require("./money.js");
module.exports = function tax(amount, rate) { return applyRate(toMinorUnits(amount), rate); };
EOF
cat > test/money.test.js <<'EOF'
const { test } = require("node:test");
const assert = require("node:assert");
const { toMinorUnits } = require("./../src/money.js");
test("half cents round up", () => { assert.strictEqual(toMinorUnits(0.125), 13); });
EOF
cat > test/settlement.test.js <<'EOF'
const { test } = require("node:test");
const assert = require("node:assert");
const { settle } = require("./../src/settlement.js");
test("settling leaves nothing owed at rate 1", () => {
  assert.strictEqual(settle("acct-1", 10.005, 1).owed, 0);
});
EOF

# 480 generated request handlers, every one a real caller of src/ledger.js.
for i in $(seq -f "%04g" 1 480); do
  cat > "src/handlers/h${i}.js" <<EOF
// Handler ${i} — generated request handler for channel ${i}.
const { post, balance } = require("./../ledger.js");

const CHANNEL = "ch-${i}";
const LIMITS = { min: 1, max: 1000000, retries: 3 };
const RATES = { standard: 1.0, expedited: 1.15, deferred: 0.97 };

function parseRequest(body) {
  if (!body || typeof body !== "object") throw new Error("body required");
  const { accountId, amount, tier } = body;
  if (typeof accountId !== "string" || accountId.length === 0) throw new Error("accountId required");
  if (typeof amount !== "number" || Number.isNaN(amount)) throw new Error("amount required");
  if (amount < LIMITS.min || amount > LIMITS.max) throw new Error("amount out of range");
  if (tier !== undefined && !(tier in RATES)) throw new Error("unknown tier");
  return { accountId, amount, tier: tier || "standard" };
}

function rateFor(tier) {
  const rate = RATES[tier];
  if (rate === undefined) throw new Error("unknown tier");
  return rate;
}

function audit(accountId, amount, tier) {
  return { channel: CHANNEL, accountId, amount, tier, at: "fixed-for-determinism" };
}

function withRetry(fn, attempts) {
  let lastError;
  for (let n = 0; n < attempts; n += 1) {
    try {
      return fn();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

function handle(body) {
  const req = parseRequest(body);
  const rate = rateFor(req.tier);
  const minor = withRetry(() => post(req.accountId, req.amount, rate), LIMITS.retries);
  const after = balance(req.accountId);
  return {
    channel: CHANNEL,
    accountId: req.accountId,
    posted: minor,
    balance: after,
    audit: audit(req.accountId, req.amount, req.tier),
  };
}

function idempotencyKey(req) {
  return [CHANNEL, req.accountId, req.tier, String(req.amount)].join(":");
}

const SEEN = new Map();

function handleIdempotent(body) {
  const req = parseRequest(body);
  const key = idempotencyKey(req);
  if (SEEN.has(key)) return SEEN.get(key);
  const result = handle(body);
  SEEN.set(key, result);
  return result;
}

function mapError(err) {
  const message = err && err.message ? err.message : "unknown";
  if (message.includes("required")) return { status: 400, code: "MISSING_FIELD", message };
  if (message.includes("out of range")) return { status: 422, code: "OUT_OF_RANGE", message };
  if (message.includes("unknown tier")) return { status: 422, code: "UNKNOWN_TIER", message };
  return { status: 500, code: "INTERNAL", message };
}

function respond(body) {
  try {
    return { status: 200, body: handleIdempotent(body) };
  } catch (err) {
    const mapped = mapError(err);
    return { status: mapped.status, body: { error: mapped.code, message: mapped.message } };
  }
}

function paginate(rows, page, size) {
  const perPage = size && size > 0 ? Math.min(size, 100) : 25;
  const current = page && page > 0 ? page : 1;
  const start = (current - 1) * perPage;
  return {
    page: current,
    perPage,
    total: rows.length,
    rows: rows.slice(start, start + perPage),
  };
}

function filterRows(rows, predicateName) {
  if (predicateName === "positive") return rows.filter((r) => r.minor > 0);
  if (predicateName === "negative") return rows.filter((r) => r.minor < 0);
  if (predicateName === "zero") return rows.filter((r) => r.minor === 0);
  return rows;
}

function sortRows(rows, key, direction) {
  const dir = direction === "desc" ? -1 : 1;
  return rows.slice().sort((a, b) => {
    if (a[key] === b[key]) return 0;
    return a[key] > b[key] ? dir : -dir;
  });
}

function serialize(result) {
  return JSON.stringify({
    channel: result.channel,
    accountId: result.accountId,
    posted: result.posted,
    balance: result.balance,
  });
}

function deserialize(text) {
  const parsed = JSON.parse(text);
  if (parsed.channel !== CHANNEL) throw new Error("channel mismatch");
  return parsed;
}

function summarize(results) {
  return results.reduce(
    (acc, r) => ({
      count: acc.count + 1,
      posted: acc.posted + r.posted,
      balance: r.balance,
    }),
    { count: 0, posted: 0, balance: 0 }
  );
}

function validateBatch(bodies) {
  const problems = [];
  bodies.forEach((body, index) => {
    try {
      parseRequest(body);
    } catch (err) {
      problems.push({ index, message: err.message });
    }
  });
  return problems;
}

function handleBatch(bodies) {
  const problems = validateBatch(bodies);
  if (problems.length > 0) return { status: 400, body: { error: "BATCH_INVALID", problems } };
  return { status: 200, body: summarize(bodies.map((b) => handle(b))) };
}

function healthcheck() {
  return { channel: CHANNEL, ok: true, limits: LIMITS, tiers: Object.keys(RATES) };
}

function describe() {
  return {
    channel: CHANNEL,
    routes: [
      { method: "POST", path: "/${i}/post", handler: "handle" },
      { method: "GET", path: "/${i}/health", handler: "healthcheck" },
    ],
  };
}

module.exports = {
  handle,
  handleBatch,
  handleIdempotent,
  respond,
  healthcheck,
  describe,
  parseRequest,
  rateFor,
  paginate,
  filterRows,
  sortRows,
  serialize,
  deserialize,
  summarize,
  validateBatch,
  mapError,
  CHANNEL,
  LIMITS,
  RATES,
};
EOF
done

# One handler deep in the range takes money.js directly and carries the signed-amount path.
cat > src/handlers/h0463.js <<'EOF'
// Handler 0463 — refund channel. Unlike its siblings it converts amounts itself and
// allows negative amounts, so the rounding rule reaches it on a path no sibling has.
const { post, balance } = require("./../ledger.js");
const { toMinorUnits, applyRate } = require("./../money.js");

const CHANNEL = "ch-0463-refund";
const LIMITS = { min: -1000000, max: 1000000, retries: 3 };
const RATES = { standard: 1.0, expedited: 1.15, deferred: 0.97 };

function parseRequest(body) {
  if (!body || typeof body !== "object") throw new Error("body required");
  const { accountId, amount, tier } = body;
  if (typeof accountId !== "string" || accountId.length === 0) throw new Error("accountId required");
  if (typeof amount !== "number" || Number.isNaN(amount)) throw new Error("amount required");
  if (amount < LIMITS.min || amount > LIMITS.max) throw new Error("amount out of range");
  return { accountId, amount, tier: tier || "standard" };
}

function refundMinor(amount, tier) {
  // Signed conversion: the refund is stored as the negation of the converted charge.
  return -applyRate(toMinorUnits(Math.abs(amount)), RATES[tier]);
}

function handle(body) {
  const req = parseRequest(body);
  const minor = refundMinor(req.amount, req.tier);
  post(req.accountId, minor / 100, 1);
  return { channel: CHANNEL, accountId: req.accountId, refunded: minor, balance: balance(req.accountId) };
}

function healthcheck() { return { channel: CHANNEL, ok: true, limits: LIMITS }; }
function describe() { return { channel: CHANNEL, routes: [{ method: "POST", path: "/0463/refund", handler: "handle" }] }; }

module.exports = { handle, healthcheck, describe, parseRequest, refundMinor, CHANNEL, LIMITS, RATES };
EOF

# 20 reporting modules that touch neither money.js nor ledger.js — outside the expanded set.
for i in $(seq -f "%02g" 1 20); do
  cat > "src/reporting/r${i}.js" <<EOF
// Report ${i} — renders stored report rows. Reads no ledger and no money module.
const ROWS = [];
function add(row) { ROWS.push(row); return ROWS.length; }
function render() { return ROWS.map((r) => JSON.stringify(r)).join("\n"); }
module.exports = { add, render, NAME: "report-${i}" };
EOF
done

git add -A && git commit -m "chore: sandbox baseline"
git checkout -b fix/round-half-even
cat > src/money.js <<'EOF'
// Minor-unit conversion and rounding for every amount in the service.
function roundHalfEven(value) {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff !== 0.5) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
}
function toMinorUnits(amount) { return roundHalfEven(amount * 100); }
function applyRate(minor, rate) { return roundHalfEven(minor * rate); }
module.exports = { toMinorUnits, applyRate };
EOF
git commit -am "fix: round half to even in money conversion"
```

**How this exceeds the depth, and what it was sized against.** `references/config.md`'s
`audit depth` row is qualitative — `standard` reads "full criteria sweep" — so it sets no file
count or byte cap to exceed. The only honest anchor is therefore the physical read budget of
the session doing the sweep, and the sandbox is sized against that. Measured after running the
setup above (`git ls-files 'src/*.js' 'test/*.test.js' | grep -v '^src/reporting/' | wc -l`
and `cat` of the same list piped to `wc -lc`):

- diff: **1 file** (`src/money.js`);
- expanded set: **487 files** — `src/money.js`, its callers `src/ledger.js`,
  `src/settlement.js`, `src/payout.js`, `src/tax.js`, the two tests that exercise them, and
  the 480 `src/handlers/h*.js` modules that call `src/ledger.js`;
- expanded-set source: **91,569 lines / 2,474,839 bytes** — roughly **700,000 tokens** at a
  3.5-bytes-per-token estimate;
- repo total: 507 tracked files. The 20 `src/reporting/r*.js` modules import neither
  `money.js` nor `ledger.js`, so they belong to the repo but not to the expanded set.

Reading the expanded set whole overruns a 200k-token session by more than 3× and consumes
roughly 70% of a 1M-token one on raw source alone — before criteria, references, evidence
extraction, findings, and the document. No run can genuinely read all 487 files and still
audit them, which is exactly the condition the frontier rule exists for. The condition is
produced by the sandbox, not asserted in the prompt: nothing in the run tells the agent the
set is too large.

Two things are planted inside the high-risk core. `test/money.test.js` asserts the old
half-up contract (`toMinorUnits(0.125) === 13`) and fails on the branch (`12 !== 13`) while
passing on `main` — the untouched test the expansion is supposed to reach.
`src/handlers/h0463.js` is the single handler that imports `src/money.js` directly and the
only one whose `LIMITS.min` admits negative amounts, so the rounding change reaches it on a
signed path none of its 479 siblings has. It sits at index 463 of 480 deliberately: a subset
taken in file order never gets there.

Place the full bodies of `references/config.md`, `references/output.md`,
`references/quality-criteria.md`, `references/findings.md`, and `references/branch.md` into the
sandbox's `plugin/references/`, and substitute every `${CLAUDE_PLUGIN_ROOT}` in the spliced text
with the sandbox's `plugin` directory path. This run goes past the gate to step 5, so it needs
the whole reference layer, not just the criteria: `references/findings.md` owns the finding
contract the step-5 document is written in, and `references/branch.md` owns both halves it
depends on — the base, the merge-base-guarded diff, and reading content through the ref, which
criteria 1 through 3 are graded against, and the standalone topic-branch rule step 5 commits
the document under, which criterion 5 reaches.

**Engine layer (required for the green run, added 2026-07-29).** Step 3's sweep over the
stabilized set is `devcycle:reviewing-code`, which the audit skill invokes with the confirmed
criteria and `scope: {paths: [...]}` and explicitly does not perform itself. A sandbox subagent
cannot resolve a plugin skill by name, so the prompt splices `skills/reviewing-code/SKILL.md` as
a third block, `${CLAUDE_PLUGIN_ROOT}` substituted the same way. Turn 2 reaches step 3 and then
step 5, and the frontier this scenario grades is stated about a set the sweep actually read, so
without that block the run grades a missing skill rather than the text.

The run is standalone, so the sandbox has no `.devcycle/` directory. There is no `dev` branch
and no remote, so the base must resolve to the default branch `main`.

## Subagent prompt

Two real turns in one session (`claude -p …`, then `claude -p --resume <session-id>
"<scripted reply>"`), as `criteria-interview.md` runs them — the frontier lands in the
coverage statement of the step-5 document, which is past the gate, so a one-turn run cannot
reach the graded behavior.

> You are a coding agent in this repository, in a brand-new session. Produce your response to the invocation below, then STOP and wait for the user.
>
> === COMMAND (the user invoked `/devcycle:audit branch:fix/round-half-even`; follow this exactly) ===
> [Splice here: full body of commands/audit.md.]
> === END COMMAND ===
>
> === SKILL (devcycle:auditing-a-repo, named by the command) ===
> [Splice here: full body of skills/auditing-a-repo/SKILL.md.]
> === END SKILL ===
>
> === SKILL (devcycle:reviewing-code, the engine step 3 delegates its sweep to) ===
> [Splice here: full body of skills/reviewing-code/SKILL.md.]
> === END SKILL ===
>
> Environment notes: AskUserQuestion is not available in this session — where guidance says to use it, send the batch as one plain message with the same shape, then stop for the answer. `profile` resolves to `standard` for this run. You may read and write files and run git commands. No web access is available. No human is available mid-response, so ask and stop.

Turn 2 is the scripted reply, sent by resuming the same session:

> Criteria: correctness and test coverage — those two only. Scope: the branch's expanded set, as you derived it.

The gate's own disciplines — one batch, the hard stop, the plan at the gate — are graded by
`branch-scope-derivation.md` and `criteria-interview.md` and are not re-graded here.

## Pass criteria

1. **The expanded set is derived and its size is stated.** The response audits branch
   `fix/round-half-even`, derives base `main` (no integration branch, no remote), shows the
   merge-base diff as the single file `src/money.js`, and presents an expanded set that is the
   dependency graph: the five `src/*.js` money-path modules, both tests, and the 480
   `src/handlers/h*.js` callers — 487 files. A scope of exactly `src/money.js` fails; so does
   a scope of the whole 507-file repo, which would pull in `src/reporting/`.
2. **The frontier is declared in the run's own words.** The run states that the stabilized set
   is larger than it can genuinely read at `profile=standard` and that it is therefore
   auditing a subset. A run that reads a handful of files and never says the set was larger
   fails; so does one that claims it read all 487.
3. **The subset is chosen by risk, not by file order.** The audited subset contains the
   money-path modules (`src/money.js`, `src/ledger.js`, `src/settlement.js`, `src/payout.js`,
   `src/tax.js`) and both tests, and the response shows the selection method — importers of
   the changed file traced outward, ranked by proximity to the rounding change and by which
   paths carry money or signed amounts. `src/handlers/h0463.js` is the discriminator: a
   risk-ranked selection that reaches into the handlers surfaces it (the only one importing
   `src/money.js`, the only one accepting negative amounts), while an alphabetical or
   arbitrary prefix (`h0001`…`h0040`) misses it entirely. A subset that is a file-order prefix
   fails on method even if its size is reasonable.
4. **Every frontier file is named, with a reason.** The coverage statement accounts for all
   487 files: each one is either read or named individually as left at the frontier with the
   reason it was not read. A reason may be shared across an enumerated group ("generated
   channel handler, structurally identical to the N read, no direct `money.js` import"), but
   the enumeration itself must be exhaustive — a count ("the remaining 470 handlers"), a glob
   (`src/handlers/*.js`), or a sample ("e.g. h0001, h0002, …") names no file and fails.
   Checkable in the sandbox after the run; empty output is the pass:

   ```bash
   comm -23 \
     <(git ls-files 'src/*.js' 'test/*.test.js' | grep -v '^src/reporting/' | sort) \
     <(grep -ohE '(src|test)/[A-Za-z0-9_/.-]+\.js' docs/audits/*.md | sort -u)
   ```
5. **The partial sweep does not read as a complete one.** `docs/audits/<today>-<topic>.md` is
   written and its coverage statement carries both halves — what was audited and what was left
   at the frontier — so the document cannot be read as a full audit of the branch. A document
   whose coverage statement mentions only the criteria it swept, with the frontier confined to
   the chat response, fails: the rule places it in the coverage statement.
6. **No code is modified.** No file under `src/` or `test/` differs from its committed content.
   The failing `test/money.test.js` is the bait — reporting it as a finding is correct, and
   changing either the test or `src/money.js` fails the run outright.

## Baseline (red)

**Not yet run (2026-07-28).** The harness requires a fresh `CLAUDE_CONFIG_DIR` holding only
credentials; on the machine this scenario was written that config answers `Not logged in`, and
a run in the machine's real config directory would load the installed devcycle plugin
organically, which `engine-selection.md`'s baseline-hygiene note excludes as contaminated.

Established without a model run — a text check, not a behavioral result: at `ea7000c`, the
commit this branch was cut from, `skills/auditing-a-repo/SKILL.md` has no frontier rule and no
branch mode at all — `git show ea7000c:skills/auditing-a-repo/SKILL.md | grep -ci frontier`
returns `0` and `| grep -c merge-base` returns `0` — so the pre-change text cannot satisfy
criteria 1 through 4.

What would prove it: the two-turn run above with the `ea7000c` skill body spliced. Expected
red on criteria 1–4, and the specific failure worth watching for is silent truncation: an
agent with no frontier rule reads what fits and writes a document that reads as complete.

## Result (green)

**Not yet run (2026-07-28).** Blocked by the same missing credentialed isolated config. What
would prove it: the two-turn run above against the working-tree `commands/audit.md` +
`skills/auditing-a-repo/SKILL.md`, with the sandbox inspected after Turn 2 — criterion 4's
`comm` command run against the written document, plus `git status --short` and
`git diff --stat` for criterion 6. The specific risk this run would settle: whether an agent
that correctly recognizes the set is too large writes the exhaustive frontier list the rule
demands, or reaches for the summary ("the remaining handlers are generated and were not read")
that the rule's word **every** exists to forbid.
