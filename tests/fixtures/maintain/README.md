# Maintain fixtures

Data for the `/devcycle:maintain` hygiene sweep's suites. `dead-code-repo.json` is a path → content
map of a small JS/Angular repo with known dead code and decoys; `hygiene-sweep-fixture.test.mjs`
writes it out per test. `graph-repo/`, `no-graph-repo/` and `issues/` feed the graph and issue folds.

## Recorded tool output

`sweep-tool-outputs/` holds real output from the tools the registry pins, recorded against the
fixture tree their row names (`dead-code-repo.json` for knip and tsc, `duplication-repo.json` for
jscpd), and replayed so the suites stay offline. The replay stub answers
`--version` with a placeholder, so nothing at runtime ties a recording to its pin;
`hygiene-sweep-fixture.test.mjs` does, by failing when a version below differs from
`references/hygiene-sweeps.json`. A pin bump means re-recording and updating the row.

| Recording | Tool | Pinned version | Command |
| --- | --- | --- | --- |
| `knip-default.json` | knip | 6.44.2 | `npx -y knip@6.44.2 --config <scratch>/knip.json --reporter json --no-progress --no-exit-code` |
| `knip-production.json` | knip | 6.44.2 | the command above plus `--production` |
| `tsc.txt` | tsc | 6.0.3 | `npx -y -p typescript@6.0.3 tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters --allowUnreachableCode false --tsBuildInfoFile <scratch>/tsconfig.tsbuildinfo --pretty false` |
| `jscpd.json` | jscpd | 5.4.3 | `npx -y jscpd@5.4.3 --reporters json --output <scratch>/report --silent --min-tokens 50 --ignore <the registry's list> .` |

To regenerate: write `dead-code-repo.json`'s files into an empty directory, write the registry's
knip `static` mode `knip.json` (its `files` entry) into `<scratch>`, run each command from that
directory, and save stdout. tsc exits 2 on the recorded diagnostics. Both recordings regenerate
identically on the pins above (knip compared as parsed JSON). For jscpd, write
`duplication-repo.json`'s files into an empty directory, run the command there and save
`<scratch>/report/jscpd-report.json`.
