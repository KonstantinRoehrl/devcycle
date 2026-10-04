// The text helpers every doctor table and line is rendered with. A leaf: it imports nothing from
// the repo, so the report (doctor.mjs) and the overview (doctor-overview.mjs) can share one
// spelling of a dollar figure, a delta or a direction line without importing each other.

export const usd = (n) => "$" + (n >= 1 ? n.toFixed(2) : n.toFixed(4));

// An absent value renders as an em dash, never as a blank cell a reader would take for a zero.
const markdownCell = (v) => (v === null || v === undefined || v === "" ? "—" : String(v));

// Every table renders its header row and separator even with nothing in it, and says why it is
// empty — an empty table with no explanation reads as a clean bill of health (QC3).
export function markdownTable(headers, rows, whyEmpty) {
  const out = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(markdownCell).join(" | ")} |`),
  ];
  if (!rows.length) out.push("", `_No rows: ${whyEmpty}._`);
  return out;
}

// deltaAgainstPrevious' three states, rendered. A comparison that could not be taken names its
// reason; it never falls back to 0%, which would read as a version that changed nothing. A
// version with requests on an unpriced model has a total that is not the whole of its cost, so
// the move against it is withheld rather than shown as a figure that looks measured.
export const deltaText = (d) =>
  d.state === "compared"
    ? `${d.pct >= 0 ? "+" : ""}${d.pct.toFixed(1)}%`
    : d.state === "first-seen"
      ? "first seen"
      : d.reason === "unpriced" ? "not compared (⚠ unpriced)" : "not compared";

// The Sessions cell of a version×profile row. One owner for the render sites that quote the same
// row: a cohort the report declines to stand behind must not be quoted as a bare number.
export const cohortSessionsText = (row, minCohort) =>
  row.lowConfidence ? `${row.sessions} (low confidence: n<${minCohort})` : String(row.sessions);

// A label or figure of a cohort row, followed by the row's own `inferred` note when it has one.
// The report's Version cell and the issue draft's median line both derive from it, so a cohort
// whose figures leave out unpriced requests is never quoted bare in one place and qualified in
// the other.
export const withInferredNote = (text, row) => (row.inferred ? `${text} (inferred: ${row.inferred})` : text);

// What the corpus direction of travel says, as a phrase both the direction line and the trend
// summary embed. "undetermined" is the word for a corpus that cannot say: never a guessed
// direction, never "flat" by default (#44).
export function directionPhrase(direction) {
  if (direction.direction === "insufficient-data") return `undetermined (${direction.reason})`;
  return (
    `${direction.direction} (${direction.deltaPct.toFixed(1)}% median ` +
    `cost, ${direction.matchKey}, ${direction.from}→${direction.to})` +
    `${direction.inferred ? ` (inferred: ${direction.inferred})` : ""}`
  );
}

export const directionLine = (direction) => `Direction of travel: ${directionPhrase(direction)}`;

// The caveat under a table whose per-version medians leave out requests on a model with no exact
// price. Shared so the report's Cost-by-stage table and the overview word it identically.
export const unpricedMediansNote = (versions) =>
  `_Medians for ${versions.join(", ")} leave out requests on a model with no exact price ` +
  "(inferred) — compare across them with care._";
