---
description: "Audit this repo against criteria you confirm, and write a ranked findings document. Standalone: no cycle is started."
---

# /devcycle:audit

Audit this repo for the concern in `$ARGUMENTS` via the `devcycle:auditing-a-repo`
skill, which owns the criteria interview, the sweep, the findings document at
`docs/audits/YYYY-MM-DD-<topic>.md`, and — in its steps 5 and 6 — the branch,
state-file, and stop-at-the-document rules. Do not restate or replace its process
here.

**This run is standalone: no cycle, and this command is not a pipeline stage.** That is the
one fact the skill cannot derive on its own, and it is what selects the skill's standalone
behavior over its in-cycle behavior.

**`$ARGUMENTS` may name a branch** (`/devcycle:audit feat/csv-export`, optionally with a
base). A branch selects the skill's branch-scoped mode — the audited set is that branch's
diff expanded to its feature dependency graph, per the skill's step 0. No branch means the
whole repo or a named subsystem, settled at the skill's interview as before.

Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.
