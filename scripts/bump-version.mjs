#!/usr/bin/env node
// Bumps plugin.json version from Conventional Commit subjects since the last devcycle--v* tag.
// Prepends a CHANGELOG section, writes .release-notes.md, prints the new version.
// --dry-run: print level+version only, change nothing.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const dry = process.argv.includes("--dry-run");
const sh = (c) => execSync(c, { encoding: "utf8" }).trim();
let lastTag = "";
try { lastTag = sh("git describe --tags --abbrev=0 --match 'devcycle--v*'"); } catch {}
const range = lastTag ? `${lastTag}..HEAD` : "HEAD";
const subjects = sh(`git log --format=%s ${range}`).split("\n").filter(Boolean);
const bodies = sh(`git log --format=%b ${range}`);
const CC = /^(feat|fix|perf|docs|chore|ci|refactor|style|test|build)(\([a-z0-9-]+\))?(!)?: /;
const releasing = subjects.filter((s) => CC.test(s));
let level = "patch";
if (releasing.some((s) => CC.exec(s)[3] === "!") || /BREAKING CHANGE:/.test(bodies)) level = "major";
else if (releasing.some((s) => s.startsWith("feat"))) level = "minor";
const path = ".claude-plugin/plugin.json";
const plugin = JSON.parse(readFileSync(path, "utf8"));
const [MA, MI, PA] = plugin.version.split(".").map(Number);
const version =
  level === "major" ? `${MA + 1}.0.0` : level === "minor" ? `${MA}.${MI + 1}.0` : `${MA}.${MI}.${PA + 1}`;
if (dry) { console.log(`${level} ${version}`); process.exit(0); }
plugin.version = version;
writeFileSync(path, JSON.stringify(plugin, null, 2) + "\n");
const notes = releasing.map((s) => `- ${s}`).join("\n") || "- maintenance release";
writeFileSync(".release-notes.md", `## ${version}\n\n${notes}\n`);
const changelog = readFileSync("CHANGELOG.md", "utf8");
writeFileSync("CHANGELOG.md", changelog.replace(/^# Changelog\n/, `# Changelog\n\n## ${version}\n\n${notes}\n`));
console.log(version);
