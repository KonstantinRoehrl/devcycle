#!/usr/bin/env node
// Fails if tracked files contain machine-specific paths or terms whose sha256 is deny-listed.
// The deny-list stores hashes so the forbidden terms never appear in the public repo.
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SELF_EXEMPT = ["scripts/redaction-check.mjs", "scripts/redaction-hashes.txt"];
const hashes = new Set(
  readFileSync("scripts/redaction-hashes.txt", "utf8").split("\n").map((l) => l.trim()).filter(Boolean)
);
const sha = (s) => createHash("sha256").update(s).digest("hex");
// Machine-path pattern assembled to avoid matching itself:
const HOME_PATH = new RegExp("/" + "Users/" + "[A-Za-z0-9_.-]+");
const files = execSync("git ls-files", { encoding: "utf8" }).split("\n").filter(Boolean);
const errors = [];
for (const f of files) {
  if (SELF_EXEMPT.includes(f)) continue;
  let text;
  try { text = readFileSync(f, "utf8"); } catch { continue; } // binary
  if (HOME_PATH.test(text)) errors.push(`${f}: contains an absolute home-directory path`);
  for (const token of new Set(text.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? []))
    if (hashes.has(sha(token))) errors.push(`${f}: contains a deny-listed term ("${token[0]}…", redact it)`);
}
if (errors.length) { console.error("REDACTION CHECK FAILED:\n" + errors.map((e) => " - " + e).join("\n")); process.exit(1); }
console.log("redaction: ok");
