import { test } from "node:test";
import assert from "node:assert/strict";
import { proportionLeg, PROPORTION } from "../../scripts/proportion-check.mjs";

const spec = `${"s".repeat(99)}\n`; // 100 bytes
const prose = (bytes) => `${"p".repeat(bytes - 1)}\n`;
const fenced = (proseBytes, bodyBytes) => `${prose(proseBytes)}\`\`\`js\n${"x".repeat(bodyBytes - 1)}\n\`\`\`\n`;
const REMEDY = 'cut code bodies to the contract, or record "- Proportion override: <reason>"';

test("the thresholds are the spec's initial figures, frozen", () => {
  assert.deepEqual(PROPORTION, { warnRatio: 5, failRatio: 8, warnFenceShare: 0.3, failFenceShare: 0.45 });
  assert.ok(Object.isFrozen(PROPORTION));
});

test("no spec means nothing is measured", () => {
  const none = { findings: [], notes: ["no spec — proportion not measured"] };
  assert.deepEqual(proportionLeg(prose(5000), { specText: null }), none);
  assert.deepEqual(proportionLeg(prose(5000), {}), none);
  assert.deepEqual(proportionLeg(prose(5000), { specText: "" }), none);
});

test("within both targets the leg is silent", () => {
  assert.deepEqual(proportionLeg(prose(500), { specText: spec }), { findings: [], notes: [] });
});

test("plan/spec above 5× is a note, above 8× a finding only", () => {
  assert.deepEqual(proportionLeg(prose(600), { specText: spec }), { findings: [], notes: ["plan/spec 6.0× is above the 5× target"] });
  assert.deepEqual(proportionLeg(prose(900), { specText: spec }), { findings: [`plan/spec 9.0× exceeds the 8× limit — ${REMEDY}`], notes: [] });
});

test("code-fence share above 30% is a note, above 45% a finding only", () => {
  // 60 prose + 6 + 30 + 4 = 100 bytes, 40 fenced; 50 prose + 6 + 40 + 4 = 100 bytes, 50 fenced.
  assert.deepEqual(proportionLeg(fenced(60, 30), { specText: spec }), { findings: [], notes: ["code-fence share 40% is above the 30% target"] });
  assert.deepEqual(proportionLeg(fenced(50, 40), { specText: spec }), { findings: [`code-fence share 50% exceeds the 45% limit — ${REMEDY}`], notes: [] });
});

test("a reasoned override turns each finding into a note; a reasonless one fails first", () => {
  const reason = "the spec defers every format to this plan";
  const overridden = `${prose(835)}- Proportion override: ${reason}\n`; // 835 + 65 = 900 bytes
  assert.deepEqual(proportionLeg(overridden, { specText: spec }), { findings: [], notes: [`plan/spec 9.0× exceeds the 8× limit (overridden: ${reason})`] });
  const bare = `${prose(880)}- Proportion override:\n`; // 903 bytes
  assert.deepEqual(proportionLeg(bare, { specText: spec }).findings, [
    'malformed Proportion override (needs "<reason>")',
    `plan/spec 9.0× exceeds the 8× limit — ${REMEDY}`,
  ]);
});

test("an override quoted inside a fenced block does not count", () => {
  const quoted = `${prose(800)}\`\`\`text\n- Proportion override: quoted\n\`\`\`\n`; // 842 bytes
  assert.deepEqual(proportionLeg(quoted, { specText: spec }).findings, [`plan/spec 8.4× exceeds the 8× limit — ${REMEDY}`]);
});
