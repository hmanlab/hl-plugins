// Resolves filesystem paths the CLI cares about.
// All paths are tilde-expanded so they survive the
// `~/Desktop` vs `/Users/<u>/Desktop` macOS split described in AGENTS.md.

import { homedir, platform } from "node:os"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"
import { existsSync, readFileSync } from "node:fs"

const HOME = homedir()

/** The user's OpenCode config directory. */
export function opencodeConfigDir(): string {
  // macOS / Linux default per OpenCode docs. Add XDG/Windows later if needed.
  if (platform() === "darwin" || platform() === "linux") {
    return join(HOME, ".opencode")
  }
  return join(HOME, ".opencode")
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
  return join(HOME, "Desktop", "mmx-output")
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
  if (p === "~") return HOME
  if (p.startsWith("~/")) return join(HOME, p.slice(2))
  return p
}

/** Shorten a path for display by replacing $HOME with `~`. */
export function tilde(p: string): string {
  if (p === HOME) return "~"
  if (p.startsWith(HOME + "/")) return "~" + p.slice(HOME.length)
  return p
}
