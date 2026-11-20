// Plan gate leg `proportion`: a plan stays in proportion to the spec it implements. Plan bytes against
// spec bytes, and the share of the plan inside code fences, each have a warn figure (a note) and a fail
// figure (a finding) unless a `- Proportion override: <reason>` line outside a fence says why.
// See references/plan-task-format.md; `plan-check.mjs --help` lists the legs.
import { fenceShare, lineFences } from "./task-files.mjs";

export const PROPORTION = Object.freeze({ warnRatio: 5, failRatio: 8, warnFenceShare: 0.3, failFenceShare: 0.45 });

const OVERRIDE_RE = /^\s*-\s*Proportion override:\s*(.*)$/;
const REMEDY = 'cut code bodies to the contract, or record "- Proportion override: <reason>"';

// The first override line outside every fenced block, or null.
function overrideOf(planText) {
  const fences = lineFences(planText);
  for (const [i, line] of planText.split("\n").entries()) {
    const m = !fences[i] && line.match(OVERRIDE_RE);
    if (m) return { reason: m[1].trim() };
  }
  return null;
}

export function proportionLeg(planText, { specText = null } = {}) {
  if (!specText) return { findings: [], notes: ["no spec — proportion not measured"] };
  const ratio = Math.round((Buffer.byteLength(planText) / Buffer.byteLength(specText)) * 10) / 10;
  const share = fenceShare(planText);
  const pct = Math.round(share * 100);
  const findings = [];
  const notes = [];
  const measure = (value, { warn, fail }, failText, warnText) => {
    if (value > fail) findings.push(`${failText} — ${REMEDY}`);
    else if (value > warn) notes.push(warnText);
  };
  measure(ratio, { warn: PROPORTION.warnRatio, fail: PROPORTION.failRatio },
    `plan/spec ${ratio.toFixed(1)}× exceeds the ${PROPORTION.failRatio}× limit`,
    `plan/spec ${ratio.toFixed(1)}× is above the ${PROPORTION.warnRatio}× target`);
  measure(share, { warn: PROPORTION.warnFenceShare, fail: PROPORTION.failFenceShare },
    `code-fence share ${pct}% exceeds the ${Math.round(PROPORTION.failFenceShare * 100)}% limit`,
    `code-fence share ${pct}% is above the ${Math.round(PROPORTION.warnFenceShare * 100)}% target`);
  const override = findings.length ? overrideOf(planText) : null;
  if (override === null) return { findings, notes };
  if (override.reason === "")
    return { findings: ['malformed Proportion override (needs "<reason>")', ...findings], notes };
  return { findings: [], notes: [...notes, ...findings.map((f) => `${f.split(" — ")[0]} (overridden: ${override.reason})`)] };
}
