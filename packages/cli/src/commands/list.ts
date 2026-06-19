// list — show all known plugins and whether they're installed.

import { existsSync } from "node:fs"
import { join } from "node:path"
import { discoverPlugins } from "../lib/registry.js"
import { ui } from "../lib/ui.js"
import { opencodePluginDir, opencodeSkillDir, tilde } from "../lib/paths.js"

export async function list(_args: string[]): Promise<number> {
  const plugins = discoverPlugins()
  if (plugins.length === 0) {
    ui.info("No plugins discovered in this monorepo.")
    return 0
  }

  const nameW = Math.max(5, ...plugins.map((p) => p.name.length))
  const verW = Math.max(7, ...plugins.map((p) => p.version.length))
  const stateW = 9

  const header = [
    "PLUGIN".padEnd(nameW),
    "INSTALLED".padEnd(stateW),
    "VERSION".padEnd(verW),
    "DESCRIPTION",
  ].join("  ")

  ui.info(ui.header("hl-plugins — known plugins"))
  ui.info(ui.bold(header))
  for (const p of plugins) {
    const pluginTarget = p.contract.opencodePlugin
      ? join(opencodePluginDir(), p.contract.opencodePlugin.split("/").pop() ?? "")
      : null
    const installed = pluginTarget && existsSync(pluginTarget) ? "✓" : "·"
    ui.info(
      [
        ui.cyan(p.name.padEnd(nameW)),
        (installed === "✓" ? ui.green : ui.gray)(installed.padEnd(stateW)),
        ui.gray(p.version.padEnd(verW)),
        p.description || ui.gray("(no description)"),
      ].join("  "),
    )
  }
  ui.info(ui.dim(`\ninstall target: ${tilde(opencodePluginDir())}/`))
  return 0
}
