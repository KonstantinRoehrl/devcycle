#!/usr/bin/env node
// The spec-claims handoff (spec §9.7). Brainstorm's coordinator records the spec reviewer's confirmed
// claims, stamped with the spec's content hash and HEAD; planning's feasibility gate later trusts a
// claim only while the spec is byte-identical and no path the claim cites has changed since that
// HEAD, and re-verifies everything else. A claim citing no path can never be shown unchanged.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { atomicWrite } from "./atomic-write.mjs";
import { parseFlags, requireValue } from "./cli-flags.mjs";
import { isMain } from "./is-main.mjs";
import { now } from "./stamp.mjs";

export const DEFAULT_CLAIMS_PATH = ".devcycle/spec-claims.md";

const VERIFIED_LINE = /^- (.+?) · paths: (.+?) · cmd: `(.+)`\s*$/;

/** One entry per `- <claim> · paths: <p>[, <p>…] · cmd: `<command>`` line; every other line is ignored. */
export function parseVerified(text) {
  const claims = [];
  for (const line of text.split("\n")) {
    const m = VERIFIED_LINE.exec(line);
    if (!m) continue;
    const paths = m[2].trim() === "none" ? [] : m[2].split(",").map((p) => p.trim()).filter(Boolean);
    claims.push({ claim: m[1].trim(), paths, cmd: m[3] });
  }
  return claims;
}

const pathsText = (paths) => (paths.length ? paths.join(", ") : "none");
const claimLine = ({ claim, paths, cmd }) => `- ${claim} · paths: ${pathsText(paths)} · cmd: \`${cmd}\``;

export function renderClaims({ specPath, specSha256, head, written, claims }) {
  return [
    "# Spec claims",
    `- spec: ${specPath}`,
    `- spec-sha256: ${specSha256}`,
    `- head: ${head}`,
    `- written: ${written}`,
    "",
    "## Verified",
    ...claims.map(claimLine),
    "",
  ].join("\n");
}

const HEADER_FIELD = (name, pattern) => new RegExp(`^- ${name}: (${pattern})$`, "m");

/** The object renderClaims wrote, or null when the text is not a spec-claims file. */
export function parseClaims(text) {
  const [head, ...rest] = text.split(/^## Verified$/m);
  if (rest.length !== 1 || !/^# Spec claims$/m.test(head)) return null;
  const pick = (name, pattern) => HEADER_FIELD(name, pattern).exec(head)?.[1] ?? null;
  const fields = {
    specPath: pick("spec", ".+"),
    specSha256: pick("spec-sha256", "[0-9a-f]{64}"),
    head: pick("head", "[0-9a-f]{40}"),
    written: pick("written", ".+"),
  };
  if (Object.values(fields).some((v) => v === null)) return null;
  return { ...fields, claims: parseVerified(rest[0]) };
}

const sha256Of = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const git = (root, args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });

export function checkClaims({ specPath, claimsPath = DEFAULT_CLAIMS_PATH, root = process.cwd() }) {
  const file = resolve(root, claimsPath);
  const stamped = existsSync(file) ? parseClaims(readFileSync(file, "utf8")) : null;
  if (!stamped) return { status: "absent", verified: [], reverify: [] };
  const spec = resolve(root, specPath);
  if (!existsSync(spec) || sha256Of(spec) !== stamped.specSha256)
    return { status: "stale-spec", verified: [], reverify: stamped.claims };
  if (git(root, ["cat-file", "-e", `${stamped.head}^{commit}`]).status !== 0)
    return { status: "no-head", verified: [], reverify: stamped.claims };
  const verified = [];
  const reverify = [];
  for (const c of stamped.claims) {
    const unchanged = c.paths.length > 0 && git(root, ["diff", "--quiet", stamped.head, "--", ...c.paths]).status === 0;
    (unchanged ? verified : reverify).push(c);
  }
  return { status: "ok", verified, reverify };
}

const USAGE = "usage: spec-claims.mjs write --spec <path> --verified <file> [--out <path>] | check --spec <path> [--in <path>]";

function usageError(msg) {
  console.error(`spec-claims: ${msg}`);
  process.exit(2);
}

function write(flags) {
  const specPath = requireValue(flags, "--spec") ?? usageError(`write needs --spec — ${USAGE}`);
  const verifiedPath = requireValue(flags, "--verified") ?? usageError(`write needs --verified — ${USAGE}`);
  const out = requireValue(flags, "--out") ?? DEFAULT_CLAIMS_PATH;
  for (const p of [specPath, verifiedPath]) if (!existsSync(p)) usageError(`not found: ${p}`);
  const head = git(process.cwd(), ["rev-parse", "HEAD"]);
  if (head.status !== 0) usageError(`no git HEAD in ${process.cwd()}`);
  const stamp = { specPath, specSha256: sha256Of(specPath), head: head.stdout.trim(), written: now(),
    claims: parseVerified(readFileSync(verifiedPath, "utf8")) };
  mkdirSync(dirname(resolve(out)), { recursive: true });
  atomicWrite(resolve(out), renderClaims(stamp));
  console.log(`spec-claims: wrote ${stamp.claims.length} claims to ${out} (spec ${stamp.specSha256.slice(0, 12)}, head ${stamp.head.slice(0, 12)})`);
}

const VERIFY_ALL = {
  absent: "spec-claims: none — verify every claim",
  "stale-spec": "spec-claims: spec changed since review — verify every claim",
  "no-head": "spec-claims: review HEAD unknown — verify every claim",
};

function check(flags) {
  const specPath = requireValue(flags, "--spec") ?? usageError(`check needs --spec — ${USAGE}`);
  const r = checkClaims({ specPath, claimsPath: requireValue(flags, "--in") ?? DEFAULT_CLAIMS_PATH });
  if (r.status !== "ok") return void console.log(VERIFY_ALL[r.status]);
  console.log(`spec-claims: ${r.verified.length} verified, ${r.reverify.length} to re-verify`);
  for (const c of r.verified) console.log(`verified: ${c.claim} · paths: ${pathsText(c.paths)}`);
  for (const c of r.reverify) console.log(`reverify: ${c.claim} · paths: ${pathsText(c.paths)}`);
}

const COMMANDS = {
  write: { flags: { "--spec": "value", "--verified": "value", "--out": "value" }, run: write },
  check: { flags: { "--spec": "value", "--in": "value" }, run: check },
};

function main([command, ...argv]) {
  if (!Object.hasOwn(COMMANDS, command ?? "")) usageError(USAGE);
  let flags;
  try {
    ({ flags } = parseFlags(argv, COMMANDS[command].flags));
  } catch (e) {
    usageError(`${e.message} — ${USAGE}`);
  }
  try {
    COMMANDS[command].run(flags);
  } catch (e) {
    usageError(e.message);
  }
}

if (isMain(import.meta.url, process.argv[1])) main(process.argv.slice(2));
