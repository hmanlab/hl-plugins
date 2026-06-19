// Show all commands and a short description of each.

const rows: Array<[string, string]> = [
  ["hl-plugins install [plugin]", "Install one or more plugins"],
  ["hl-plugins uninstall [plugin]", "Remove one or more plugins"],
  ["hl-plugins list", "Show known plugins and their install state"],
  ["hl-plugins status [plugin]", "Per-plugin diagnostic report"],
  ["hl-plugins update [plugin]", "Re-copy files and bump dependencies"],
  ["hl-plugins help", "Show this help text"],
]

import { ui } from "../lib/ui.js"
import { opencodeConfigDir, tilde } from "../lib/paths.js"

export async function help(_args: string[]): Promise<number> {
  const out: string[] = []
  out.push(ui.header("hl-plugins — curated OpenCode plugins"))
  out.push(ui.bold("Usage:"), "  hl-plugins <command> [args]", "", ui.bold("Commands:"))
  for (const [name, desc] of rows) {
    out.push(`  ${ui.cyan(name.padEnd(38))} ${desc}`)
  }
  out.push("")
  out.push(ui.bold("Install target:"))
  out.push(`  ${tilde(opencodeConfigDir())}/`)
  out.push("")
  out.push(ui.bold("More info:"))
  out.push("  docs/commands.md  -- full CLI reference")
  out.push("  docs/architecture.md -- install flow + plugin contract")
  out.push("  docs/adding-a-plugin.md -- how to add a new plugin")
  ui.info(out.join("\n"))
  return 0
}
