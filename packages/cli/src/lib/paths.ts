// Resolves filesystem paths the CLI cares about.
// All paths are tilde-expanded so they survive the
// `~/Desktop` vs `/Users/<u>/Desktop` macOS split described in AGENTS.md.

import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { os_ } from "./os-shim.js"

/** The user's $HOME. Resolved on every call so tests can mock `os_.homedir`. */
function HOME(): string {
  return os_.homedir()
}

/** Current platform string. Resolved on every call so tests can mock `os_.platform`. */
function PLATFORM(): NodeJS.Platform {
  return os_.platform()
}

/** The user's OpenCode config directory. */
export function opencodeConfigDir(): string {
  // macOS / Linux default per OpenCode docs. Add XDG/Windows later if needed.
  return join(HOME(), ".opencode")
}

export function opencodePluginDir(): string {
  return join(opencodeConfigDir(), "plugin")
}

export function opencodeSkillDir(): string {
  return join(opencodeConfigDir(), "skill")
}

export function opencodeConfigFile(): string {
  return join(opencodeConfigDir(), "config.json")
}

/** Where generated mmx assets land. */
export function mmxOutputDir(): string {
  return join(HOME(), "Desktop", "mmx-output")
}

/**
 * The user's Claude Code config directory.
 *
 * Claude Code's own data lives at `~/.claude/` (not in the config file at
 * `~/.claude.json` — that file points back here). The directory holds the
 * `skills/`, `plugins/`, etc. that Claude Code scans at startup.
 */
export function claudeConfigDir(): string {
  if (PLATFORM() === "win32") {
    const appdata = process.env.APPDATA ?? join(HOME(), "AppData", "Roaming")
    return join(appdata, "Claude")
  }
  // macOS + Linux: ~/.claude/
  return join(HOME(), ".claude")
}

/** Where Claude Code stores the skill markdown files for a given plugin. */
export function claudeSkillDir(pluginName: string): string {
  return join(claudeConfigDir(), "skills", pluginName)
}

/**
 * Path to Claude Code's main settings file (the `mcpServers` registry).
 * Cross-platform per Anthropic's docs: always `~/.claude.json` — even on
 * Windows. (The `mcpServers` key in this file is the seam the install
 * flow merges into.)
 */
export function claudeConfigFile(): string {
  return join(HOME(), ".claude.json")
}

/**
 * Where the CLI keeps runtime artifacts it owns — bundled MCP server
 * executables, plugin-specific data dirs, etc. XDG-style on every
 * platform: `~/.local/share/hl-plugins/` on macOS/Linux, `%LOCALAPPDATA%
 * \hl-plugins\` on Windows.
 */
export function hlPluginsDataDir(): string {
  if (PLATFORM() === "win32") {
    const local = process.env.LOCALAPPDATA ?? join(HOME(), "AppData", "Local")
    return join(local, "hl-plugins")
  }
  // macOS + Linux: $XDG_DATA_HOME/hl-plugins OR ~/.local/share/hl-plugins
  const xdg = process.env.XDG_DATA_HOME
  if (xdg) return join(xdg, "hl-plugins")
  return join(HOME(), ".local", "share", "hl-plugins")
}

/** Where one plugin's runtime artifacts live under hlPluginsDataDir(). */
export function hlPluginsDataPluginDir(pluginName: string): string {
  return join(hlPluginsDataDir(), pluginName)
}

// Memoized: finding the monorepo root scans the filesystem, so do it once.
let _monorepoRoot: string | null = null

/**
 * Walk up from this file's directory until we find a package.json with
 * a `workspaces` field — that's the monorepo root. Works regardless of
 * how deeply nested the CLI source is.
 */
export function monorepoRoot(): string {
  if (_monorepoRoot) return _monorepoRoot
  const here = dirname(fileURLToPath(import.meta.url))
  let dir = here
  for (let i = 0; i < 12; i++) {
    const pkg = join(dir, "package.json")
    if (existsSync(pkg)) {
      try {
        const json = JSON.parse(readFileSync(pkg, "utf8")) as Record<string, unknown>
        if (Array.isArray(json["workspaces"])) {
          _monorepoRoot = dir
          return dir
        }
      } catch {
        // ignore unreadable package.json
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(
    `Could not find monorepo root (no package.json with "workspaces" found walking up from ${here}).`,
  )
}

/** Where this CLI package lives. */
export function cliPackageDir(): string {
  return join(monorepoRoot(), "packages", "cli")
}

/** Expand a leading `~` to $HOME. */
export function expandHome(p: string): string {
  const home = HOME()
  if (p === "~") return home
  if (p.startsWith("~/")) return join(home, p.slice(2))
  return p
}

/** Shorten a path for display by replacing $HOME with `~`. */
export function tilde(p: string): string {
  const home = HOME()
  if (p === home) return "~"
  if (p.startsWith(home + "/")) return "~" + p.slice(home.length)
  return p
}

/** Resolve the current $HOME. Exported for tests and for the install flow. */
export function homeDir(): string {
  return HOME()
}
