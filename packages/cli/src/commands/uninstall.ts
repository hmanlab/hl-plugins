// uninstall [plugin] -- remove plugin files and config entries.
// Symmetric with install: same manifest, same idempotency rules.
// Does NOT remove the plugin's dependencies (e.g. mmx-cli) or auth.

import { existsSync, readdirSync, rmSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { discoverPlugins, getPlugin } from "../lib/registry.js"
import { ui } from "../lib/ui.js"
import {
  claudeSkillDir,
  hlPluginsDataPluginDir,
  opencodePluginDir,
  opencodeSkillDir,
  tilde,
} from "../lib/paths.js"
import { removeBashPermission, removeMcpServer, removePluginFromConfig } from "../lib/config.js"
import type { PluginManifest } from "../lib/registry.js"

type UninstallOpts = { force: boolean; names: string[] }

function parseArgs(args: string[]): UninstallOpts {
  const names: string[] = []
  let force = false
  for (const a of args) {
    if (a === "-y" || a === "--yes" || a === "--force") force = true
    else if (a.startsWith("-")) ui.warn(`unknown flag: ${a}`)
    else names.push(a)
  }
  return { force, names }
}

/** Plugins with at least one install artifact present. */
function installedPluginNames(): string[] {
  return discoverPlugins()
    .filter((p) => {
      if (p.contract.opencodePlugin) {
        const target = join(opencodePluginDir(), basename(p.contract.opencodePlugin))
        if (existsSync(target)) return true
      }
      if (p.contract.claudeMcp) {
        const target = join(hlPluginsDataPluginDir(p.name), basename(p.contract.claudeMcp))
        if (existsSync(target)) return true
      }
      if (p.contract.claudeSkill) {
        const target = join(claudeSkillDir(p.name), "SKILL.md")
        if (existsSync(target)) return true
      }
      return false
    })
    .map((p) => p.name)
}

function uninstallOne(plugin: PluginManifest): void {
  ui.info(ui.bold(`\n${plugin.name}`))

  // 1. Remove OpenCode plugin file
  if (plugin.contract.opencodePlugin) {
    const dest = join(opencodePluginDir(), basename(plugin.contract.opencodePlugin))
    if (existsSync(dest)) {
      rmSync(dest)
      ui.info(`  ${ui.ok("removed " + tilde(dest))}`)
    } else {
      ui.info(`  ${ui.dim("· plugin file not present: " + tilde(dest))}`)
    }
  }

  // 2. Remove OpenCode skill file (and its parent dir if empty)
  if (plugin.contract.opencodeSkill) {
    const parts = plugin.contract.opencodeSkill.split("/")
    const skillIdx = parts.lastIndexOf("skill")
    const rel = skillIdx >= 0 ? parts.slice(skillIdx + 1).join("/") : basename(plugin.contract.opencodeSkill)
    const dest = join(opencodeSkillDir(), rel)
    if (existsSync(dest)) {
      rmSync(dest)
      ui.info(`  ${ui.ok("removed " + tilde(dest))}`)
    } else {
      ui.info(`  ${ui.dim("· skill file not present: " + tilde(dest))}`)
    }
    // Remove the skill directory if it's now empty (be conservative).
    const parent = dirname(dest)
    try {
      if (existsSync(parent) && readdirSync(parent).length === 0) {
        rmSync(parent, { recursive: true })
        ui.info(`  ${ui.dim("· removed empty dir " + tilde(parent))}`)
      }
    } catch {
      /* ignore */
    }
  }

  // 3. Remove plugin[] entry
  if (plugin.contract.opencodePlugin) {
    const entry = `./plugin/${basename(plugin.contract.opencodePlugin)}`
    if (removePluginFromConfig(entry)) {
      ui.info(`  ${ui.ok(`removed ${entry} from plugin[]`)}`)
    } else {
      ui.info(`  ${ui.dim(`· ${entry} not in plugin[]`)}`)
    }
  }

  // 4. Remove permission.bash pattern (only the plugin's own, never the catch-all)
  if (plugin.contract.permission) {
    if (removeBashPermission(plugin.contract.permission)) {
      ui.info(`  ${ui.ok(`removed bash.${plugin.contract.permission}`)}`)
    } else {
      ui.info(`  ${ui.dim(`· bash.${plugin.contract.permission} not set`)}`)
    }
  }

  // 5. Remove the Claude MCP bundle
  if (plugin.contract.claudeMcp) {
    const dest = join(hlPluginsDataPluginDir(plugin.name), basename(plugin.contract.claudeMcp))
    if (existsSync(dest)) {
      rmSync(dest)
      ui.info(`  ${ui.ok("removed " + tilde(dest))}`)
    } else {
      ui.info(`  ${ui.dim("· mcp bundle not present: " + tilde(dest))}`)
    }
    // Try to remove the parent dir if it's now empty.
    const parent = dirname(dest)
    try {
      if (existsSync(parent) && readdirSync(parent).length === 0) {
        rmSync(parent, { recursive: true })
        ui.info(`  ${ui.dim("· removed empty dir " + tilde(parent))}`)
      }
    } catch {
      /* ignore */
    }
  }

  // 6. Remove the Claude skill file (and its parent dir if empty)
  if (plugin.contract.claudeSkill) {
    const dest = join(claudeSkillDir(plugin.name), "SKILL.md")
    if (existsSync(dest)) {
      rmSync(dest)
      ui.info(`  ${ui.ok("removed " + tilde(dest))}`)
    } else {
      ui.info(`  ${ui.dim("· claude skill not present: " + tilde(dest))}`)
    }
    const parent = dirname(dest)
    try {
      if (existsSync(parent) && readdirSync(parent).length === 0) {
        rmSync(parent, { recursive: true })
        ui.info(`  ${ui.dim("· removed empty dir " + tilde(parent))}`)
      }
    } catch {
      /* ignore */
    }
  }

  // 7. Remove the mcpServers entry
  if (plugin.contract.claudeMcp) {
    if (removeMcpServer(plugin.name)) {
      ui.info(`  ${ui.ok(`removed mcpServers.${plugin.name}`)}`)
    } else {
      ui.info(`  ${ui.dim(`· mcpServers.${plugin.name} not present`)}`)
    }
  }
}

export async function uninstall(args: string[]): Promise<number> {
  const opts = parseArgs(args)

  const names = opts.names.length > 0 ? opts.names : installedPluginNames()
  if (names.length === 0) {
    ui.info("Nothing to uninstall (no installed plugins detected).")
    return 0
  }

  if (!opts.force) {
    ui.info(`About to uninstall: ${names.join(", ")}`)
    ui.info(
      ui.dim(
        "This removes plugin files and config entries. " +
          "Plugin dependencies (e.g. mmx-cli) and credentials are left untouched.",
      ),
    )
    const answer = await ui.promptVisible("Proceed? [y/N] ")
    if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
      ui.info("Cancelled.")
      return 0
    }
  }

  for (const name of names) {
    try {
      uninstallOne(getPlugin(name))
    } catch (err) {
      ui.error(`${name}: ${(err as Error).message}`)
      return 1
    }
  }

  ui.info(ui.green(`\n✓ Uninstalled ${names.length} plugin${names.length === 1 ? "" : "s"}.`))
  return 0
}
