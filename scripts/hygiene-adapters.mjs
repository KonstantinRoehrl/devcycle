// The hygiene sweep's output adapters, one per registry `adapter` value. Each turns a tool's runs
// into candidates. The spine has already failed a tool whose run errored or exited outside its
// `okExit`, so an adapter judges only its own output. `raw` serves every tool without its own
// parser: it keeps the lines that name a tracked file and a line number, and leaves the full output
// in the tool's scratch directory for verification to read.
import { relative } from "node:path";

const LOCATION = /^(.+?)[:(](\d+)/;

function relativize(path, repoRoot) {
  const prefix = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
  const rel = path.startsWith(prefix) ? path.slice(prefix.length) : path;
  return rel.replace(/^\.\//, "");
}

export const raw = {
  normalize(runs, ctx) {
    const filter = ctx.tool.lineFilter ? new RegExp(ctx.tool.lineFilter) : null;
    const tracked = new Set(ctx.files);
    const candidates = [];
    for (const run of runs) {
      for (const line of `${run.stdout}\n${run.stderr}`.split("\n").map((l) => l.trim())) {
        if (!line || (filter && !filter.test(line))) continue;
        const m = LOCATION.exec(line);
        if (!m) continue;
        const file = relativize(m[1], ctx.repoRoot);
        if (!tracked.has(file)) continue;
        candidates.push({ kind: ctx.tool.kinds[0], file, line: Number(m[2]), symbol: null, detail: line, noisy: true });
      }
    }
    return { ok: true, candidates, note: `tool-run, heuristic-normalized; full output in ${relative(ctx.repoRoot, ctx.scratch)}` };
  },
};

export const ADAPTERS = { raw };
