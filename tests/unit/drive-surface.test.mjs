import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { KEEP_PLUGINS, readPluginList, surfaceArgs } from "../../scripts/drive-surface.mjs";
import { makeFakeBin } from "./helpers.mjs";

const FIXTURE = fileURLToPath(new URL("../fixtures/plugin-list.json", import.meta.url));
const NO_MCP = ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'];
const fromFixture = () => readPluginList({ env: { DEVCYCLE_DRIVE_PLUGIN_LIST: FIXTURE }, bin: "unused", cwd: process.cwd() });
const disabledBy = (args) => JSON.parse(args[args.indexOf("--settings") + 1]).enabledPlugins;

test("the keep set is devcycle and the superpowers plugin devcycle's manifest depends on", () => {
  assert.deepEqual(KEEP_PLUGINS, ["devcycle", "superpowers"]);
});

test("readPluginList reads the DEVCYCLE_DRIVE_PLUGIN_LIST file in place of the CLI, keeping id and both enabled flags", () => {
  const list = fromFixture();
  assert.equal(list.ok, true);
  assert.deepEqual(list.plugins[0], { id: "devcycle@devcycle", enabled: true, projectEnabled: false });
  assert.deepEqual(list.plugins.at(-1), { id: "engineering@synced", enabled: true, projectEnabled: false },
    "a synced plugin carries no projectEnabled key and reads as not project-enabled");
  assert.equal(list.plugins.length, 7);
});

test("readPluginList runs `<bin> plugin list --json` in cwd when the seam is unset", () => {
  const dir = makeTempDir("devcycle-surface-");
  const argvFile = join(dir, "argv.json");
  const bin = join(makeFakeBin("claude", `require("node:fs").writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n` +
    `process.stdout.write(${JSON.stringify(readFileSync(FIXTURE, "utf8"))});\n`), "claude");
  const list = readPluginList({ env: { PATH: process.env.PATH }, bin, cwd: dir });
  assert.equal(list.ok, true);
  assert.equal(list.plugins.length, 7);
  const seen = JSON.parse(readFileSync(argvFile, "utf8"));
  assert.deepEqual(seen.argv, ["plugin", "list", "--json"]);
  assert.equal(seen.cwd, dir);
});

test("readPluginList is { ok: false } for a missing file, unparseable text, a non-array, an entry without an id, a failing or absent CLI", () => {
  const dir = makeTempDir("devcycle-surface-");
  const write = (name, text) => {
    writeFileSync(join(dir, name), text);
    return join(dir, name);
  };
  for (const path of [join(dir, "missing.json"), write("torn.json", "[{\"id\":"), write("object.json", "{}"), write("noid.json", "[{\"enabled\":true}]")])
    assert.deepEqual(readPluginList({ env: { DEVCYCLE_DRIVE_PLUGIN_LIST: path }, bin: "unused", cwd: dir }), { ok: false }, path);
  const failing = join(makeFakeBin("claude", "process.stdout.write(\"[]\"); process.exit(1);\n"), "claude");
  assert.deepEqual(readPluginList({ env: { PATH: process.env.PATH }, bin: failing, cwd: dir }), { ok: false });
  assert.deepEqual(readPluginList({ env: { PATH: process.env.PATH }, bin: join(dir, "no-such-claude"), cwd: dir }), { ok: false });
});

test("surfaceArgs at `all` restores today's surface: no MCP restriction, no plugin override", () => {
  assert.deepEqual(surfaceArgs({ drivePlugins: "all", list: fromFixture() }), { args: [], plugins: "all", mcp: "all", note: null });
  assert.deepEqual(surfaceArgs({ drivePlugins: "all", list: { ok: false } }), { args: [], plugins: "all", mcp: "all", note: null });
});

test("surfaceArgs at `none` restricts MCP and disables every listed-on plugin outside the keep set", () => {
  const s = surfaceArgs({ drivePlugins: "none", list: fromFixture() });
  assert.deepEqual(s.args.slice(0, 3), NO_MCP);
  assert.equal(s.args[3], "--settings");
  assert.equal(s.args.length, 5);
  assert.deepEqual(disabledBy(s.args), {
    "impeccable@impeccable": false, "token-optimizer@alexgreensh-token-optimizer": false, "engineering@synced": false,
  }, "an already-disabled plugin is left out, and both kept names survive in any marketplace");
  assert.equal(s.plugins, "devcycle,superpowers");
  assert.equal(s.mcp, "none");
  assert.equal(s.note, null);
});

test("surfaceArgs keeps drivePlugins' names, matched before the @, and disables a project-enabled-only plugin", () => {
  const list = fromFixture();
  list.plugins.push({ id: "local-tools@workspace", enabled: false, projectEnabled: true });
  const s = surfaceArgs({ drivePlugins: "impeccable,engineering", list });
  assert.deepEqual(disabledBy(s.args), { "token-optimizer@alexgreensh-token-optimizer": false, "local-tools@workspace": false });
  assert.equal(s.plugins, "devcycle,impeccable,superpowers,engineering", "kept names in list order, each once");
});

test("surfaceArgs omits --settings when nothing is disabled, and an unreadable list keeps the MCP restriction with the full plugin surface", () => {
  const kept = surfaceArgs({ drivePlugins: "none", list: { ok: true, plugins: [{ id: "devcycle@devcycle", enabled: true, projectEnabled: false }] } });
  assert.deepEqual(kept, { args: NO_MCP, plugins: "devcycle", mcp: "none", note: null });
  assert.deepEqual(surfaceArgs({ drivePlugins: "none", list: { ok: true, plugins: [] } }), { args: NO_MCP, plugins: "none", mcp: "none", note: null });
  assert.deepEqual(surfaceArgs({ drivePlugins: "impeccable", list: { ok: false } }),
    { args: NO_MCP, plugins: "all", mcp: "none", note: "plugin list unavailable — full plugin surface" });
});
