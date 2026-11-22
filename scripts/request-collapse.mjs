// The one place a transcript's assistant records collapse into requests. Imported by
// scripts/doctor.mjs and scripts/dispatch-cost.mjs, so the dollars the doctor reports and the
// dollars the dispatch sensor writes into an agent-cost row count the same requests.
import { SYNTHETIC_MODEL } from "./depth-probe.mjs";

// Only assistant-side records carrying a message.usage count as turns. Synthetic placeholders
// carry an all-zero usage block and are not requests, so they never reach the counters.
export function isTurn(r) {
  return r.type === "assistant" && r.message && r.message.usage && r.message.model !== SYNTHETIC_MODEL;
}

// Claude Code writes one assistant record per content block, so a request of thinking + text +
// tool_use is three records sharing one requestId and one usage block. Every per-turn, dollar and
// depth figure is counted per request, so this is the one place the records collapse. A request
// takes its first record's fields (stage, timestamp, side), the usage of the record with the most
// output tokens, and the content of all its records; a record with neither a requestId nor a
// message.id stands for itself. A request's records mostly carry the same usage but can differ in
// output_tokens (streaming partials: 10044 of 31039 real requests); taking the greatest
// output_tokens assumes the final block carries the final usage.
export function collapseRequests(records) {
  const byKey = new Map();
  const requests = [];
  for (const r of records) {
    const id = r.requestId ?? r.message.id;
    const key = id ? `${r.isSidechain ? "subagent" : "main"}\0${id}` : null;
    const request = key === null ? undefined : byKey.get(key);
    if (!request) {
      const first = { ...r, message: { ...r.message } };
      if (key !== null) byKey.set(key, first);
      requests.push(first);
      continue;
    }
    if ((r.message.usage.output_tokens ?? 0) > (request.message.usage.output_tokens ?? 0)) request.message.usage = r.message.usage;
    if (Array.isArray(r.message.content))
      request.message.content = [...(Array.isArray(request.message.content) ? request.message.content : []), ...r.message.content];
  }
  return requests;
}
