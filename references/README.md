# References index

This index names each `references/` entry with a one-line summary of what it governs. Keep it to
one line per entry; the hub (`README.md`) mirrors this roster in its surface table.

| File | What it owns |
| --- | --- |
| `abstraction-and-strengths.md` | The Abstraction criterion and the Strengths rule — applied by whole-scope reviews and `/devcycle:maintain` only. |
| `branch.md` | Branch discipline — the rule every committing path follows and the derivation every branch-scoped stage runs to turn a branch into a file set. |
| `checklist.md` | The on-device checklist contract — paths, item shape, dimensions, and the `(auto)` boundary — shared by checklist generation and the on-device stage. |
| `commit-convention.md` | How a devcycle-driven commit's subject matches the target repo's own commit-message rules — deriving and recording them. |
| `config.md` | How devcycle resolves configuration — the knobs, the knob channel from commands to stages, and the profile. |
| `culprits.json` | The culprit vocabulary — each slug with its kind, phase, description, and the version it entered. |
| `delegation.md` | Who does the work inside a stage — the coordinator's closed duty list, the stage budget, the research-dispatch contract, and the return envelopes. |
| `evidence.md` | How devcycle proves a task did what it claims — the evidence classes, the file-backed contract, and the report and verdict shapes. |
| `findings.md` | How a finding is expressed — the four-value severity vocabulary with blocking derived, the core and document field sets, the evidence discipline, and the panel's machine shape. |
| `first-run-config.md` | devcycle's first-run configuration dialogue. |
| `handoff.md` | What happens at a stage boundary — the handoff block, the three-value context action, the one-block-per-stage rule, and the await gate. |
| `impact-scoring.md` | How devcycle quantifies what a culprit cost. |
| `ledger.md` | The ledger's own write format — its preamble records and its per-event line. |
| `loops.md` | What every bounded loop does when it runs out of rounds — the cap, the exhaustion statuses, and how each outcome is reported. |
| `model-routing.md` | How a `*Model` knob's value becomes a dispatch model — the session and fast tiers, the ladder, and the ceiling. |
| `model-tiers.json` | The model-tier table — each model family with its escalation rank and name-match pattern. |
| `output.md` | How every devcycle agent and playbook reports. |
| `quality-criteria.md` | What any devcycle review or plan measures against — the criteria catalog, sourcing precedence, seed best-practice index, and how the catalog reaches planning and execution. |
| `reinforcement-policy.md` | The numeric thresholds devcycle's learn loop reads when it decides to escalate a culprit or reinforce a win. |
| `resume.md` | How any stage re-enters itself after an interruption (`/devcycle:continue`), and the state file's shape. |
| `review-comments.md` | How PR review comments are triaged — the six-bucket taxonomy, the comment-to-finding mapping, and the reply-posting contract for the `reconcile` command. |
| `stages.json` | The stage dispatch — each stage's entry playbook or skill and its re-entry note, printed by `scripts/stage-entry.mjs`. |
| `sweep-execution.md` | How a plan task marked `**Execution:** sweep` runs inside the execution stage. |

## Citation grammar

- `${CLAUDE_PLUGIN_ROOT}/<dir>/<file>.md` means **read**: the citing step opens and executes that
  file, or the named section of it, at that point. `scripts/validate.mjs` check 15 counts it.
- A bare `references/<file>.md`, `playbooks/<file>.md` or `commands/<file>.md` means **owner**: it
  names where a rule lives, and an agent does not open it on the strength of the mention.
- A conventions list is an owner list. Its entries are bare, and a step that executes one of those
  owners carries its own prefixed citation at that step.

`scripts/validate.mjs` check 26 holds the grammar over `commands/`, `playbooks/` and `references/`:
no reference cites a playbook or command prefixed; no prefixed citation sits in an owner sentence
unless a read verb opens it or a clause; no sentence that opens with a read verb names its target
bare; every bare path resolves. `agents/` keep their own citations.
