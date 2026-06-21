// Read / merge / write ~/.opencode/config.json AND ~/.claude.json.
// All merges are additive — never destroy other plugins, MCP servers, or settings.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { claudeConfigFile, opencodeConfigFile } from "./paths.js"

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

/**
 * Shape of one MCP server entry in `~/.claude.json`'s `mcpServers` map.
 * Claude Code's spec: command + args (the `type` is implicit "stdio" for
 * command+args, "http" for url). We only emit stdio entries.
 */
export type McpServerSpec = {
  type?: "stdio"
  command: string
  args: string[]
  env?: Record<string, string>
}

export type ClaudeConfig = {
  $schema?: string
  mcpServers?: Record<string, McpServerSpec>
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
      `Failed to parse ${file}: ${(err as Error).message}\n` + `Fix or remove the file, then retry.`,
    )
  }
}

export function writeOpencodeConfig(cfg: OpencodeConfig): void {
  const file = opencodeConfigFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", "utf8")
}

/**
 * Read `~/.claude.json` defensively. Claude Code's config file shape is
 * not formally versioned, so we accept any JSON object and only assume
 * the top-level `mcpServers` map (added by the addMcpServer / removeMcpServer
 * helpers). If the file exists but is malformed JSON, surface a clear
 * error rather than silently overwriting.
 */
export function readClaudeConfig(): ClaudeConfig {
  const file = claudeConfigFile()
  if (!existsSync(file)) return {}
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch (err) {
    throw new Error(`Failed to read ${file}: ${(err as Error).message}\n` + `Check the file's permissions.`)
  }
  // Claude Code writes an empty file on first launch — treat that as {}.
  if (text.trim() === "") return {}
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a top-level JSON object")
    }
    return parsed as ClaudeConfig
  } catch (err) {
    throw new Error(
      `Failed to parse ${file}: ${(err as Error).message}\n` +
        `The file may be from a newer/older Claude Code version. ` +
        `Back it up and remove it, then retry.`,
    )
  }
}

export function writeClaudeConfig(cfg: ClaudeConfig): void {
  const file = claudeConfigFile()
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

/**
 * Add or replace an MCP server entry in `~/.claude.json`'s `mcpServers`
 * map. Idempotent — returns false if the entry already exists with the
 * same spec (deep-equal on command+args+env). If the existing entry
 * differs, it is overwritten and the call returns true.
 */
export function addMcpServer(name: string, spec: McpServerSpec): boolean {
  const cfg = readClaudeConfig()
  cfg.mcpServers ??= {}
  const current = cfg.mcpServers[name]
  if (current && mcpSpecsEqual(current, spec)) return false
  cfg.mcpServers[name] = spec
  writeClaudeConfig(cfg)
  return true
}

/**
 * Remove an MCP server entry. Idempotent. Returns true if removed.
 */
export function removeMcpServer(name: string): boolean {
  const cfg = readClaudeConfig()
  const servers = cfg.mcpServers
  if (!servers || !(name in servers)) return false
  delete servers[name]
  if (Object.keys(servers).length === 0) delete cfg.mcpServers
  writeClaudeConfig(cfg)
  return true
}

function mcpSpecsEqual(a: McpServerSpec, b: McpServerSpec): boolean {
  if (a.command !== b.command) return false
  if (a.args.length !== b.args.length) return false
  for (let i = 0; i < a.args.length; i++) {
    if (a.args[i] !== b.args[i]) return false
  }
  const aEnv = a.env ?? {}
  const bEnv = b.env ?? {}
  const aKeys = Object.keys(aEnv)
  const bKeys = Object.keys(bEnv)
  if (aKeys.length !== bKeys.length) return false
  for (const k of aKeys) {
    if (aEnv[k] !== bEnv[k]) return false
  }
  return true
}
