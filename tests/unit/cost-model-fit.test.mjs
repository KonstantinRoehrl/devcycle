import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { writeInto } from "./helpers.mjs";
import { fitRow, roleKey, fitRoles, readRows } from "../../scripts/cost-model-fit.mjs";

const SCRIPT = new URL("../../scripts/cost-model-fit.mjs", import.meta.url).pathname;

// A dispatch the model describes exactly: floor F, reads r, output o over t turns, so
// X = F + r + o and cacheRead = t * (F + (r + o) / 2).
const row = ({ F, r, o, t, ...over }) => ({
  kind: "agent-cost", stage: "planning", agentType: "general-purpose", agentId: "a1", model: "claude-opus-5-5",
  inputTokens: 10, cacheWriteTokens: F + r + o - 10, cacheReadTokens: t * (F + (r + o) / 2), outputTokens: o,
  usd: 1, turns: t, explicitModel: true, continuationOf: 0, ...over,
});

test("fitRow recovers F, t, r and o from a row the model describes exactly", () => {
  assert.deepEqual(fitRow(row({ F: 51000, r: 30000, o: 10000, t: 30 })), { F: 51000, t: 30, r: 30000, o: 10000 });
  assert.deepEqual(fitRow(row({ F: 14000, r: 6000, o: 2000, t: 4 })), { F: 14000, t: 4, r: 6000, o: 2000 });
});

test("fitRow refuses a continuation, a turnless row and a solve that goes negative", () => {
  assert.equal(fitRow(row({ F: 51000, r: 30000, o: 10000, t: 30, continuationOf: 1 })), null);
  assert.equal(fitRow(row({ F: 51000, r: 30000, o: 10000, t: 0 })), null);
  assert.equal(fitRow({ ...row({ F: 51000, r: 30000, o: 10000, t: 30 }), cacheReadTokens: 10 }), null, "F < 0");
  assert.equal(fitRow({ ...row({ F: 51000, r: 30000, o: 10000, t: 30 }), outputTokens: 900000 }), null, "r < 0");
});

test("roleKey is the planning role, else the agent type", () => {
  assert.equal(roleKey({ role: "drafter", agentType: "general-purpose" }), "drafter");
  assert.equal(roleKey({ agentType: "devcycle:implementer" }), "agent:devcycle:implementer");
});

test("fitRoles takes per-role medians over first stops, counting misfits apart", () => {
  const fit = fitRoles([
    row({ F: 50000, r: 20000, o: 8000, t: 20, role: "drafter" }),
    row({ F: 52000, r: 40000, o: 12000, t: 40, role: "drafter" }),
    { ...row({ F: 50000, r: 20000, o: 8000, t: 20, role: "drafter" }), cacheReadTokens: 1 },
    row({ F: 50000, r: 20000, o: 8000, t: 20, role: "drafter", continuationOf: 2 }),
    row({ F: 30000, r: 10000, o: 4000, t: 10, agentType: "devcycle:implementer", stage: "execution" }),
    { kind: "agent-depth", agentId: "a1" },
  ]);
  assert.deepEqual(fit, {
    "agent:devcycle:implementer": { n: 1, misfit: 0, F: 30000, t: 10, r: 10000, o: 4000 },
    drafter: { n: 2, misfit: 1, F: 51000, t: 30, r: 30000, o: 10000 },
  });
});

test("readRows collects every jsonl record under a runs directory, recursively", () => {
  const dir = makeTempDir("cost-model-fit-");
  writeInto(dir, "repo-1/a.jsonl", JSON.stringify({ kind: "run" }) + "\n" + JSON.stringify(row({ F: 1, r: 1, o: 1, t: 1 })) + "\n");
  writeInto(dir, "repo-2/b.jsonl", JSON.stringify({ kind: "session" }) + "\n");
  writeInto(dir, "repo-2/notes.txt", "ignored\n");
  assert.deepEqual(readRows(dir).map((r) => r.kind).sort(), ["agent-cost", "run", "session"]);
});

test("cli prints the per-role table, --json the object, and refuses a missing --runs", () => {
  const dir = makeTempDir("cost-model-fit-");
  writeInto(dir, "repo-1/a.jsonl", JSON.stringify(row({ F: 30000, r: 10000, o: 4000, t: 10, role: "spike" })) + "\n");
  const table = spawnSync(process.execPath, [SCRIPT, "--runs", dir], { encoding: "utf8" });
  assert.equal(table.status, 0, table.stderr);
  assert.match(table.stdout, /^\| Role \| n \| Misfit \| F \| t \| r \| o \|$/m);
  assert.match(table.stdout, /^\| spike \| 1 \| 0 \| 30000 \| 10 \| 10000 \| 4000 \|$/m);
  const json = spawnSync(process.execPath, [SCRIPT, "--runs", dir, "--json"], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(json.stdout), { spike: { n: 1, misfit: 0, F: 30000, t: 10, r: 10000, o: 4000 } });
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" }).status, 1);
});
