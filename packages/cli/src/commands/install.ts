// install [plugin] -- full install flow.
//
// Steps (mirrors docs/architecture.md):
//   1. Resolve plugin
//   2. Pre-flight (Node version, opencode config dir)
//   3. Requirements (auto-install missing binaries)
//   4. Authenticate (hidden API key prompt, region auto-retry on 401)
//   5. Copy files (plugin + skill) into ~/.opencode/
//   6. Merge config (additive, idempotent)
//   7. Verify (run postInstall commands)

import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { discoverPlugins, defaultInstallPlugins, getPlugin } from "../lib/registry.js"
import { run, runArgv, tryRun, ShellError, fillTemplate } from "../lib/shell.js"
import { ui } from "../lib/ui.js"
import {
  opencodeConfigDir,
  opencodeConfigFile,
  opencodePluginDir,
  opencodeSkillDir,
  tilde,
} from "../lib/paths.js"
import { addBashPermission, addPluginToConfig } from "../lib/config.js"
import type { PluginManifest, PluginRequirement } from "../lib/registry.js"

// ── Per-step actions ──────────────────────────────────────────────────────

async function checkPreflight(): Promise<void> {
  const major = parseInt(process.versions.node.split(".")[0] ?? "0", 10)
  if (major < 18) {
    throw new Error(`Node.js >= 18 required (you have ${process.versions.node}).`)
  }
  if (!existsSync(opencodeConfigDir())) {
    mkdirSync(opencodeConfigDir(), { recursive: true })
  }
}

async function ensureRequirement(req: PluginRequirement): Promise<string> {
  const probe = await tryRun(req.check)
  if (probe && probe.code === 0) {
    // Try to surface a version string from the probe output if present
    const line = (probe.stdout.trim().split("\n")[0] ?? "").trim()
    return line ? `present (${line})` : "present"
  }
  // Not present -- auto-install
  ui.info(`  ${ui.cyan("→")} installing ${req.name}: ${req.install}`)
  const install = await run(req.install, { throwOnError: false })
  if (install.code !== 0) {
    throw new Error(
      `Failed to install ${req.name}.\n` +
        `  command: ${req.install}\n` +
        `  ${install.stderr.trim() || install.stdout.trim() || "(no output)"}`,
    )
  }
  // Re-check
  const verify = await tryRun(req.check)
  if (!verify || verify.code !== 0) {
    throw new Error(
      `Installed ${req.name} but "${req.check}" still fails. ` +
        `Make sure it's on your PATH.`,
    )
  }
  return "installed"
}

async function authenticate(plugin: PluginManifest, opts: InstallOpts): Promise<string> {
  const auth = plugin.contract.auth
  if (!auth) return "no auth required"
  if (opts.skipAuth) return "skipped (--no-auth)"

  // Already logged in?
  const status = await tryRun(auth.check)
  if (status && status.code === 0) return "already authenticated"

  // Find a key: flag → env var → prompt
  let key = opts.key
  if (!key && auth.envVar) key = process.env[auth.envVar]
  if (!key) {
    key = await ui.promptHidden(`Paste your ${auth.keyLabel} (input hidden): `)
  }
  if (!key) throw new Error(`No ${auth.keyLabel} provided.`)

  const login = auth.login
  const loginRes = typeof login === "string"
    ? await run(fillTemplate(login, { key }), { throwOnError: false })
    : await runArgv(login.cmd, login.args, { key }, { throwOnError: false })
  if (loginRes.code !== 0) {
    throw new Error(
      `Login failed (exit ${loginRes.code}).\n` +
        `  ${(loginRes.stderr || loginRes.stdout).trim() || "(no output)"}`,
    )
  }

  // Smoke test + region auto-retry
  const regions = ["global", "cn"] as const
  for (const attempt of [auth.verify, ...regions.map((r) => `mmx config set --key region --value ${r} && ${auth.verify}`)]) {
    const res = await run(attempt, { throwOnError: false })
    if (res.code === 0) {
      return attempt === auth.verify ? "authenticated" : "authenticated (region auto-retry succeeded)"
    }
  }
  throw new Error(
    `Authentication smoke test ("${auth.verify}") failed. ` +
      `Tried region=global and region=cn. ` +
      `Check your key and network connection.`,
  )
}

async function copyPluginFiles(plugin: PluginManifest): Promise<string[]> {
  const copied: string[] = []
  if (plugin.contract.opencodePlugin) {
    const src = join(plugin.packageDir, plugin.contract.opencodePlugin)
    const dest = join(opencodePluginDir(), basename(plugin.contract.opencodePlugin))
    if (!existsSync(src)) {
      throw new Error(`Plugin source missing: ${src}`)
    }
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(src, dest)
    copied.push(tilde(dest))
  }
  if (plugin.contract.opencodeSkill) {
    const src = join(plugin.packageDir, plugin.contract.opencodeSkill)
    if (!existsSync(src)) {
      throw new Error(`Skill source missing: ${src}`)
    }
    // Preserve the relative path under skill/ (e.g. "mmx/SKILL.md" or "mmx/index.md")
    const parts = plugin.contract.opencodeSkill.split("/")
    const skillIdx = parts.lastIndexOf("skill")
    const rel = skillIdx >= 0 ? parts.slice(skillIdx + 1).join("/") : basename(src)
    const dest = join(opencodeSkillDir(), rel)
    if (statSync(src).isDirectory()) {
      // skill is a directory → copy its contents recursively
      await copyDir(src, dirname(dest))
    } else {
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(src, dest)
    }
    copied.push(tilde(dest))
  }
  return copied
}

async function copyDir(src: string, dest: string): Promise<void> {
  mkdirSync(dest, { recursive: true })
  // Use the shell's `cp -R` -- works on macOS + Linux, no extra dep.
  // The `/.` trick copies contents without nesting a subdirectory.
  await run(`cp -R ${JSON.stringify(src + "/.")} ${JSON.stringify(dest)}`)
}

async function mergeConfig(plugin: PluginManifest): Promise<string[]> {
  const changes: string[] = []
  if (plugin.contract.opencodePlugin) {
    const filename = basename(plugin.contract.opencodePlugin)
    const entry = `./plugin/${filename}`
    if (addPluginToConfig(entry)) {
      changes.push(`added ${entry} to plugin[]`)
    } else {
      changes.push(`plugin[] already has ${entry}`)
    }
  }
  if (plugin.contract.permission) {
    if (addBashPermission(plugin.contract.permission, "allow")) {
      changes.push(`added bash.${plugin.contract.permission} = "allow"`)
    } else {
      changes.push(`bash.${plugin.contract.permission} = "allow" already set`)
    }
  }
  return changes
}

async function verify(plugin: PluginManifest): Promise<string[]> {
  const out: string[] = []
  for (const cmd of plugin.contract.postInstall ?? []) {
    const res = await run(cmd, { throwOnError: false })
    const text = (res.stdout || res.stderr).trim()
    if (res.code !== 0) {
      throw new Error(
        `Verification failed: ${cmd}\n` +
          `  ${text || "(no output)"}`,
      )
    }
    out.push(text.split("\n")[0] || cmd)
  }
  return out
}

// ── Orchestration ────────────────────────────────────────────────────────

type InstallOpts = {
  skipAuth: boolean
  key?: string
  verbose: boolean
}

async function installOne(plugin: PluginManifest, opts: InstallOpts, step: number, total: number): Promise<void> {
  ui.info(ui.bold(`\n[${step}/${total}] ${plugin.name} -- ${plugin.description}`))

  await ui.spinner("Pre-flight checks", async () => {
    await checkPreflight()
  })

  for (const req of plugin.contract.requires ?? []) {
    const note = await ui.spinner(`Requirement: ${req.name}`, () => ensureRequirement(req))
    if (note) ui.info(`    ${ui.dim(note)}`)
  }

  const auth = plugin.contract.auth
  if (auth) {
    const note = await ui.spinner(`Authenticate: ${auth.keyLabel}`, () =>
      authenticate(plugin, opts),
    )
    if (note) ui.info(`    ${ui.dim(note)}`)
  }

  const copied = await ui.spinner("Copy files", () => copyPluginFiles(plugin))
  for (const p of copied) ui.info(`    ${ui.dim("→")} ${p}`)

  const configChanges = await ui.spinner("Merge opencode config", () => mergeConfig(plugin))
  for (const c of configChanges) ui.info(`    ${ui.dim("•")} ${c}`)

  if (plugin.contract.postInstall?.length) {
    const verified = await ui.spinner("Verify", () => verify(plugin))
    for (const v of verified) ui.info(`    ${ui.dim("•")} ${v}`)
  }
}

function parseArgs(args: string[]): InstallOpts & { names: string[] } {
  const names: string[] = []
  let key: string | undefined
  let skipAuth = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === "--no-auth") skipAuth = true
    else if (a === "--key" || a === "-k") {
      key = args[++i]
      if (!key) throw new Error("--key requires a value")
    } else if (a === "--verbose" || a === "-v") {
      // handled below
    } else if (a.startsWith("--")) {
      // unknown flag -- ignore for now, but warn
      ui.warn(`unknown flag: ${a}`)
    } else {
      names.push(a)
    }
  }
  return { names, skipAuth, key, verbose: args.includes("--verbose") || args.includes("-v") || process.env["HL_PLUGINS_DEBUG"] === "1" }
}

export async function install(args: string[]): Promise<number> {
  const opts = parseArgs(args)
  const targets =
    opts.names.length > 0 ? opts.names.map((n) => getPlugin(n)) : defaultInstallPlugins()
  if (targets.length === 0) {
    ui.warn("No plugins to install (none marked defaultInstall in this monorepo).")
    return 0
  }

  let succeeded = 0
  for (let i = 0; i < targets.length; i++) {
    const plugin = targets[i]!
    try {
      await installOne(plugin, opts, i + 1, targets.length)
      succeeded++
    } catch (err) {
      ui.info("")
      ui.error(`${plugin.name}: ${(err as Error).message}`)
      if (err instanceof ShellError) {
        ui.info(ui.dim(`  command: ${err.cmd}`))
      }
      // Don't roll back: the install is idempotent, so re-running picks
      // up where this attempt left off.
      return 1
    }
  }

  if (succeeded > 0) {
    ui.info(
      ui.green(
        `\n✓ Done. Installed ${succeeded} plugin${succeeded === 1 ? "" : "s"}. Restart opencode to use the new tools.`,
      ),
    )
  }
  return 0
}
