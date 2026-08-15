import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runsObserved } from "./journal.mjs";
import { cmpSemver, SEMVER_RE } from "./semver.mjs";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RETIRE_RUNS = 10, RETIRE_DAYS = 90, DAY_MS = 86_400_000;

export function installedVersion() {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8")).version ?? null;
  } catch { return null; }
}

export function defaultRunCheck(verifyVal, { root = process.cwd() } = {}) {
  const target = join(root, verifyVal);
  const isCommand = verifyVal.includes(" ") || !existsSafe(target);
  try {
    if (isCommand) {
      const r = spawnSync("/bin/sh", ["-c", verifyVal], { cwd: root });
      return { ran: r.status !== null, ok: r.status === 0 };
    }
    return { ran: true, ok: true };           // present path: statted, exists → held
  } catch { return { ran: false, ok: false }; }
}
function existsSafe(p) { try { readFileSync(p); return true; } catch { return false; } }

export function verify(promotions, journalEvents, installed, opts = {}) {
  const { now = Date.now(), runCheck = defaultRunCheck, vocab = loadVocab(), root = process.cwd() } = opts;
  const scored = promotions.filter((p) => !p.lifecycle && p.culpritId);
  const scoreboard = [], escalation = [], retirement = [];
  for (const p of scored) {
    const ids = new Set([p.culpritId, ...(p.aliases ?? [])]);
    if (p.rung === "r3" && p.verify && p.verify !== "journal-recurrence") {
      const { ran, ok } = runCheck(p.verify, { root });
      const verdict = !ran ? "unmeasurable" : ok ? "held" : "broken";
      scoreboard.push({ culpritId: p.culpritId, rung: p.rung, verdict, runsObserved: 0, recurrences: 0, detail: p.verify });
      continue;
    }
    const after = journalEvents.filter((e) => String(e.ts).slice(0, 10) > p.landed);
    const runs = runsObserved(after);
    const recurrences = after.filter((e) => e.culprit && ids.has(e.culprit)).length;
    const verdict = runs === 0 ? "unmeasurable" : recurrences > 0 ? "recurred" : "held";
    scoreboard.push({ culpritId: p.culpritId, rung: p.rung, verdict, runsObserved: runs, recurrences, detail: null });
    if (verdict === "recurred" && p.rung === "r2") escalation.push({ culpritId: p.culpritId, rung: p.rung, reason: `recurred ${recurrences}×` });
    if (verdict === "held" && (p.rung === "r1" || p.rung === "r2")
        && (runs >= RETIRE_RUNS || now - Date.parse(p.landed) >= RETIRE_DAYS * DAY_MS)) {
      retirement.push({ culpritId: p.culpritId, rung: p.rung, reason: `held ${runs} runs since ${p.landed}` });
    }
  }
  const resolvedIn = vocab.filter((e) => e && e["resolved-in"]).map((e) => {
    const id = `${e.kind}:${e.slug}`;
    const reached = installed && SEMVER_RE.test(installed) && cmpSemver(installed, e["resolved-in"]) >= 0;
    const after = reached ? journalEvents.filter((ev) => ev.culprit === id) : [];
    const runs = runsObserved(after);
    const verdict = !reached || runs === 0 ? "unmeasurable" : after.length > 0 ? "recurred" : "held";
    return { culpritId: id, resolvedIn: e["resolved-in"], verdict, runsObserved: runs };
  });
  return { scoreboard, candidates: { escalation, retirement }, resolvedIn };
}

function loadVocab() {
  try { return JSON.parse(readFileSync(join(PLUGIN_ROOT, "references", "culprits.json"), "utf8")); }
  catch { return []; }
}
