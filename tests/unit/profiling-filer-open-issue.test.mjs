// The filer's "already filed?" check in playbooks/profiling-sessions.md. The step is prose, so what
// can be pinned is where it sits and what it must not do: it runs after the redaction screen and
// before the draft is recorded, it looks only at open issues by exact title, and it comments rather
// than creates — the creating step stays the one the consent-path test in doctor-report.test.mjs binds.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEVCYCLE_UPSTREAM } from "../../scripts/doctor.mjs";

const playbook = readFileSync(join(process.cwd(), "playbooks/profiling-sessions.md"), "utf8");
const items = playbook.split(/\n(?=\d+\. |#{2,3} )/);
const itemWith = (needle) => items.findIndex((p) => p.includes(needle));

test("the already-open check sits between the redaction screen and the Drafted: marker", () => {
  const screen = itemWith('redaction-check.mjs" --file');
  const check = itemWith("gh issue list");
  const marker = itemWith("Drafted: [culprit:");
  assert.ok(screen !== -1 && check !== -1 && marker !== -1, "the playbook lost the screen, the check or the marker");
  assert.ok(screen < check && check < marker, "the check must run after the screen and before the draft is recorded");
});

test("the check matches open issues on the draft's exact title and comments instead of filing", () => {
  const step = items[itemWith("gh issue list")];
  assert.match(step, /gh issue list --repo <repo> --state open/);
  assert.match(step, /character for character/);
  assert.match(step, /gh issue comment <N> --repo <repo> --body-file/);
  assert.doesNotMatch(step, /gh issue create/, "the filing command belongs to the consent step alone");
  assert.doesNotMatch(step, /first gate|second gate/, "the consent test orders those phrases against the marker");
  assert.ok(!step.includes(DEVCYCLE_UPSTREAM), "the upstream slug has one owner, the draft's repo: line");
});
