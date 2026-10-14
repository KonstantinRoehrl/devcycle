// scripts/ledger-slot.mjs: judging the execution stage's ledger slot and archiving a stale one. Each
// case is a throwaway checkout root holding only the .devcycle/ files it names.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { writeInto } from "./helpers.mjs";
import { PER_TASK_DIRS, ledgerRun, ledgerSlotState, resetLedgerSlot } from "../../scripts/ledger-slot.mjs";

const SCRIPT = fileURLToPath(new URL("../../scripts/ledger-slot.mjs", import.meta.url));
const PLAN = "docs/plan.md";
const RUN = "00000000000000a1";

const ledgerText = ({ plan = PLAN, run = RUN, branch = "feat/x" } = {}) => [
  `Plan: \`${plan}\``, ...(run ? [`Run: \`${run}\``] : []), `Branch: \`${branch}\` (cut from \`main\` at \`0000000\`)`,
  "Profile: `standard` (evidence tail 40 lines)", "", "- [2026-10-13T10:00:00Z] task=1 event=dispatched outcome=sent ref=none", "",
].join("\n");

function slotRoot(files = {}) {
  const root = makeTempDir("ledger-slot-");
  for (const [rel, text] of Object.entries(files)) writeInto(root, join(".devcycle", rel), text);
  return root;
}

const filesBelow = (dir) =>
  existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((rel) => statSync(join(dir, rel)).isFile()).sort() : [];

test("ledgerRun reads the Run: preamble value, backticked or bare, and null without a 16-hex one", () => {
  const root = slotRoot({ "ledger.md": ledgerText(), "bare.md": `Plan: \`${PLAN}\`\nRun: ${RUN}\n`, "old.md": ledgerText({ run: null }),
    "short.md": "Plan: `docs/plan.md`\nRun: `abc`\n" });
  const at = (name) => ledgerRun(join(root, ".devcycle", name));
  assert.deepEqual([at("ledger.md"), at("bare.md"), at("old.md"), at("short.md"), at("missing.md")], [RUN, RUN, null, null, null]);
});

test("a ledger naming another plan is stale", () => {
  const root = slotRoot({ "ledger.md": ledgerText({ plan: "docs/old-plan.md" }) });
  assert.equal(ledgerSlotState({ root, plan: PLAN, run: RUN }), "stale");
});

test("a ledger naming another run is stale, even for the same plan", () => {
  const root = slotRoot({ "ledger.md": ledgerText({ run: "00000000000000b2" }) });
  assert.equal(ledgerSlotState({ root, plan: PLAN, run: RUN }), "stale");
});

test("a ledger with no Run: line is judged by its Plan: alone", () => {
  const same = slotRoot({ "ledger.md": ledgerText({ run: null }) });
  assert.equal(ledgerSlotState({ root: same, plan: PLAN, run: "00000000000000b2" }), "fresh");
  const other = slotRoot({ "ledger.md": ledgerText({ plan: "docs/old-plan.md", run: null }) });
  assert.equal(ledgerSlotState({ root: other, plan: PLAN, run: RUN }), "stale");
});

test("a matching ledger is fresh, whatever per-task files sit beside it", () => {
  const root = slotRoot({ "ledger.md": ledgerText(), "evidence/1-red.txt": "red\n", "briefs/1.md": "brief\n" });
  assert.equal(ledgerSlotState({ root, plan: PLAN, run: RUN }), "fresh");
});

test("with no ledger, a file in any per-task directory makes the slot stale", () => {
  assert.deepEqual(PER_TASK_DIRS, ["briefs", "dispatch", "evidence", "findings", "reports"]);
  for (const dir of PER_TASK_DIRS) {
    const root = slotRoot({ [`${dir}/nested/1.txt`]: "orphan\n" });
    assert.equal(ledgerSlotState({ root, plan: PLAN, run: RUN }), "stale", dir);
  }
});

test("with no ledger and no per-task file, the slot is fresh", () => {
  const root = slotRoot({ "state.md": "# devcycle state\n" });
  for (const dir of PER_TASK_DIRS) mkdirSync(join(root, ".devcycle", dir));
  assert.equal(ledgerSlotState({ root, plan: PLAN, run: RUN }), "fresh");
  assert.equal(ledgerSlotState({ root: makeTempDir("ledger-slot-bare-"), plan: PLAN, run: RUN }), "fresh");
});

const SLOT = {
  "ledger.md": ledgerText({ branch: "Feat/Unattended_Drive!" }),
  "briefs/1.md": "brief one\n",
  "dispatch/1-implementer-0-0.json": "{}\n",
  "evidence/1-red.txt": "red\n",
  "evidence/nested/1-gate.txt": "gate\n",
  "findings/1-review-1.md": "findings\n",
  "reports/1.md": "report\n",
};

test("a reset moves the ledger and every per-task file into a dated, branch-named archive under its own relative path", () => {
  const root = slotRoot(SLOT);
  const r = resetLedgerSlot({ root, today: "2026-10-13" });
  assert.equal(r.archive, ".devcycle/archive-2026-10-13-feat-unattended-drive");
  assert.deepEqual(r.moved.toSorted(), Object.keys(SLOT).map((rel) => `.devcycle/${rel}`).sort());
  assert.deepEqual(r.removed, []);
  for (const [rel, text] of Object.entries(SLOT)) {
    assert.equal(readFileSync(join(root, r.archive, rel), "utf8"), text, rel);
    assert.ok(!existsSync(join(root, ".devcycle", rel)), `${rel} is still in the slot`);
  }
  for (const dir of PER_TASK_DIRS) assert.ok(statSync(join(root, ".devcycle", dir)).isDirectory(), `${dir}/ was removed`);
});

test("a reset removes only a file whose same relative path in an earlier archive holds the same bytes, and loses none", () => {
  const root = slotRoot({
    ...SLOT,
    "archive-2026-10-01-feat-old/evidence/1-red.txt": "red\n", // same path, same bytes: removed
    "archive-2026-10-01-feat-old/reports/1.md": "an older report\n", // same path, other bytes: moved
    "archive-2026-10-02-feat-older/briefs/other.md": "brief one\n", // same bytes, other path: moved
  });
  const before = Object.entries(SLOT);
  const r = resetLedgerSlot({ root, today: "2026-10-13" });
  assert.deepEqual(r.removed, [".devcycle/evidence/1-red.txt"]);
  assert.equal(r.moved.length + r.removed.length, before.length);
  for (const [rel, text] of before) {
    const kept = r.removed.includes(`.devcycle/${rel}`) ? join(root, ".devcycle/archive-2026-10-01-feat-old", rel) : join(root, r.archive, rel);
    assert.equal(readFileSync(kept, "utf8"), text, `${rel} was lost`);
  }
  assert.equal(readFileSync(join(root, ".devcycle/archive-2026-10-01-feat-old/reports/1.md"), "utf8"), "an older report\n");
});

test("a reset takes the first free -<n> suffix when today's archive exists, and `unknown` without a ledger branch", () => {
  const root = slotRoot({ "evidence/1-red.txt": "red\n", "archive-2026-10-13-unknown/keep.txt": "kept\n" });
  assert.equal(resetLedgerSlot({ root, today: "2026-10-13" }).archive, ".devcycle/archive-2026-10-13-unknown-2");
  writeInto(root, ".devcycle/evidence/2-red.txt", "two\n");
  assert.equal(resetLedgerSlot({ root, today: "2026-10-13" }).archive, ".devcycle/archive-2026-10-13-unknown-3");
  assert.deepEqual(filesBelow(join(root, ".devcycle/archive-2026-10-13-unknown")), ["keep.txt"]);
});

test("cli: --state prints the slot, --reset archives a stale one, and usage or environment errors exit 2 or 3", () => {
  const home = makeTempDir("ledger-slot-home-");
  const env = { PATH: process.env.PATH, HOME: home, CLAUDE_DOCTOR_PROJECTS: home };
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: "utf8" });
  const parse = (r) => {
    assert.match(r.stdout, /^\{.*\}\n$/s, r.stderr);
    return JSON.parse(r.stdout);
  };
  const root = slotRoot({ ...SLOT, "state.md": `# devcycle state\n- stage: execution\n- plan: docs/new-plan.md (committed)\n- run: ${RUN}\n` });
  const statePath = join(root, ".devcycle/state.md");

  const judged = run(["--state", statePath]);
  assert.equal(judged.status, 0, judged.stderr);
  const status = parse(judged);
  assert.deepEqual([status.ok, status.slot, status.reset], [true, "stale", undefined]);
  assert.ok(existsSync(join(root, ".devcycle/ledger.md")), "judging alone moved the ledger");

  const reset = parse(run(["--state", statePath, "--reset"]));
  assert.deepEqual([reset.ok, reset.slot, reset.reset, reset.removed], [true, "stale", true, []]);
  assert.match(reset.archive, /^\.devcycle\/archive-\d{4}-\d{2}-\d{2}-feat-unattended-drive$/);
  assert.equal(reset.moved.length, Object.keys(SLOT).length);

  const again = parse(run(["--state", statePath, "--reset"]));
  assert.deepEqual([again.ok, again.slot, again.reset, again.archive], [true, "fresh", false, undefined]);

  for (const args of [[], ["--state"], ["--state", statePath, "--bogus"]]) {
    const r = run(args);
    assert.equal(r.status, 2, args.join(" "));
    const usage = parse(r);
    assert.deepEqual([usage.ok, usage.action], [false, "usage-error"]);
    assert.match(usage.error, /^ledger-slot: /);
  }
  const missing = run(["--state", join(root, "nowhere/.devcycle/state.md")]);
  assert.equal(missing.status, 3);
  assert.match(parse(missing).error, /^ledger-slot: cannot read state file: /);
});
