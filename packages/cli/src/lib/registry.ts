// Plugin discovery. Two sources, deduped by short name:
//
//   1. Dev mode    -- `packages/plugin-*/package.json` in the monorepo.
//   2. Pub'd mode  -- `node_modules/@hmanlab/*/package.json` walked up
//                    from the CLI's own location.
//
// The CLI stays generic -- it never imports a plugin by name. Adding a
// plugin is "drop a folder" in dev, or auto-installed from npm in
// published mode when the user requests it by name.

import { readdirSync, readFileSync, existsSync } from "node:fs"
import { execSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join, basename, resolve } from "node:path"
import { monorepoRoot } from "./paths.js"
import { ui } from "./ui.js"

export type PluginRequirement = {
  name: string
  type: "binary" | "package"
  check: string
  install: string
  /** Optional. When omitted, derived from `install` by replacing "npm install" -> "npm update". */
  update?: string
}

export type LoginArg = string | { var: string }

/**
 * The login command. Two forms:
 *   - string: legacy. Interpolated via `fillTemplate` and run through `sh -c`.
 *              Not safe for user-supplied values.
 *   - object: preferred for any login that takes user input. Runs as direct
 *              argv — no shell, no metacharacter interpretation.
 */
export type LoginSpec = string | { cmd: string; args: LoginArg[] }

export type PluginAuth = {
  check: string
  login: LoginSpec
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
    /** Path (relative to packageDir) to a bundled Claude Code MCP server. */
    claudeMcp?: string
    /** Path (relative to packageDir) to a Claude Code skill markdown file. */
    claudeSkill?: string
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
    const scopeDir = join(nm, "@hmanlab")
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
  const installed = discoverInNodeModules().filter((p) => !monorepo.some((m) => m.name === p.name))
  return [...monorepo, ...installed].sort((a, b) => a.name.localeCompare(b.name))
}

/** Look up one plugin by short name (e.g. "mmx"). Throws if not found. */
export function getPlugin(name: string): PluginManifest {
  const all = discoverPlugins()
  const match = all.find((p) => p.name === name)
  if (!match) {
    const known = all.map((p) => p.name).join(", ")
    const inMonorepo = inMonorepoRoot()
    const hint = inMonorepo
      ? `\nIf you're using the published CLI, run \`npm install -g @hmanlab/${name}\` first.`
      : `\nIf you're using the published CLI, run \`npm install -g @hmanlab/${name}\` first.`
    throw new Error(`Unknown plugin: "${name}".\n` + `Known plugins: ${known || "(none discovered)"}.` + hint)
  }
  return match
}

/** True if this CLI is being run from a monorepo checkout (dev mode). */
function inMonorepoRoot(): boolean {
  try {
    monorepoRoot()
    return true
  } catch {
    return false
  }
}

export function defaultInstallPlugins(): PluginManifest[] {
  return discoverPlugins().filter((p) => p.contract.defaultInstall !== false)
}

/** The CLI's own package directory (parent of dist/ or src/). */
function cliPackageDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, "..")
}

/**
 * Ensure a plugin package is available. If discovery fails, install it
 * from npm on the fly into the nearest node_modules ancestor. Throws
 * if the package doesn't exist on npm or lacks an hl-plugins contract.
 */
export async function ensurePluginAvailable(name: string): Promise<PluginManifest> {
  const existing = discoverPlugins().find((p) => p.name === name)
  if (existing) return existing

  const pkgName = `@hmanlab/${name}`
  ui.info(`  Installing ${pkgName} from npm...`)

  try {
    execSync(`npm install ${pkgName}`, {
      cwd: cliPackageDir(),
      stdio: "pipe",
      timeout: 60_000,
    })
  } catch (err) {
    throw new Error(
      `Plugin "${name}" not found locally.\n` +
        `Tried to install ${pkgName} from npm but it failed.\n` +
        `Make sure the package exists on npm and you have network access.`,
    )
  }

  const after = discoverPlugins().find((p) => p.name === name)
  if (!after) {
    throw new Error(
      `Plugin "${name}" not found after installing ${pkgName}.\n` +
        `The package may not contain an hl-plugins contract.`,
    )
  }
  return after
}
