// Prices every subagent dispatch under one project slug directory: one row per implementer
// transcript, carrying the dollars its own turns cost at their own models. This is the
// file-reading half of the routing advisory; scripts/routing-advisories.mjs is the pure half that
// joins these rows to the run journal.
//
// The invariant that shapes every branch here: a dispatch whose cost cannot be measured carries
// usd: null and a named reason, never 0 and never a partial sum. A partial sum is the worse
// failure of the two, because it reads as a complete figure.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { costUSD, priceFor, usageTokens } from "./pricing.mjs";
import { collapseRequests, isTurn } from "./request-collapse.mjs";
import { hashSession } from "./run-record.mjs";
import { eachRecord } from "./jsonl.mjs";

// The task number a dispatch's sidecar description names. Historical sidecars are the only place
// it lives; playbooks/executing-waves.md records agentId on the dispatch record going forward, so
// this parse is the fallback for runs written before that field existed.
const TASK_RE = /[Tt]ask\s*(\d+)/;

// A missing path is "nothing here"; anything else is a real fault. Same rule as
// scripts/doctor.mjs's readers, so a permissions failure never reads as an empty corpus.
function entriesOrNone(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code !== "ENOENT" && err.code !== "ENOTDIR") throw err;
    return null;
  }
}

// Sums one subagent transcript at each request's own model. Streams via eachRecord rather than
// reading the whole file: the corpus is thousands of transcripts, and peak memory should track
// the work, not the largest file. A request is written as one record per content block, all
// sharing one usage block, and the request is what is billed and counted
// (scripts/request-collapse.mjs), so the turn records are gathered first; only those are kept.
// The four token sums cover exactly the requests counted, so a per-agent cost row can show what
// the dollars were spent on.
export function priceTranscript(file) {
  const none = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
  if (!existsSync(file))
    return { usd: null, turns: 0, models: [], measurement: "missing-transcript", ...none };

  const records = [];
  // isTurn skips `<synthetic>`, a harness artifact that must not make a dispatch unmeasurable; a
  // usage record naming no model is not a priced turn either.
  eachRecord(file, (r) => { if (isTurn(r) && r.message.model) records.push(r); });

  let usd = 0, unpriced = null;
  const sums = { ...none };
  const models = new Set();
  const requests = collapseRequests(records);
  for (const { message: { usage, model } } of requests) {
    models.add(model);
    const tokens = usageTokens(usage);
    for (const key of Object.keys(sums)) sums[key] += tokens[key];
    if (!priceFor(model)) { unpriced ??= model; continue; }
    usd += costUSD(usage, model) ?? 0;
  }
  const turns = requests.length;

  const list = [...models];
  if (unpriced) return { usd: null, turns, models: list, measurement: `unpriced-model:${unpriced}`, ...sums };
  if (turns === 0) return { usd: null, turns: 0, models: [], measurement: "no-priced-turns", ...none };
  if (list.length > 1) return { usd, turns, models: list, measurement: "multi-model", ...sums };
  return { usd, turns, models: list, measurement: "ok", ...sums };
}

// Every dispatch of one agent type under `slugDir`, a single
// <projects root>/<escaped repo path> directory whose children are session directories.
export function pricedDispatches(slugDir, { agentType = "devcycle:implementer" } = {}) {
  const rows = [];
  for (const session of entriesOrNone(slugDir) ?? []) {
    if (!session.isDirectory()) continue;
    const dir = join(slugDir, session.name, "subagents");
    for (const entry of entriesOrNone(dir) ?? []) {
      if (!entry.isFile() || !entry.name.endsWith(".meta.json")) continue;
      let meta;
      try { meta = JSON.parse(readFileSync(join(dir, entry.name), "utf8")); } catch { continue; }
      if (meta.agentType !== agentType) continue;
      const agentId = entry.name.slice(0, -".meta.json".length);
      const description = meta.description ?? "";
      rows.push({
        sessionId: session.name,
        sessionHash: hashSession(session.name),
        agentId,
        agentType: meta.agentType,
        description,
        taskId: description.match(TASK_RE)?.[1] ?? null,
        ...priceTranscript(join(dir, `${agentId}.jsonl`)),
      });
    }
  }
  return rows;
}
