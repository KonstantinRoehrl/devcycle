// Plan gate leg `crossTask`: tasks are read alone, so what one task consumes from another must be
// something that other task pins, and no brief may defer its content ("TBD", "similar to Task N").
// A definition two tasks pin with differing text is a note. Reads each task's own brief through
// task-files.mjs. See references/plan-task-format.md; `plan-check.mjs --help` lists the legs.
import { taskBlocks, fencedBlocks, lineFences, interfaceLines } from "./task-files.mjs";

const SPAN_RE = /`([^`\n]+)`/g;
const PLACEHOLDER_RES = [/\b(?:TBD|TODO)\b/g, /\b(?:implement later|fill in details|add appropriate error handling|add validation|handle edge cases)\b/gi];
const BACK_REFERENCE_RE = /\b(?:similar to|same as) Task \d+\b/gi;
const PROSE_FENCE_INFOS = new Set(["text", "txt", "markdown", "md"]);
const DEFINITION_RE = /^(?:export\s+)?(?:async\s+)?(?:function\*?\s+|class\s+|(?:const|let|var)\s+)([A-Za-z_$][\w$]*)/;

const lineOfOffset = (planText, offset) => planText.slice(0, offset).split("\n").length;

function consumesFindings(blocks) {
  const defined = new Map(blocks.map(({ num, text }) => [num, text]));
  const findings = [];
  const notes = [];
  for (const { num, text } of blocks) {
    for (const { from, text: item } of interfaceLines(text).consumes) {
      if (from.length === 0) continue;
      const missing = from.filter((p) => !defined.has(p));
      for (const p of missing) findings.push(`Task ${num}: consumes from Task ${p}, which the plan does not define`);
      if (missing.length) continue;
      const spans = [...item.matchAll(SPAN_RE)].map((m) => m[1]);
      if (spans.length === 0) {
        notes.push(`Task ${num}: a Consumes (Task ${from.join("+")}) line pins no code span, so it cannot be checked`);
        continue;
      }
      const produced = from.flatMap((p) => interfaceLines(defined.get(p)).produces).join("\n");
      for (const span of spans)
        if (!produced.includes(span))
          findings.push(`Task ${num}: consumes \`${span}\` from Task ${from.join("+")}, which no Produces line of Task ${from.join("+")} carries`);
    }
  }
  return { findings, notes };
}

function proseFindings(planText, blocks) {
  const hits = [];
  let from = 0;
  for (const { num, text } of blocks) {
    const start = planText.indexOf(text, from);
    from = start + 1;
    const firstLine = lineOfOffset(planText, start);
    const fences = lineFences(text);
    for (const [i, line] of text.split("\n").entries()) {
      if (fences[i]) continue;
      const prose = line.replace(SPAN_RE, "");
      const line1 = firstLine + i;
      for (const re of PLACEHOLDER_RES)
        for (const m of prose.matchAll(re))
          hits.push({ line: line1, at: m.index, text: `Task ${num}: placeholder "${m[0]}" at plan line ${line1} — write the content, or quote the phrase in a code span` });
      for (const m of prose.matchAll(BACK_REFERENCE_RE))
        hits.push({ line: line1, at: m.index, text: `Task ${num}: back-reference "${m[0]}" at plan line ${line1} — repeat what it refers to; tasks are read alone` });
    }
  }
  return hits.sort((a, b) => a.line - b.line || a.at - b.at).map((h) => h.text);
}

// Per task, each definition a code fence pins: it opens on a column-0 declaration and runs to the
// line before the next blank line or the fence's close.
function definitionsOf(text) {
  const lines = text.split("\n");
  const defs = new Map();
  for (const block of fencedBlocks(text)) {
    if (PROSE_FENCE_INFOS.has(block.info)) continue;
    const end = block.close ?? lines.length;
    for (let i = block.open + 1; i < end; i++) {
      const name = lines[i].match(DEFINITION_RE)?.[1];
      if (!name) continue;
      let j = i + 1;
      while (j < end && lines[j].trim() !== "") j++;
      if (!defs.has(name)) defs.set(name, lines.slice(i, j).join("\n"));
      i = j;
    }
  }
  return defs;
}

function mirrorNotes(blocks) {
  const byName = new Map();
  for (const { num, text } of blocks)
    for (const [name, body] of definitionsOf(text)) byName.set(name, [...(byName.get(name) ?? []), { num, body }]);
  const notes = [];
  for (const [name, defs] of byName) {
    const pair = defs.flatMap((a, i) => defs.slice(i + 1).map((b) => [a, b])).find(([a, b]) => a.body !== b.body);
    if (pair) notes.push(`mirrored definition \`${name}\` differs between Task ${pair[0].num} and Task ${pair[1].num}`);
  }
  return notes;
}

export function crossTaskLeg(planText) {
  const blocks = taskBlocks(planText, { stopAtPlanSection: true });
  const consumes = consumesFindings(blocks);
  return {
    findings: [...consumes.findings, ...proseFindings(planText, blocks)],
    notes: [...consumes.notes, ...mirrorNotes(blocks)],
  };
}
