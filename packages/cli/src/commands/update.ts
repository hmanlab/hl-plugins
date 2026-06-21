// update [plugin] -- re-copy files, bump dependencies, re-merge config.
// Does NOT touch auth (credentials are managed by the plugin's own CLI).
// Symmetric with install: same copy + config-merge logic.

import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { discoverPlugins, defaultInstallPlugins, ensurePluginAvailable } from "../lib/registry.js"
import { run } from "../lib/shell.js"
import { ui } from "../lib/ui.js"
import { opencodePluginDir, opencodeSkillDir, tilde } from "../lib/paths.js"
import { addBashPermission, addPluginToConfig } from "../lib/config.js"
import type { PluginManifest, PluginRequirement } from "../lib/registry.js"

/** Derive `npm update -g` from `npm install -g` if the contract omits `update`. */
function deriveUpdate(req: PluginRequirement): string {
  if (req.update) return req.update
  return req.install.replace(/npm install/i, "npm update")
}

async function updateRequirement(req: PluginRequirement): Promise<string> {
  const cmd = deriveUpdate(req)
  const res = await run(cmd, { throwOnError: false })
  if (res.code !== 0) {
    throw new Error(`Update failed: ${cmd}\n  ${(res.stderr || res.stdout).trim() || "(no output)"}`)
  }
  // Re-probe
  const verify = await run(req.check, { throwOnError: false })
  if (verify.code === 0) {
    return firstNonEmptyLine(verify.stdout) || "updated"
  }
  return "update command ran, but probe still fails"
}

function firstNonEmptyLine(s: string): string {
  for (const line of s.split("\n")) {
    const t = line.trim()
    if (t) return t
  }
  return ""
}

async function copyPluginFiles(plugin: PluginManifest): Promise<string[]> {
  const copied: string[] = []
  if (plugin.contract.opencodePlugin) {
    const src = join(plugin.packageDir, plugin.contract.opencodePlugin)
    const dest = join(opencodePluginDir(), basename(plugin.contract.opencodePlugin))
    if (!existsSync(src)) throw new Error(`Plugin source missing: ${src}`)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(src, dest)
    copied.push(tilde(dest))
  }
  if (plugin.contract.opencodeSkill) {
    const src = join(plugin.packageDir, plugin.contract.opencodeSkill)
    if (!existsSync(src)) throw new Error(`Skill source missing: ${src}`)
    const parts = plugin.contract.opencodeSkill.split("/")
    const skillIdx = parts.lastIndexOf("skill")
    const rel = skillIdx >= 0 ? parts.slice(skillIdx + 1).join("/") : basename(src)
    const dest = join(opencodeSkillDir(), rel)
    if (statSync(src).isDirectory()) {
      mkdirSync(dest, { recursive: true })
      await run(`cp -R ${JSON.stringify(src + "/.")} ${JSON.stringify(dest)}`)
    } else {
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(src, dest)
    }
    copied.push(tilde(dest))
  }
  return copied
}

function mergeConfig(plugin: PluginManifest): string[] {
  const changes: string[] = []
  if (plugin.contract.opencodePlugin) {
    const filename = basename(plugin.contract.opencodePlugin)
    const entry = `./plugin/${filename}`
    if (addPluginToConfig(entry)) changes.push(`added ${entry} to plugin[]`)
    else changes.push(`plugin[] already has ${entry}`)
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

async function updateOne(plugin: PluginManifest, step: number, total: number): Promise<void> {
  ui.info(ui.bold(`\n[${step}/${total}] ${plugin.name}`))

  const copied = await ui.spinner("Re-copy files", () => copyPluginFiles(plugin))
  for (const p of copied) ui.info(`    ${ui.dim("→")} ${p}`)

  for (const req of plugin.contract.requires ?? []) {
    const note = await ui.spinner(`Bump dependency: ${req.name}`, () => updateRequirement(req))
    if (note) ui.info(`    ${ui.dim(note)}`)
  }

  const configChanges = await ui.spinner("Re-merge opencode config", () =>
    Promise.resolve(mergeConfig(plugin)),
  )
  for (const c of configChanges) ui.info(`    ${ui.dim("•")} ${c}`)

  if (plugin.contract.postInstall?.length) {
    for (const cmd of plugin.contract.postInstall) {
      await ui.spinner(`Verify: ${cmd}`, async () => {
        const res = await run(cmd, { throwOnError: false })
        if (res.code !== 0) {
          throw new Error(`${cmd} failed (exit ${res.code})`)
        }
      })
    }
  }
}

function parseArgs(args: string[]): { names: string[] } {
  const names: string[] = []
  for (const a of args) {
    if (a.startsWith("-")) ui.warn(`unknown flag: ${a}`)
    else names.push(a)
  }
  return { names }
}

export async function update(args: string[]): Promise<number> {
  const { names } = parseArgs(args)
  // update without args: bump every installed plugin.
  const installed = discoverPlugins().filter((p) => {
    if (!p.contract.opencodePlugin) return false
    return existsSync(join(opencodePluginDir(), basename(p.contract.opencodePlugin)))
  })
  const targets = names.length > 0 ? await Promise.all(names.map((n) => ensurePluginAvailable(n))) : installed
  if (targets.length === 0) {
    ui.info("No plugins to update.")
    return 0
  }
  for (let i = 0; i < targets.length; i++) {
    try {
      await updateOne(targets[i]!, i + 1, targets.length)
    } catch (err) {
      ui.error(`${targets[i]!.name}: ${(err as Error).message}`)
      return 1
    }
  }
  ui.info(ui.green(`\n✓ Updated ${targets.length} plugin${targets.length === 1 ? "" : "s"}.`))
  return 0
}
