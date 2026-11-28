import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const playbook = read("../../playbooks/maintaining-the-repo.md");
const config = read("../../references/config.md");

test("config.md tracks the maintenance-findings store like promotions", () => {
  assert.match(config, /docs\/devcycle\/maintenance-findings\//);
});

test("the playbook writes the store only through the maintenance-findings CLI", () => {
  assert.match(playbook, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/maintenance-findings\.mjs"/);
  for (const verb of ["apply-pass", "dismiss", "stranded"]) assert.match(playbook, new RegExp(verb));
  assert.match(playbook, /docTrackingPolicy/);
  assert.doesNotMatch(playbook, /recordMaintenanceFinding|removeMaintenanceFinding|verifyMaintenance/);
});

test("the playbook renders the three longitudinal sections and the lens-cost rollup", () => {
  assert.match(playbook, /Previously known \(persisting\)/);
  assert.match(playbook, /Resolved since last pass/);
  assert.match(playbook, /Trending/);
  assert.match(playbook, /lens-cost/);
});

test("the playbook keeps dismissal load-bearing and revocable", () => {
  assert.match(playbook, /load-bearing/);
  assert.match(playbook, /never auto-re-evaluated/);
  assert.match(playbook, /--revoke/);
});

test("resolution deletes records, and only on the user's confirmation of a whole pass", () => {
  assert.match(playbook, /deleted, not written/);
  assert.match(playbook, /never accumulates settled history/);
  assert.match(playbook, /not assessed: partial pass/);
  assert.match(playbook, /--resolve/);
});

test("the store holds no issue records and has no regressed state", () => {
  assert.doesNotMatch(playbook, /github-issue:<n>|`github-issue` record|regressed/);
});

test("a pass checks for stranded store writes before it spends anything", () => {
  assert.match(playbook, /\*\*Pass start/);
  assert.match(playbook, /stranded --base/);
});

test("store writes land from a worktree branch through a confirmed PR", () => {
  assert.match(playbook, /chore\/maintenance-findings-<date>/);
  assert.match(playbook, /git worktree add -b/);
  assert.match(playbook, /not landed/);
  assert.match(playbook, /references\/branch\.md` § Committing/);
});

const between = (text, start, end) => {
  const from = text.indexOf(start);
  assert.notEqual(from, -1, `missing section start: ${start}`);
  const to = text.indexOf(end, from + start.length);
  return text.slice(from, to === -1 ? undefined : to);
};
const passStart = between(playbook, "**Pass start", "1. **Resolve maintenance depth");
const step8 = between(playbook, "8. **Persistence", "## Fan-out ceiling");

test("the doc-tracking veto is decided before the comparison, so a veto previews the store it writes", () => {
  const compare = step8.indexOf("**Compare against the store");
  assert.notEqual(compare, -1);
  for (const veto of ["docTrackingPolicy", "git check-ignore"]) {
    const at = step8.indexOf(veto);
    assert.ok(at !== -1 && at < compare, `${veto} must be resolved before the store comparison`);
  }
  assert.match(step8, /--ref "\$base"/);
  assert.match(step8, /--root <checkout>`?,? no `--ref`/);
  assert.match(step8, /preview and the write read the same store/);
  assert.match(step8, /--root <checkout>[^.]*--resolve[^.]*confirmed/);
});

test("folded GitHub issues are ranked in the pass document but never written to the pass file", () => {
  assert.match(between(step8, "**Write the pass file.**", "   - **"), /Origin: github-issue/);
});

test("a pass fetches its base first, and gh pr create takes the bare branch name", () => {
  assert.match(passStart, /git fetch origin/);
  assert.match(passStart, /origin\/<name>/);
  assert.match(passStart, /offline|no `origin` remote/);
  assert.match(passStart, /stranded --base "\$base"/);
  assert.match(step8, /git worktree add -b [^\n]* "\$base"/);
  assert.match(step8, /gh pr create --base "\$base_branch"/);
  assert.doesNotMatch(playbook, /gh pr create --base "\$base"/);
});

test("the base binds to origin/<name> whenever it resolves, fetched now or earlier, with one rule", () => {
  assert.match(passStart, /`origin\/<name>` whenever it resolves/);
  assert.match(passStart, /references\/branch\.md` § "Names first"/);
  assert.doesNotMatch(passStart, /else to the bare name/);
  assert.doesNotMatch(passStart, /`\$base` is the local branch/);
});

test("the staleness warning fires whenever the base is not a freshly fetched remote-tracking ref", () => {
  assert.match(
    passStart,
    /fetch fails[^.]*or `origin\/<name>` [^.]*does not resolve[^.]*may miss store records/,
  );
});

const step1 = between(playbook, "1. **Resolve maintenance depth", "2. **Scoping gate");
const step2 = between(playbook, "2. **Scoping gate", "3. **Orientation");
const step4 = between(playbook, "4. **Deterministic-facts pre-pass", "5. **History");
const step6 = between(playbook, "6. **Depth-gated criteria", "7. **GitHub issues");

test("a pass mints its own run record before any dispatch, so every --run <runId> names a real run", () => {
  assert.match(step1, /scripts\/run-record\.mjs" new --plugin-version/);
  assert.match(step1, /--kind session --sessionId "\$CLAUDE_CODE_SESSION_ID"/);
  assert.match(step1, /its own Bash call/);
});

test("the scoping gate asks this pass's sweep consent and records it on the run", () => {
  assert.match(step2, /references\/hygiene-sweeps\.md` § Classes and consent/);
  assert.match(step2, /--kind sweep-consent --consentExecuting true\|false --consentCoverage true\|false/);
});

test("step 4 runs the sweep at every depth, by consent, and verifies it in one dispatch", () => {
  assert.match(step4, /hygiene-sweep\.mjs" run --out \.devcycle\/maintain\/sweep-<date>/);
  assert.match(step4, /--consent-executing/);
  assert.match(step4, /--consent-coverage/);
  assert.match(step4, /references\/hygiene-sweeps\.md` § Verification/);
  assert.match(step4, /<dir>\/verdicts\.json/);
  assert.match(step4, /every depth/);
  assert.match(step4, /--hotspots \.devcycle\/maintain\/sweep-<date>\/hotspots\.txt/);
  assert.match(step4, /names every pre-pass source that did not run/);
  assert.match(step4, /every area or kind a source that did run left unchecked/);
});

test("the plugin-only checks run only in devcycle's own source", () => {
  const gate = step4.indexOf('self-dev-check.mjs" --is-source');
  assert.notEqual(gate, -1);
  for (const check of ["duplication-check.mjs", "dead-export-check.mjs", "xref-check.mjs"]) {
    const at = step4.indexOf(check);
    assert.ok(at > gate, `${check} must come after the --is-source gate`);
  }
  assert.match(step4, /not covered:/);
});

test("lenses get the verified clusters instead of the dead-code criterion", () => {
  assert.match(step6, /\*\*dead or unreachable code\*\*/);
  assert.match(step6, /verified clusters/);
});

test("step 8 folds the sweep in and resolves a sweep kind only when its sources all ran", () => {
  assert.match(step8, /hygiene-sweep\.mjs" finalize --dir <dir> --verdicts <dir>\/verdicts\.json --run <runId>/);
  assert.match(step8, /--depth <depth>/);
  assert.match(step8, /<dir>\/section-<sweep>\.md/);
  assert.match(step8, /<dir>\/entries\.json/);
  assert.match(step8, /--sweep-coverage <dir>\/coverage\.json/);
  assert.match(step8, /fullKinds/);
  assert.match(step8, /a sweep gap is not one of these/);
});

const resolutionBullet = between(step8, "**Resolution", "   - **Offer dismissal");

test("every apply-pass instruction carries the resolution flags together, tied to the confirmed dry run", () => {
  assert.doesNotMatch(playbook, /apply-pass \[--resolve\]/, "the bracketed form lets --sweep-coverage alone delete records");
  assert.match(resolutionBullet, /only on a confirmed run/);
  assert.match(resolutionBullet, /a decline passes neither/);
  assert.match(step8, /Run `apply-pass --root <worktree>`[^.]*confirmed dry run's resolution flags/);
});

test("sweep resolution is refused when the pass has no finalized sweep, and the statement says why", () => {
  assert.match(resolutionBullet, /no finalized sweep/);
  assert.match(resolutionBullet, /pass no `--sweep-coverage`/);
  assert.match(resolutionBullet, /and no sweep kind resolves/);
});

const criteria = read("../../references/quality-criteria.md");

test("the documentation criteria name a measuring source beyond the repo's convention", () => {
  const section = between(criteria, "## Documentation standard", "## Multi-file feature chains");
  assert.match(section, /Measured against the repo's/);
  for (const source of ["PEP 257", "Go doc comments", "TSDoc"]) assert.match(section, new RegExp(source));
  assert.match(between(criteria, "- **undocumented code**", "- docs-vs-reality"), /measured against:/);
});
