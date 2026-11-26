// Drive band rows in cc-statusline's shape, ported from its hooks/format.ts (fmtModelName, fmtK,
// gradientColor, buildRow), so a band row reads like cc-statusline's agent rows in the same terminal.
// Imports nothing: hooks/devcycle-mod.mjs runs without Node.
export const MODEL_COLOR = "#5fafaf";
export const VALUE_COLOR = "#d0d0d0";
export const SEPARATOR = " · ";
const CTX_GOOD = 40;
const CTX_BAD = 65;

export const cells = (text) => [...text].length;
export const width = (segments) => segments.reduce((sum, s) => sum + cells(s.text), 0);

export function fmtModelName(id) {
  if (!id) return "—";
  if (!id.startsWith("claude-")) return id;
  const rest = id.slice("claude-".length).replace(/-\d{8}$/, "");
  const dash = rest.indexOf("-");
  const family = dash === -1 ? rest : rest.slice(0, dash);
  const version = dash === -1 ? "" : rest.slice(dash + 1);
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  return version ? `${name}-${version.replaceAll("-", ".")}` : name;
}

export function fmtK(n) {
  if (n < 1000) return String(n);
  return `${Math.floor(n / 1000)}.${Math.floor((n % 1000) / 100)}k`;
}

const lerp = (a, b, t) => a + Math.trunc(((b - a) * t) / 100);

// Green at or below `good`, red at or above `bad`, green → amber → red between.
export function gradientColor(pct, good, bad) {
  const raw = bad === good ? 100 : Math.trunc(((pct - good) * 100) / (bad - good));
  const t = Math.min(100, Math.max(0, raw));
  const first = t <= 50;
  const tt = first ? t * 2 : (t - 50) * 2;
  const r = first ? lerp(0, 255, tt) : 255;
  const g = first ? lerp(215, 135, tt) : lerp(135, 0, tt);
  return `rgb(${r},${g},0)`;
}

export function joinDot(parts) {
  const out = [];
  for (const part of parts) {
    if (part.length === 0) continue;
    if (out.length > 0) out.push({ text: SEPARATOR });
    out.push(...part);
  }
  return out;
}

// A tier's segments, each [] when its value is unknown. ctx needs a window that is known and not
// assumed: an assumed window makes the percentage and its color a guess.
export function tierParts({ model, effort, tokens, window, windowAssumed } = {}) {
  const known = typeof tokens === "number";
  const pct = known && window > 0 && !windowAssumed ? Math.min(100, Math.max(0, Math.floor((tokens * 100) / window))) : null;
  return {
    model: model ? [{ text: effort ? `${fmtModelName(model)} (${effort})` : fmtModelName(model), color: MODEL_COLOR }] : [],
    ctx: pct === null ? [] : [{ text: `ctx ${pct}%`, color: gradientColor(pct, CTX_GOOD, CTX_BAD) }],
    tokens: known ? [{ text: `${fmtK(tokens)} tok`, color: VALUE_COLOR }] : [],
  };
}

function cutSegments(segments, room) {
  const out = [];
  let left = room;
  for (const s of segments) {
    if (left <= 0) break;
    const chars = [...s.text];
    out.push(chars.length <= left ? s : { ...s, text: chars.slice(0, left).join("") });
    left -= Math.min(chars.length, left);
  }
  return out;
}

// One row: `prefix`, then the lead parts, `what` and the tail parts joined by SEPARATOR, each empty part
// dropped with its separator. Over `columns` (0 = no limit) the first `keep` segments of `what` (a task's
// step, round and rejection warning) must survive: while they would not, the tail goes, then the lead's
// parts after its first. Then `what` is cut from its end with "…"; when that leaves it under two cells,
// the row is sliced to the columns, each surviving segment keeping its color. cc-statusline's buildRow rule, plus the prefix and the kept head.
export function fitRow({ prefix = [], lead = [], what = [], keep = 0, tail = [] }, columns) {
  const row = (l, t, w) => [...prefix, ...joinDot([...l, w, ...t])];
  const full = row(lead, tail, what);
  if (columns <= 0 || width(full) <= columns) return full;
  const room = (l, t) => {
    const fixed = joinDot([...l, ...t]);
    return columns - width(prefix) - width(fixed) - (fixed.length > 0 ? cells(SEPARATOR) : 0);
  };
  const head = width(what.slice(0, keep));
  const survives = (l, t) => room(l, t) >= width(what) || room(l, t) - 1 >= head;
  let [l, t] = [lead, tail];
  while (keep > 0 && !survives(l, t)) {
    if (t.some((part) => part.length > 0)) t = [];
    else if (l.length > 1) l = l.slice(0, -1);
    else break;
  }
  const avail = room(l, t);
  if (avail >= width(what)) return row(l, t, what);
  if (what.length > 0 && avail > 1) return row(l, t, [...cutSegments(what, avail - 1), { text: "…" }]);
  return cutSegments(full, columns);
}
