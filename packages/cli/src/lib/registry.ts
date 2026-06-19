// Plugin discovery. Reads packages/plugin-*/package.json from the monorepo
// and surfaces the `hl-plugins.*` contract. CLI stays generic — it never
// imports a plugin by name.

import { readdirSync, readFileSync, existsSync } from "node:fs"
import { join, basename, resolve } from "node:path"
import { monorepoRoot } from "./paths.js"

export type PluginRequirement = {
  name: string
  type: "binary" | "package"
  check: string
  install: string
  /** Optional. When omitted, derived from `install` by replacing "npm install" → "npm update". */
  update?: string
}

export type PluginAuth = {
  check: string
  login: string
  verify: string
  keyLabel: string
  /** Optional env var to read the key from (e.g. "MMX_API_KEY"). */
  envVar?: string
}

export type PluginManifest = {
  /** Kebab-case name, e.g. "mmx". */
  name: string
  /** Package version string. */
  version: string
  /** Description from package.json. */
  description: string
  /** Absolute path to the plugin's package.json. */
  packageDir: string
  /** Contract from `hl-plugins` field. */
  contract: {
    opencodePlugin?: string
    opencodeSkill?: string
    requires?: PluginRequirement[]
    auth?: PluginAuth
    postInstall?: string[]
    defaultInstall?: boolean
    /** bash permission pattern to add (e.g. "mmx *"). */
    permission?: string
  }
}

function readJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, "utf8")) as T
}

function tryReadPlugin(dir: string): PluginManifest | null {
  const pkgPath = join(dir, "package.json")
  if (!existsSync(pkgPath)) return null
  const pkg = readJson<Record<string, unknown>>(pkgPath)
  const contract = pkg["hl-plugins"] as PluginManifest["contract"] | undefined
  if (!contract) return null
  return {
    name: pkg.name?.toString().replace(/^@[^/]+\//, "") ?? basename(dir),
    version: (pkg.version as string) ?? "0.0.0",
    description: (pkg.description as string) ?? "",
    packageDir: resolve(dir),
    contract,
  }
}

/**
 * Discover all plugins in the monorepo.
 * Looks for `packages/plugin-<name>/package.json` with an `hl-plugins` field.
 */
export function discoverPlugins(): PluginManifest[] {
  const root = monorepoRoot()
  const pkgsDir = join(root, "packages")
  if (!existsSync(pkgsDir)) return []
  return readdirSync(pkgsDir)
    .filter((d) => d.startsWith("plugin-"))
    .map((d) => tryReadPlugin(join(pkgsDir, d)))
    .filter((p): p is PluginManifest => p !== null)
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Look up one plugin by short name (e.g. "mmx"). Throws if not found. */
export function getPlugin(name: string): PluginManifest {
  const all = discoverPlugins()
  const match = all.find((p) => p.name === name)
  if (!match) {
    const known = all.map((p) => p.name).join(", ")
    throw new Error(
      `Unknown plugin: "${name}".\n` +
        `Known plugins: ${known || "(none discovered)"}\n` +
        `Check that packages/plugin-${name}/package.json exists and has an "hl-plugins" field.`,
    )
  }
  return match
}

export function defaultInstallPlugins(): PluginManifest[] {
  return discoverPlugins().filter((p) => p.contract.defaultInstall !== false)
}
