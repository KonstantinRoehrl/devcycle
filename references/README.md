# References index

This index names each `references/` entry with a one-line summary of what it governs. Keep it to
one line per entry; the hub (`README.md`) mirrors this roster in its surface table.

| File | What it owns |
| --- | --- |
| `branch.md` | Branch discipline — the rule every committing path follows and the derivation every branch-scoped stage runs to turn a branch into a file set. |
| `checklist.md` | The on-device checklist contract — paths, item shape, dimensions, and the `(auto)` boundary — shared by checklist generation and the on-device stage. |
| `commit-convention.md` | How a devcycle-driven commit's subject matches the target repo's own commit-message rules — deriving and recording them. |
| `config-changelog.md` | The `userConfig` knob history — every addition, rename, and deprecation and the version each landed in. |
| `config.md` | How devcycle resolves configuration — the knobs, the profile, and the model tiers, in one place. |
| `culprits.json` | The culprit vocabulary — each slug with its kind, phase, description, and the version it entered. |
| `delegation.md` | Who does the work inside a stage — the coordinator's closed duty list, the stage budget, the research-dispatch contract, and the return envelopes. |
| `evidence.md` | How devcycle proves a task did what it claims — the evidence classes, the file-backed contract, and the report and verdict shapes. |
| `findings.md` | How a finding is expressed — the four-value severity vocabulary with blocking derived, the core and document field sets, the evidence discipline, and the panel's machine shape. |
| `first-run-config.md` | devcycle's first-run and upgrade configuration dialogue. |
| `handoff.md` | What happens at a stage boundary — the handoff block, the three-value context action, the one-block-per-stage rule, and the await gate. |
| `impact-scoring.md` | How devcycle quantifies what a culprit cost. |
| `ledger.md` | The ledger's own write format — its preamble records and its per-event line. |
| `loops.md` | What every bounded loop does when it runs out of rounds — the cap, the exhaustion statuses, and how each outcome is reported. |
| `model-tiers.json` | The model-tier table — each model family with its escalation rank and name-match pattern. |
| `output.md` | How every devcycle agent and playbook reports. |
| `quality-criteria.md` | What any devcycle review or plan measures against — the criteria catalog, sourcing precedence, seed best-practice index, and how the catalog reaches planning and execution. |
| `resume.md` | How any stage re-enters itself after an interruption (`/devcycle:continue`), and the state file's shape. |
| `sweep-execution.md` | How a plan task marked `**Execution:** sweep` runs inside the execution stage. |
