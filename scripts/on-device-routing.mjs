#!/usr/bin/env node
// Which FAILED on-device items still need the user's decision, which run a fix round, and which
// were waived or accepted and carry over — joined from the results report beside the checklist and
// the on-device stage's ledger lines. Callers: playbooks/finishing-the-cycle.md § On-device
// decisions (without --cap, where every open item refuses) and playbooks/verifying-on-device.md
// § Failed items (with the profile's branch-review round cap). Run it as
// `on-device-routing.mjs --state <path> [--cap <n>]`; it prints one JSON object.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { countFlag, parseLedgerLine, runTaskScript, taskFlags } from "./task-ledger.mjs";
import { field } from "./md-field.mjs";

export const ROUTING_TASK = "on-device";
// The ledger outcome the on-device stage writes when the user hands the walk to the probes.
export const DELEGATED_WALK = "delegated-walk (auto-ok)";
// The results report sits beside its checklist (references/checklist.md § Paths), so no state row names it.
export const resultsPathFor = (checklistPath) => join(dirname(checklistPath), "on-device-results.md");

const FAILED_LINE = /^- #(\d+) (.+?): FAILED — (.+) — severity: (high|medium|low)\s*$/;
// What a person writes when the canonical shape slips (a re-walk note, a hyphen, another case or
// severity word, no severity). The match anchors on `: FAILED` right after the item text, so a passed
// line that mentions FAILED later in its prose is not one.
const TOLERANT_FAILED_LINE = /^- #(\d+) (.+?): FAILED\b(.*)$/i;
const MENTIONS_FAILED = /: FAILED\b/i;
const ITEM_DECISION = /^failed-item #(\d+) .*: (fix|accept|waive \((.*)\))$/;
const CAP_EXTENSION = /^review-cap extended to (\d+)$/;

// Fail closed: every line that reads as a failed item parses, so the routing question is asked.
export function failedItems(resultsText) {
  return String(resultsText).split("\n").flatMap((line) => {
    const m = FAILED_LINE.exec(line);
    if (m) return [{ n: Number(m[1]), text: m[2], symptom: m[3], severity: m[4] }];
    const t = TOLERANT_FAILED_LINE.exec(line);
    if (!t) return [];
    const severity = /severity:\s*(\w+)/i.exec(t[3])?.[1].toLowerCase() ?? "unknown";
    return [{ n: Number(t[1]), text: t[2], symptom: t[3].trim(), severity }];
  });
}

// FAILED lines with no `#<n>` ordinal: there is no item to decide on, so the caller must not close over them.
export function malformedLines(resultsText) {
  return String(resultsText).split("\n").filter((line) => MENTIONS_FAILED.test(line) && !TOLERANT_FAILED_LINE.test(line));
}

// Entries are in ledger order, so a later decision on the same item overwrites an earlier one.
export function itemDecisions(entries) {
  const decisions = new Map();
  for (const e of entries) {
    if (e.task !== ROUTING_TASK || e.event !== "user-decision") continue;
    const m = ITEM_DECISION.exec(e.outcome);
    if (!m) continue;
    const decision = m[2].startsWith("waive") ? "waive" : m[2];
    decisions.set(Number(m[1]), { decision, reason: m[3] ?? null });
  }
  return decisions;
}

// Only this cycle's lines count: item decisions carry the results path as their ref, the delegated
// walk the checklist path, and the round lines and a cap extension the spec path.
// At the round cap a `fix` decision is spent, so the item goes back to the user as undecided.
export function routing({ resultsText, entries, specPath, checklist, cap }) {
  const own = entries.filter((e) => e.task === ROUTING_TASK);
  const userDecisions = own.filter((e) => e.event === "user-decision");
  const round = own.filter((e) => e.event === "review-round" && e.ref === specPath).length;
  const extension = userDecisions.filter((e) => e.ref === specPath).map((e) => CAP_EXTENSION.exec(e.outcome)).filter(Boolean).at(-1);
  const effectiveCap = extension ? Number(extension[1]) : cap;
  const atCap = effectiveCap !== null && round >= effectiveCap;
  const resultsPath = checklist ? resultsPathFor(checklist) : null;
  const decisions = itemDecisions(own.filter((e) => e.ref === resultsPath));
  const failed = failedItems(resultsText);
  const undecided = [];
  const toFix = [];
  const carried = [];
  for (const item of failed) {
    const d = decisions.get(item.n);
    if (!d || (d.decision === "fix" && atCap)) undecided.push(item.n);
    else if (d.decision === "fix") toFix.push(item.n);
    else carried.push({ ...item, decision: d.decision, reason: d.reason });
  }
  const delegated = userDecisions.some((e) => e.outcome === DELEGATED_WALK && e.ref === checklist);
  return { failed, malformed: malformedLines(resultsText), undecided, toFix, carried, round, cap: effectiveCap, atCap, delegated };
}

// An absent report or ledger is "nothing failed", never an environment error.
const readOrEmpty = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");

function main(argv) {
  runTaskScript("on-device-routing", () => {
    const flags = taskFlags(argv, { "--state": "value", "--cap": "value" }, ["--state"]);
    const cap = countFlag(flags, "--cap", 1) ?? null;
    const statePath = resolve(flags["--state"]);
    const root = dirname(dirname(statePath));
    if (!existsSync(statePath)) throw new Error(`no state file at ${statePath}`);
    const state = readFileSync(statePath, "utf8");
    const checklist = field(state, "checklist");
    const specPath = field(state, "spec")?.replace(/\s+\(.*\)$/, "") ?? null;
    const ledger = field(state, "ledger");
    const hasChecklist = checklist && !/^none\b/.test(checklist);
    const results = hasChecklist ? resultsPathFor(checklist) : null;
    const resultsText = results ? readOrEmpty(join(root, results)) : "";
    const entries = ledger ? readOrEmpty(join(root, ledger)).split("\n").map(parseLedgerLine).filter(Boolean) : [];
    return { results, ...routing({ resultsText, entries, specPath, checklist: hasChecklist ? checklist : null, cap }) };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
