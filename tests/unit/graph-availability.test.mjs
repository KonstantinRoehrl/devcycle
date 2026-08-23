import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveGraphAvailability } from "../../scripts/graph-availability.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const graphRepo = join(here, "..", "fixtures", "maintain", "graph-repo");
const noGraphRepo = join(here, "..", "fixtures", "maintain", "no-graph-repo");

test("a target repo with graphify artifacts + the skill resolves available", () => {
  const r = resolveGraphAvailability({ repoPath: graphRepo, skills: ["graphify"], pluginRoot: root });
  assert.equal(r.available, true, r.reason);
});

test("a target repo without graph artifacts falls back (Explore)", () => {
  const r = resolveGraphAvailability({ repoPath: noGraphRepo, skills: ["graphify"], pluginRoot: root });
  assert.equal(r.available, false);
  assert.match(r.reason, /no graph artifacts/);
});

test("this plugin's own repo is excluded even with artifacts present", () => {
  const r = resolveGraphAvailability({ repoPath: graphRepo, skills: ["graphify"], pluginRoot: graphRepo });
  assert.equal(r.available, false);
  assert.match(r.reason, /plugin's own repo/);
});

test("without the graphify skill, availability is false regardless of artifacts", () => {
  const r = resolveGraphAvailability({ repoPath: graphRepo, skills: [], pluginRoot: root });
  assert.equal(r.available, false);
  assert.match(r.reason, /skill unavailable/);
});

test("a plugin-scoped skill id (…:graphify) is recognized", () => {
  const r = resolveGraphAvailability({ repoPath: graphRepo, skills: ["some:graphify"], pluginRoot: root });
  assert.equal(r.available, true, r.reason);
});
