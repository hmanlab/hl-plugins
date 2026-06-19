// Plugin discovery. Two sources, deduped by short name:
//
//   1. Dev mode    -- `packages/plugin-*/package.json` in the monorepo.
//   2. Pub'd mode  -- `node_modules/@hl-plugins/*/package.json` walked up
//                    from the CLI's own location.
//
// The CLI stays generic -- it never imports a plugin by name. Adding a
// plugin is "drop a folder" in dev, or `npm install -g @hl-plugins/<name>`
// in published mode.

import { readdirSync, readFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, basename, resolve } from "node:path"
import { monorepoRoot } from "./paths.js"

export type PluginRequirement = {
  name: string
  type: "binary" | "package"
  check: string
  install: string
  /** Optional. When omitted, derived from `install` by replacing "npm install" -> "npm update". */
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
  /** Where this manifest was found. */
  source: "monorepo" | "node_modules"
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

function tryReadPlugin(dir: string, source: "monorepo" | "node_modules"): PluginManifest | null {
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
    source,
    contract,
  }
}

/** Walk up from a directory looking for ancestor `node_modules` dirs. */
function findAncestorNodeModules(start: string, maxLevels = 8): string[] {
  const found: string[] = []
  let dir = start
  for (let i = 0; i < maxLevels; i++) {
    const nm = join(dir, "node_modules")
    if (existsSync(nm)) found.push(nm)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return found
}

/** Plugins from `packages/plugin-<name>/` in the monorepo. */
function discoverInMonorepo(): PluginManifest[] {
  let root: string
  try {
    root = monorepoRoot()
  } catch {
    return []
  }
  const pkgsDir = join(root, "packages")
  if (!existsSync(pkgsDir)) return []
  return readdirSync(pkgsDir)
    .filter((d) => d.startsWith("plugin-"))
    .map((d) => tryReadPlugin(join(pkgsDir, d), "monorepo"))
    .filter((p): p is PluginManifest => p !== null)
}

// (the comment above uses angle brackets; if tsc chokes on the JSDoc,
//  that's why this fix is in a sibling line comment)
function discoverInNodeModules(): PluginManifest[] {
  const here = dirname(fileURLToPath(import.meta.url))
  const found: PluginManifest[] = []
  for (const nm of findAncestorNodeModules(here)) {
    const scopeDir = join(nm, "@hl-plugins")
    if (!existsSync(scopeDir)) continue
    for (const d of readdirSync(scopeDir)) {
      const plugin = tryReadPlugin(join(scopeDir, d), "node_modules")
      if (plugin && !found.some((p) => p.name === plugin.name)) {
        found.push(plugin)
      }
    }
  }
  return found
}

/**
 * Discover all plugins, deduped by short name.
 * Monorepo wins over node_modules when both have the same name
 * (so local source beats installed package).
 */
export function discoverPlugins(): PluginManifest[] {
  const monorepo = discoverInMonorepo()
  const installed = discoverInNodeModules().filter(
    (p) => !monorepo.some((m) => m.name === p.name),
  )
  return [...monorepo, ...installed].sort((a, b) => a.name.localeCompare(b.name))
}

/** Look up one plugin by short name (e.g. "mmx"). Throws if not found. */
export function getPlugin(name: string): PluginManifest {
  const all = discoverPlugins()
  const match = all.find((p) => p.name === name)
  if (!match) {
    const known = all.map((p) => p.name).join(", ")
    const hint = match === null && !known
      ? `\nIf you're using the published CLI, run \`npm install -g @hl-plugins/${name}\` first.`
      : ""
    throw new Error(
      `Unknown plugin: "${name}".\n` +
        `Known plugins: ${known || "(none discovered)"}.` +
        hint,
    )
  }
  return match
}

export function defaultInstallPlugins(): PluginManifest[] {
  return discoverPlugins().filter((p) => p.contract.defaultInstall !== false)
}
