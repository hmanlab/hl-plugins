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
 * Resolves the hmanlab root on disk. Mirrors
 * `packages/plugin-memo/src/config.ts:hmanlabHome()` so the CLI's install
 * artifacts and the plugin's runtime data share one knob.
 *
 *   1. `$HMANLAB_HOME` if set and non-empty (whitespace-only falls through).
 *   2. Leading `~` is expanded to `$HOME`.
 *   3. The result is made absolute against the cwd.
 *   4. Default: `$HOME/.hmanlab`.
 *
 * Migrated from the previous `~/.local/share/hl-plugins/` layout — see
 * `install.ts:migrateLegacyBundles()` for the auto-move on first install.
 */
export function hmanlabHome(): string {
  const fromEnv = process.env["HMANLAB_HOME"]
  if (fromEnv && fromEnv.trim().length > 0) return resolve(expandHome(fromEnv))
  return join(HOME(), ".hmanlab")
}

/** Where the CLI drops per-plugin install artifacts (MCP bundle, CLI bundle). */
export function hmanlabPluginsDir(): string {
  return join(hmanlabHome(), "plugins")
}

/** Where one plugin's install artifacts live. */
export function hmanlabPluginDir(pluginName: string): string {
  return join(hmanlabPluginsDir(), pluginName)
}

/**
 * Returns the legacy install-artifact directory for the current platform,
 * or `null` if the platform is unsupported. Used only by the auto-migration
 * step in `install.ts` — new code should use `hmanlabPluginDir()`.
 */
export function legacyHlPluginsDataDir(): string | null {
  if (PLATFORM() === "win32") {
    const local = process.env.LOCALAPPDATA ?? join(HOME(), "AppData", "Local")
    return join(local, "hl-plugins")
  }
  return join(HOME(), ".local", "share", "hl-plugins")
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
