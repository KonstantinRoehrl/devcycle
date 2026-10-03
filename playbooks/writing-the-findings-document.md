# Writing the findings document

The last step of an audit run and of a `/devcycle:maintain` pass, read from
`playbooks/reviewing-code.md` once its step 4 has returned verified, ranked findings. The branch-review
stage never reads this file: it takes its findings back inline at step 4.

Every finding also carries the **document tier** `references/findings.md` lists — detailed enough to
start work from that one finding alone: what, where, why, how. The document adds a **coverage
statement** of what was read and what was not (areas skipped, criteria the evidence was thin for,
limits the scope imposed; silent truncation must never read as completeness) and a **provenance
header** whose every line is **omitted rather than guessed** when it cannot be determined: the audited
**branch**, the **sha of the audited content** (that branch's tip at `branch` scope, the sweep's
checkout HEAD otherwise — never this document's own topic branch, which need not contain the audited
code), and a **PR link** when one exists. Locations inside findings stay plain `file:line`.

Where `playbooks/reviewing-code.md` step 4 noted a precondition between findings — one finding's
reliability resting on another's fix landing first, in this document or in the tracker — the document
states the dependency explicitly and closes with a **suggested sequencing** line ordering the affected
findings; this supplements the severity/impact/complexity ranking in `findings.md`'s Ordering, it
does not replace it.

Write `docs/audits/YYYY-MM-DD-<topic>.md` and **do not commit it**: the audit report is a local
per-run snapshot at every policy depth (`references/config.md` § Doc tracking,
audit-report row = local across `all-local`/`standard`/`all-tracked`). Writing the file is the whole
of this step; the committed durable artifact is the maintenance-findings store, not this snapshot.

Branch discipline follows `${CLAUDE_PLUGIN_ROOT}/references/branch.md`, resolved by caller class and
never by which state file happens to exist beside the run. The branch-review stage returned its
findings back at `playbooks/reviewing-code.md` step 4 and never arrives here, so the classes that
resolve are the audit run's two entries and `/devcycle:maintain`:

- **The cycle's own audit stage** — the run owns the `.devcycle/state.md` it reads: follow that
  reference in full including the `branch:`-line write, keep `stage: audit` while that is the stage to
  resume at, record the document on the `audit:` line, and emit the handoff block per
  `${CLAUDE_PLUGIN_ROOT}/references/handoff.md` with `Stage completed: audit`.
- **Standalone `/devcycle:review`** — owns no state file: that baseline forces a topic branch only
  off a default or integration branch, so a run during another cycle would land this document in that
  cycle's history and review. It therefore always gets its own topic branch, cut from current HEAD and
  named in the report, and must NOT create, read-modify, or write `.devcycle/state.md`.
- **`/devcycle:maintain`** — owns no state file either, and never resolves to the first arm however
  much a concurrent cycle's state file looks like a match:
  `playbooks/maintaining-the-repo.md` § Boundaries forbids it to create, read or
  write one and forbids a handoff block, so it writes no `branch:` line, holds no stage and records no
  `audit:` line. It writes this document uncommitted as above; its store commit is that playbook's
  step 8, which never commits on the checked-out branch.

**Then stop.** Present the ranked list; the user picks, and each pick starts its own
`/devcycle:cycle` naming that finding — never auto-chain. This playbook is **read-only**: it fixes
nothing it notices in passing, even a trivial one, and that document is the only file it writes.

## Filing the findings to the PR — standalone `/devcycle:review`, `branch` scope, open PR only

An opt-in, confirm-first step that files this run's findings as PR review comments. It stays
**read-only toward code exactly as the rest of this playbook is**: it touches only PR state, never
the working tree, and the audit document above remains the only working-tree file the run writes.
It runs only when **all** three hold — this is a standalone `/devcycle:review` audit run (never the
in-cycle branch-review stage, which returned its findings inline back at
`playbooks/reviewing-code.md` step 4 and never reaches this file), the scope is `branch`, and an open
PR exists for that branch. Absent any one, this file ends at **Then stop.** exactly as above.

Filing consumes the run's **own in-memory ranked findings** — never re-parsing the findings
document just written, never a machine-readable sidecar.

The scope/severity gate below runs only on the standalone `/devcycle:review` entry, which carries
no run record, so an Other answer here **never appends** `user-correction-at-gate` —
`references/ledger.md` owns that condition (a gate appends exactly when a run
record exists, and here none does).

Orchestration, once the three conditions hold:

1. **Resolve once.** The open PR, its head sha as the `commit_id` every anchor pins against, and
   `<login>` from `gh api user --jq .login` — resolved once for the whole step.
2. **One scope/severity gate** via AskUserQuestion: which findings to file (default: the blocking
   set — `critical` + `high` in `references/findings.md`'s four-value severity
   vocabulary), and the review verdict — `COMMENT`, `REQUEST_CHANGES`, or `APPROVE`. On the user's
   **own** PR, `REQUEST_CHANGES` and `APPROVE` are **not offered**: a self-PR non-`COMMENT` verdict
   refuses with a named error and files nothing. At most the Frontier-25 cap
   `references/review-comments.md` owns is shown at the gate; beyond it,
   remaining findings are named and deferred, never silently truncated.
3. **Anchor against the PR-head diff, never the checkout.** Write the PR-head diff
   (`gh pr diff <pr> --repo <owner/name>`) and the selected findings (a JSON array where each
   entry carries `line` and either `path` or `file` — `pr-diff-anchor.mjs` accepts both, so the
   review panel's own `finding.file` shape composes directly, no hand-translation needed) to
   temp files, then partition them with
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/pr-diff-anchor.mjs" --diff-file <diff> --findings-file
   <findings>` — anchoring line numbers come only from that diff, never the checkout. It prints
   `{"anchored":[…RIGHT-side lines…],"degraded":[…]}`; a finding that will not anchor lands in
   `degraded` and **degrades into the review summary body**, never dropped.
4. **Draft each body through the comment-body contract** — read the `## The comment-body contract`
   subsection of `${CLAUDE_PLUGIN_ROOT}/references/review-comments.md` and draft to the body shape and
   attribution footer it pins; this step does not restate them.
5. **Screen every draft** — inline bodies and the summary body alike — by writing each body to a temp
   file and screening it with `node "${CLAUDE_PLUGIN_ROOT}/scripts/redaction-check.mjs" --file
   <draft>`; a body that would leak a host path or secret is fixed or dropped before any gate.
6. **Two gates, then one post.** Gate 1 (content: is what will be filed right?) → Gate 2 (post: may
   I file it?), then post through the `review` route of
   `${CLAUDE_PLUGIN_ROOT}/scripts/pr-review-post.mjs` — one batched review carrying every inline
   comment plus the summary body, one notification.
7. **Never clobber a pending review.** When the `review` route reports an existing pending review,
   surface its `PRR_…` node id and ask: merge into it (`--merge-into <PRR_…>`) or abort. Without an
   explicit `--merge-into` the route exits non-zero naming that node id and files nothing.
8. **Record the write.** Append one `review-writeback` marker via
   `${CLAUDE_PLUGIN_ROOT}/scripts/run-record.mjs append` — finding counts, the verdict event enum,
   and the PR number only; never body text, never a host path.
