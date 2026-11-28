# Maintain fixtures

Data for the `/devcycle:maintain` hygiene sweep's suites. `dead-code-repo.json` is a path → content
map of a small JS/Angular repo with known dead code and decoys; `hygiene-sweep-fixture.test.mjs`
writes it out per test. `complexity-repo.json` is the same shape for the complexity sweep: one hotspot
and three decoys (a marked generated file, a large cohesive table, a complex file nobody changes);
`hygiene-sweep-complexity-fixture.test.mjs` writes it out per test. `graph-repo/`, `no-graph-repo/` and `issues/` feed the graph and issue folds.

## Recorded tool output

`sweep-tool-outputs/` holds real output from the tools the registry pins, recorded against the tree its
row names, and replayed so the suites stay offline. The replay stub answers
`--version` with a placeholder, so nothing at runtime ties a recording to its pin;
`hygiene-sweep-fixture.test.mjs` does, by failing when a version below differs from
`references/hygiene-sweeps.json`. A pin bump means re-recording and updating the row.

Tree: knip and tsc `dead-code-repo.json`; lizard `complexity-repo.json`.

| Recording | Tool | Pinned version | Command |
| --- | --- | --- | --- |
| `knip-default.json` | knip | 6.44.2 | `npx -y knip@6.44.2 --config <scratch>/knip.json --reporter json --no-progress --no-exit-code` |
| `knip-production.json` | knip | 6.44.2 | the command above plus `--production` |
| `tsc.txt` | tsc | 6.0.3 | `npx -y -p typescript@6.0.3 tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters --allowUnreachableCode false --tsBuildInfoFile <scratch>/tsconfig.tsbuildinfo --pretty false` |
| `lizard.csv` | lizard | 1.26.1 | `uvx --offline lizard@1.26.1 --csv -Ecognitive -ENS .` |

To regenerate the knip and tsc recordings: write `dead-code-repo.json`'s files into an empty directory, write the registry's
knip `static` mode `knip.json` (its `files` entry) into `<scratch>`, run each command from that
directory, and save stdout. tsc exits 2 on the recorded diagnostics. Both recordings regenerate
identically on the pins above (knip compared as parsed JSON). To regenerate the lizard recording:
write `complexity-repo.json`'s files into an empty directory, run its command there (online first if
the uv cache lacks the pin), and save stdout; lizard exits 0 and lists all five source files.
