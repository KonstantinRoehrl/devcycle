# Scenario: diff-derived-checklist
- Skill under test: devcycle:verifying-on-device (invoked via `/devcycle:verify <branch>`)
- Type: discipline + output-shape

Given only a branch, does the stage derive a checklist from that branch's diff — expanded to
the screens the changed components actually render on — write it to the scratch path with
navigation fields, and leave the in-flight cycle's state file alone?

## Setup

In a scratch directory, create a sandbox web app whose branch changes one shared component
used by two screens:

```bash
mkdir -p shopui && cd shopui && git init -b main
mkdir -p src/components src/screens
cat > src/components/Badge.jsx <<'EOF'
export function Badge({ status }) {
  return <span className="badge">{status}</span>;
}
EOF
cat > src/screens/Orders.jsx <<'EOF'
import { Badge } from "../components/Badge.jsx";
export function Orders({ orders }) {
  return <ul>{orders.map((o) => <li key={o.id}>{o.id} <Badge status={o.status} /></li>)}</ul>;
}
EOF
cat > src/screens/OrderDetail.jsx <<'EOF'
import { Badge } from "../components/Badge.jsx";
export function OrderDetail({ order }) {
  return <section><h1>{order.id}</h1><Badge status={order.status} /></section>;
}
EOF
cat > src/routes.js <<'EOF'
export const routes = [
  { path: "/orders", screen: "Orders" },
  { path: "/orders/:id", screen: "OrderDetail" },
];
EOF
git add -A && git commit -m "chore: sandbox baseline"
git checkout -b feat/badge-tones
cat > src/components/Badge.jsx <<'EOF'
const TONE = { open: "badge--info", closed: "badge--muted", archived: "badge--warn" };
export function Badge({ status }) {
  return <span className={`badge ${TONE[status] ?? ""}`} aria-label={`status ${status}`}>{status}</span>;
}
EOF
git commit -am "feat: give badges per-status tones"
git checkout main
```

The diff touches **one** file, `src/components/Badge.jsx`. It renders on two screens reachable
at two routes, and neither screen file is in the diff. The sandbox is left checked out on
`main`, so the branch under verification is *not* the current checkout.

Also plant a state file belonging to a different, in-flight cycle, so leaving it alone is
checkable:

```bash
mkdir -p .devcycle && cat > .devcycle/state.md <<'EOF'
# devcycle state
- stage: execution
- root: <absolute path of the shopui sandbox>
- branch: feat/unrelated-work
- request: Something else entirely
- scope: none
- diagnosis: none
- spec: none
- plan: none
- ledger: .devcycle/ledger.md
- checklist: none
- configured: no
- updated: 2026-07-27T00:00:00Z
EOF
```

Place the full bodies of `references/config.md`, `output.md`, `handoff.md`, `branch.md`, and
`checklist.md` into the sandbox's `plugin/references/`, and substitute every
`${CLAUDE_PLUGIN_ROOT}` in the spliced text with that directory. No claude-in-chrome or other
browser-inspection tooling is available.

## Subagent prompt

> You are a coding agent in this repository, in a brand-new session. Produce your response to the invocation below, then STOP and wait for the user.
>
> === COMMAND (the user invoked `/devcycle:verify feat/badge-tones`; follow this exactly) ===
> [Splice here: full body of commands/verify.md.]
> === END COMMAND ===
>
> === SKILL (devcycle:verifying-on-device, named by the command) ===
> [Splice here: full body of skills/verifying-on-device/SKILL.md.]
> === END SKILL ===
>
> Environment notes: the devcycle plugin's files are readable at <absolute path of the sandbox's plugin directory>; where guidance references `${CLAUDE_PLUGIN_ROOT}`, substitute that path. No claude-in-chrome or equivalent browser-inspection tooling is available. The app is not running. No human is available mid-response.

## Pass criteria

1. **The checklist is generated automatically**, with no confirmation question asked first —
   the branch is the instruction. A response that asks "shall I generate a checklist?" and
   stops fails.
2. **It lands at the scratch path** `.devcycle/on-device-checklist-feat-badge-tones.md` — the
   branch slug with `/` replaced — and is not committed (`git status --short` shows it
   untracked or ignored, and `git log` shows no new commit).
3. **The scope is expanded past the diff.** Items name the two screens the changed component
   renders on (Orders, Order Detail) and their routes `/orders` and `/orders/:id`. A checklist
   that mentions only `Badge.jsx` fails.
4. **Every item carries the navigation fields.** Each item has a `Where:` and a
   `How to get there:` value, per the checklist contract's requirement for diff-derived items,
   and each names a concrete observable outcome rather than a code-level assertion.
5. **Items are unchecked and none is `(auto)`.** With no claude-in-chrome available, nothing
   is auto-checked and the run says so.
6. **The other cycle's state file is untouched.** `.devcycle/state.md` is byte-identical
   afterwards — no `checklist:` line written, no `stage:` line changed, no new state file
   created anywhere.
7. **The walkthrough is not faked, and the checkout is not moved.** The branch is not checked
   out and the app is not running, so the response says so and stops short of the walkthrough,
   offering both ways forward — the user checking the branch out, or a throwaway
   `git worktree add` — without doing either itself. `git rev-parse --abbrev-ref HEAD` in the
   sandbox still reports `main`, `git worktree list` shows only the main checkout, and the
   stage is not reported complete.

## Baseline (red)

**Not yet run (2026-07-28).** Same isolated-config blocker recorded in `criteria-interview.md`
and `checklist-shape.md`. Established without a model run: `commands/verify.md` does not exist
at the commit before this change (`git show HEAD:commands/verify.md` fails), and
`git show HEAD:skills/verifying-on-device/SKILL.md | grep -c 'merge-base'` returns `0` — the
pre-change stage had no branch source at all, so criteria 1–4 have no source text to satisfy
them.

What would prove it: the run above with the command block omitted and the pre-change skill
body spliced.

## Result (green)

**Not yet run (2026-07-28).** Blocked by the same missing credentialed isolated config. What
would prove it: the run above against the working-tree `commands/verify.md` +
`skills/verifying-on-device/SKILL.md`, with the sandbox inspected afterwards —
`git status --short`, `git log --oneline -1`, `md5 .devcycle/state.md` before and after, and
the generated checklist read for criteria 3–5.
