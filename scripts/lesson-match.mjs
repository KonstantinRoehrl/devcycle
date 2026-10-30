// The lessons and persisting maintenance findings a task's files name, one line each, a lesson's with
// its pull hint and a finding's self-contained: what `dream.mjs --match` prints and what task-dispatch.mjs fills an implementer brief's
// `**Lessons:**` line with. Lessons come from the stage's three stores joined to their promotion
// records; maintenance findings match by file only, whatever the stage.
import { MATCH_CAP, matchLessons, readSection, renderMatch, repoStorePath, userGlobalStorePath, userRepoStorePath } from "./lessons.mjs";
import { matchMaintenanceFindings, readMaintenanceFindings, renderMaintenanceMatches } from "./maintenance-findings.mjs";
import { readPromotions } from "./promotions.mjs";

export function matchedLessons({ root, stage, files, culprits = [], keywords = [] }) {
  const lessonLines = [
    ...readSection(repoStorePath(root), stage),
    ...readSection(userRepoStorePath(root), stage),
    ...readSection(userGlobalStorePath(), stage),
  ];
  const lessons = renderMatch(matchLessons({ lessonLines, promotions: readPromotions(root), files, culprits, keywords }));
  const maintenance = renderMaintenanceMatches(
    matchMaintenanceFindings({ records: readMaintenanceFindings(root), files, cap: MATCH_CAP }),
  );
  return [lessons, maintenance].filter(Boolean).join("\n");
}
