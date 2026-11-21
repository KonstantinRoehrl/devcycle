// This run's own session transcripts. Transcripts are a scoped fallback, read only for this run's own
// sessions: a file is kept only when the sha256 of its session id is a `session` row of the run record
// (which never holds a raw id), and a transcript found any other way is never read. Every project
// directory is listed, because a session's transcript sits under the directory of the cwd it started
// in, which need not be the cycle's root; only that one level, so a subagent's transcript under
// <session>/subagents/ is never listed.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { claudeProjectsDir } from "./depth-probe.mjs";
import { hashSession } from "./run-record.mjs";

const TRANSCRIPT = ".jsonl";

const entriesOf = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

/**
 * The main transcripts of the named sessions, under any project directory.
 * @param {{ sessionHashes: string[]|Set<string>, env?: object }} opts the run record's session hashes
 * @returns {Array<{ sessionHash: string, file: string }>} one entry per matching file; [] when the projects dir cannot be read
 */
export function runTranscripts({ sessionHashes, env = process.env }) {
  const wanted = new Set(sessionHashes);
  if (!wanted.size) return [];
  const projects = claudeProjectsDir(env);
  return entriesOf(projects).filter((project) => project.isDirectory()).flatMap((project) =>
    entriesOf(join(projects, project.name))
      .filter((entry) => entry.isFile() && entry.name.endsWith(TRANSCRIPT))
      .map((entry) => ({ sessionHash: hashSession(entry.name.slice(0, -TRANSCRIPT.length)), file: join(projects, project.name, entry.name) }))
      .filter(({ sessionHash }) => wanted.has(sessionHash)));
}

/**
 * The session before this one: the run record's latest `session` row that is not the current session.
 * @param {{ rows: object[], currentSessionId?: string|null, env?: object }} opts the parsed run-record rows, in file order
 * @returns {{ sessionHash: string, file: string|null }|null} its hash and transcript (null when none is found); null when no such row
 */
export function lastSession({ rows, currentSessionId = process.env.CLAUDE_CODE_SESSION_ID, env = process.env }) {
  const current = currentSessionId ? hashSession(currentSessionId) : null;
  const row = rows.filter((r) => r?.kind === "session" && r.sessionHash && r.sessionHash !== current).at(-1);
  if (!row) return null;
  return { sessionHash: row.sessionHash, file: runTranscripts({ sessionHashes: [row.sessionHash], env })[0]?.file ?? null };
}
