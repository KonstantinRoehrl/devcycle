// The surface a driven session starts with (docs/decisions/README.md, 2026-10-25): no MCP servers, and
// only the plugins execution needs, turned off through an enabledPlugins override. Never --bare or
// --safe-mode, which also drop devcycle's own hooks module, and never --setting-sources, which would
// drop the user's permissions and devcycle's enablement with it.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// devcycle's manifest depends on superpowers: without it devcycle fails to load.
export const KEEP_PLUGINS = ["devcycle", "superpowers"];
const NO_MCP = ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'];
const UNAVAILABLE = "plugin list unavailable — full plugin surface";

const nameOf = (id) => id.split("@")[0];

// DEVCYCLE_DRIVE_PLUGIN_LIST names a file read in place of the CLI's output, so the driver tests'
// claude stub, which plays one scenario step per invocation, is never spent on it.
export function readPluginList({ env = process.env, bin, cwd }) {
  let parsed;
  try {
    const text = env.DEVCYCLE_DRIVE_PLUGIN_LIST
      ? readFileSync(env.DEVCYCLE_DRIVE_PLUGIN_LIST, "utf8")
      : execFileSync(bin, ["plugin", "list", "--json"], { cwd, env, encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] });
    parsed = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  if (!Array.isArray(parsed) || !parsed.every((p) => typeof p?.id === "string" && p.id !== "")) return { ok: false };
  return { ok: true, plugins: parsed.map((p) => ({ id: p.id, enabled: p.enabled === true, projectEnabled: p.projectEnabled === true })) };
}

export function surfaceArgs({ drivePlugins, list }) {
  if (drivePlugins === "all") return { args: [], plugins: "all", mcp: "all", note: null };
  if (!list.ok) return { args: [...NO_MCP], plugins: "all", mcp: "none", note: UNAVAILABLE };
  const keep = new Set([...KEEP_PLUGINS, ...(drivePlugins === "none" ? [] : drivePlugins.split(","))]);
  const on = list.plugins.filter((p) => p.enabled || p.projectEnabled);
  const off = on.filter((p) => !keep.has(nameOf(p.id)));
  const kept = [...new Set(on.map((p) => nameOf(p.id)).filter((name) => keep.has(name)))];
  const settings = off.length ? ["--settings", JSON.stringify({ enabledPlugins: Object.fromEntries(off.map((p) => [p.id, false])) })] : [];
  return { args: [...NO_MCP, ...settings], plugins: kept.join(",") || "none", mcp: "none", note: null };
}
