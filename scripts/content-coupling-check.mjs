#!/usr/bin/env node
// Pre-flight check for a devcycle plan's "## Dispatch Map": two tasks in the SAME wave whose
// file sets are disjoint (so wave-disjointness-check passes) can still be content-coupled --
// one task's brief names a file another same-wave task edits (a rule that reads a table a
// sibling rewrites). Neither implementer sees the other's in-flight edit. This catches that
// class; wave-disjointness-check catches only literal Files-block overlap. See
// playbooks/planning-waves.md.
import { readFileSync, existsSync } from "node:fs";
import { taskBlocks, taskFileMap, parseDispatchMap, filesFieldValue } from "./task-files.mjs";

const planPath = process.argv[2];
if (!planPath) {
  console.error("usage: node scripts/content-coupling-check.mjs <plan-file>");
  process.exit(1);
}
if (!existsSync(planPath)) {
  console.error(`content-coupling-check: plan file not found: ${planPath}`);
  process.exit(1);
}

const text = readFileSync(planPath, "utf8");
const blocks = new Map(taskBlocks(text).map((b) => [b.num, b.text]));
const filesByTask = taskFileMap(text);
const waves = parseDispatchMap(text);

// A parse failure is not a clean plan: mirror wave-disjointness-check's guard so an empty parse
// never prints ok. No "### Task N" blocks, or no Dispatch Map, means this check cannot run.
if (blocks.size === 0) {
  console.error(`content-coupling-check: no "### Task N" blocks found in ${planPath}`);
  process.exit(1);
}
if (waves === null) {
  console.log(`content-coupling-check: no "## Dispatch Map" section found in ${planPath} -- cannot verify content coupling`);
  process.exit(0);
}

// Overrides: "- Content-coupling override: Task <B> → <file> (Task <A>) — <reason>". A missing
// reason is a hard error, exactly the silent walk-around this gate exists to prevent.
const OVERRIDE_START = /^\s*-\s*Content-coupling override:/;
const OVERRIDE_RE = /^\s*-\s*Content-coupling override:\s*Task\s+(\d+)\s*→\s*(\S+)\s*\(Task\s+(\d+)\)\s*—\s*(.*\S)\s*$/;
const overrides = [];
for (const line of text.split("\n")) {
  if (!OVERRIDE_START.test(line)) continue;
  const m = line.match(OVERRIDE_RE);
  if (!m) {
    console.error(`content-coupling-check: malformed override (needs "Task <B> → <file> (Task <A>) — <reason>"): ${line.trim()}`);
    process.exit(1);
  }
  overrides.push({ b: Number(m[1]), file: m[2].replace(/[`]/g, ""), a: Number(m[3]) });
}
const isOverridden = (b, file, a) =>
  overrides.some((o) => o.b === b && o.a === a && o.file === file);

// A path token is matched with a boundary so it never collides with a coincidentally similar
// path: the match must be a COMPLETE path token, bounded on both ends by a non-path-continuation
// character. Path-continuation characters are [\w.\-/] (word chars, dot, dash, slash) -- so a
// leading "/" is excluded from the left-boundary class (it would let a longer path like
// "vendor/scripts/table.mjs" match the shorter "scripts/table.mjs"), and the right boundary is a
// negative lookahead that rejects any of [\w.\-/] rather than a bare \b -- \b matches before ".",
// "-", "/", which let "scripts/table.mjs.bak" or "scripts/table.mjs-old" false-collide with
// "scripts/table.mjs". A bare word (e.g. "tabulate") still never matches a filename it merely
// contains, matching the same precision blast-radius-check uses for basenames.
const mentions = (haystack, path) => {
  const esc = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[\\s'"\`(])${esc}(?![\\w.\\-/])`, "m").test(haystack);
};

const violations = [];
for (const [waveNum, taskNums] of waves) {
  for (const a of taskNums) {
    const aFiles = filesByTask.get(a);
    if (!aFiles || aFiles.size === 0) continue;
    for (const b of taskNums) {
      if (b === a) continue;
      // Exclude B's own **Files:** field from the searched text -- B naming its own files is not
      // coupling. Search only B's brief prose.
      // taskBlocks() runs the LAST task's block from its "### Task N:" heading to end-of-file, so
      // trailing plan-level "## " sections (Dispatch Map, Blast-radius overrides, ...) after the
      // last task get absorbed into that task's block text. Bound the block at the first level-2
      // "## " heading (a "### " task heading has a "#" at column 2, not a space, so it never
      // matches this anchor) before deriving bFilesRaw/bFilesValue/bProse from it, so a plan-level
      // section is never scanned as the last task's own brief prose.
      let bText = blocks.get(b) ?? "";
      const bPlanLevelBoundary = bText.match(/^## /m);
      if (bPlanLevelBoundary) bText = bText.slice(0, bPlanLevelBoundary.index);
      const bFilesRaw = filesFieldValue(bText) ?? "";
      // filesFieldValue's terminator stops only at the next **field**, a ### heading, or end of
      // input -- when Files is a task's last field (nothing else declared after it, the shape a
      // brief with no Interfaces/Evidence field between Files and its steps takes) that swallows
      // the block's own step prose too, and for a plan's last task, the trailing "## Dispatch Map"
      // section as well. The real declaration ends at the first blank line, so bound it there
      // before using it to tell B's own bullets apart from B's prose -- this reuses task-files.mjs's
      // extraction rather than re-deriving the ### heading / **field** grammar.
      const bFilesValue = bFilesRaw.split(/\n\s*\n/)[0];
      const bProse = bFilesValue ? bText.replace(bFilesValue, "") : bText;
      for (const file of aFiles) {
        if (mentions(bFilesValue, file)) continue; // a literal overlap is wave-disjointness-check's job
        if (mentions(bProse, file) && !isOverridden(b, file, a))
          violations.push({ wave: waveNum, a, b, file });
      }
    }
  }
}

if (violations.length > 0) {
  for (const v of violations)
    console.error(`content-coupling-check: Wave ${v.wave} -- Task ${v.b} references ${v.file}, which Task ${v.a} edits in the same wave -- add a dependency or record a "Content-coupling override" with a reason`);
  process.exit(1);
}
console.log("content-coupling-check: ok -- no same-wave brief cross-references found");
process.exit(0);
