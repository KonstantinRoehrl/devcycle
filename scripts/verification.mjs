import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runsObserved } from "./journal.mjs";
import { cmpSemver, SEMVER_RE } from "./semver.mjs";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RETIRE_RUNS = 10, RETIRE_DAYS = 90, DAY_MS = 86_400_000;
const RELEASE_CHANGELOG_PATH = join(PLUGIN_ROOT, "CHANGELOG.md");

export function installedVersion() {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8")).version ?? null;
  } catch { return null; }
}

// Release dates come from the plugin's own CHANGELOG.md headings. A heading with no date is
// omitted rather than defaulted: a window measured against a made-up release date is a number
// that reads as fact and is not one. The resolved-in verdict is the one consumer here, and doctor
// imports this same parser so the two cannot drift.
export function releaseDates(changelogText) {
  const dates = new Map();
  for (const m of String(changelogText).matchAll(/^## (\d+\.\d+\.\d+) — (\d{4}-\d{2}-\d{2})[ \t]*$/gm))
    dates.set(m[1], m[2]);
  return dates;
}
// The real default injected into verify's `releaseDates` opt, on the now/runCheck/vocab pattern:
// read+parse the shipped changelog, degrade to an empty Map on any failure rather than throw.
function loadReleaseDates() {
  try { return releaseDates(readFileSync(RELEASE_CHANGELOG_PATH, "utf8")); }
  catch { return new Map(); }
}

export function defaultRunCheck(verifyVal, { root = process.cwd() } = {}) {
  const target = join(root, verifyVal);
  const isCommand = verifyVal.includes(" ") || !existsSafe(target);
  try {
    if (isCommand) {
      const r = spawnSync("/bin/sh", ["-c", verifyVal], { cwd: root });
      return { ran: r.status !== null, ok: r.status === 0 };
    }
    const runner = runnableCheck(verifyVal, target);
    if (runner) {                             // present runnable script/test: run it, use its exit code
      const r = spawnSync(runner[0], runner.slice(1), { cwd: root });
      return { ran: r.status !== null, ok: r.status === 0 };
    }
    return { ran: false, ok: false };         // present but not runnable-as-a-check: cannot verify → unmeasurable, never a stat-only "held"
  } catch { return { ran: false, ok: false }; }
}
// The argv for running a verify: path as a check, or null when the path is not runnable-as-a-check
// (statted instead). Test files run under the node test runner; other scripts run directly.
function runnableCheck(verifyVal, target) {
  if (/\.test\.m?js$/.test(verifyVal)) return ["node", "--test", target];
  if (/\.m?js$/.test(verifyVal)) return ["node", target];
  if (/\.sh$/.test(verifyVal)) return ["/bin/sh", target];
  return null;
}
function existsSafe(p) { try { readFileSync(p); return true; } catch { return false; } }

export function verify(promotions, journalEvents, installed, opts = {}) {
  const { now = Date.now(), runCheck = defaultRunCheck, vocab = loadVocab(), root = process.cwd(),
    releaseDates: relDates = loadReleaseDates() } = opts;
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
    const rv = e["resolved-in"];
    const reached = installed && SEMVER_RE.test(installed) && cmpSemver(installed, rv) >= 0;
    const since = reached ? (relDates.get(rv) ?? null) : null;   // CHANGELOG date of the resolving version
    const after = since ? journalEvents.filter((ev) => String(ev.ts).slice(0, 10) > since) : [];
    const runs = runsObserved(after);
    const recurrences = after.filter((ev) => ev.culprit === id).length;
    const verdict = (!reached || !since || runs === 0) ? "unmeasurable" : recurrences > 0 ? "recurred" : "held";
    return { culpritId: id, resolvedIn: rv, verdict, runsObserved: runs };
  });
  return { scoreboard, candidates: { escalation, retirement }, resolvedIn };
}

function loadVocab() {
  try { return JSON.parse(readFileSync(join(PLUGIN_ROOT, "references", "culprits.json"), "utf8")); }
  catch { return []; }
}
