// Read / merge / write ~/.opencode/config.json.
// All merges are additive — never destroy other plugins, MCP servers, or settings.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { opencodeConfigFile } from "./paths.js"

export type OpencodeConfig = {
  $schema?: string
  plugin?: string[]
  permission?: {
    bash?: Record<string, "allow" | "ask" | "deny">
    edit?: "allow" | "ask" | "deny" | Record<string, "allow" | "ask" | "deny">
    webfetch?: "allow" | "ask" | "deny" | Record<string, "allow" | "ask" | "deny">
    [tool: string]: unknown
  }
  [key: string]: unknown
}

export function readOpencodeConfig(): OpencodeConfig {
  const file = opencodeConfigFile()
  if (!existsSync(file)) return {}
  try {
    const text = readFileSync(file, "utf8")
    return JSON.parse(text) as OpencodeConfig
  } catch (err) {
    throw new Error(
      `Failed to parse ${file}: ${(err as Error).message}\n` +
        `Fix or remove the file, then retry.`,
    )
  }
}

export function writeOpencodeConfig(cfg: OpencodeConfig): void {
  const file = opencodeConfigFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", "utf8")
}

/**
 * Add a plugin entry to the `plugin` array. Idempotent.
 * Returns true if the array was actually modified.
 */
export function addPluginToConfig(pluginPath: string): boolean {
  const cfg = readOpencodeConfig()
  const list = (cfg.plugin ??= [])
  if (list.includes(pluginPath)) return false
  list.push(pluginPath)
  writeOpencodeConfig(cfg)
  return true
}

/**
 * Remove a plugin entry from the `plugin` array. Idempotent.
 * Returns true if the array was actually modified.
 */
export function removePluginFromConfig(pluginPath: string): boolean {
  const cfg = readOpencodeConfig()
  const list = cfg.plugin
  if (!list) return false
  const idx = list.indexOf(pluginPath)
  if (idx === -1) return false
  list.splice(idx, 1)
  if (list.length === 0) delete cfg.plugin
  writeOpencodeConfig(cfg)
  return true
}

/**
 * Add a permission pattern (e.g. `"mmx *"` → `"allow"`) under
 * `permission.bash`. Idempotent — won't downgrade an existing entry.
 */
export function addBashPermission(pattern: string, value: "allow" | "ask" | "deny"): boolean {
  const cfg = readOpencodeConfig()
  cfg.permission ??= {}
  cfg.permission.bash ??= {}
  const bash = cfg.permission.bash
  if (bash[pattern] === value) return false
  bash[pattern] = value
  writeOpencodeConfig(cfg)
  return true
}

export function removeBashPermission(pattern: string): boolean {
  const cfg = readOpencodeConfig()
  const bash = cfg.permission?.bash
  if (!bash || !(pattern in bash)) return false
  delete bash[pattern]
  writeOpencodeConfig(cfg)
  return true
}
