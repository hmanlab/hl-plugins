// status [plugin] -- per-plugin diagnostic report.
// Shows: file presence, config merge state, required binaries, auth, smoke test.

import { existsSync } from "node:fs"
import { basename, join } from "node:path"
import { discoverPlugins, getPlugin } from "../lib/registry.js"
import { run, tryRun } from "../lib/shell.js"
import { ui } from "../lib/ui.js"
import {
  claudeSkillDir,
  hlPluginsDataPluginDir,
  opencodePluginDir,
  opencodeSkillDir,
  tilde,
} from "../lib/paths.js"
import { readClaudeConfig, readOpencodeConfig } from "../lib/config.js"
import type { PluginManifest, PluginRequirement } from "../lib/registry.js"

const LABEL_W = 22

function row(label: string, value: string, ok: boolean | "info"): string {
  const pad = label.padEnd(LABEL_W)
  const mark = ok === "info" ? ui.dim("·") : ok ? ui.green("✓") : ui.red("✗")
  return `  ${ui.dim(pad)} ${value}  ${mark}`
}

function firstNonEmptyLine(s: string): string {
  for (const line of s.split("\n")) {
    const t = line.trim()
    if (t) return t
  }
  return ""
}

async function checkBinary(req: PluginRequirement): Promise<{ ok: boolean; version: string }> {
  const res = await tryRun(req.check)
  if (res && res.code === 0) {
    return { ok: true, version: firstNonEmptyLine(res.stdout) || "present" }
  }
  return { ok: false, version: "not found" }
}

function skillDest(contractPath: string): string | null {
  const parts = contractPath.split("/")
  const skillIdx = parts.lastIndexOf("skill")
  if (skillIdx === -1) return null
  const rel = parts.slice(skillIdx + 1).join("/")
  return join(opencodeSkillDir(), rel)
}

async function reportOne(plugin: PluginManifest): Promise<void> {
  ui.info(ui.bold(`\n${plugin.name} -- ${plugin.description || "(no description)"}`))

  // OpenCode install points
  if (plugin.contract.opencodePlugin) {
    const dest = join(opencodePluginDir(), basename(plugin.contract.opencodePlugin))
    ui.info(row("OpenCode plugin file:", tilde(dest), existsSync(dest)))
  }
  if (plugin.contract.opencodeSkill) {
    const dest = skillDest(plugin.contract.opencodeSkill)
    if (dest) {
      ui.info(row("OpenCode skill file:", tilde(dest), existsSync(dest)))
    }
  }
  if (plugin.contract.opencodePlugin || plugin.contract.permission) {
    const cfg = readOpencodeConfig()
    const pluginEntry = plugin.contract.opencodePlugin
      ? `./plugin/${basename(plugin.contract.opencodePlugin)}`
      : null
    const pluginInCfg = pluginEntry ? (cfg.plugin ?? []).includes(pluginEntry) : true
    const permInCfg = plugin.contract.permission
      ? cfg.permission?.bash?.[plugin.contract.permission] === "allow"
      : true
    const configOk = pluginInCfg && permInCfg
    const configDetail = configOk
      ? `plugin[] + ${plugin.contract.permission ?? "(no perm)"}`
      : [pluginInCfg ? null : "plugin[]", permInCfg ? null : "permission"].filter(Boolean).join(" + ") +
        " missing"
    ui.info(row("OpenCode config:", configDetail, configOk))
  }

  // Claude Code install points
  if (plugin.contract.claudeMcp) {
    const dest = join(hlPluginsDataPluginDir(plugin.name), basename(plugin.contract.claudeMcp))
    ui.info(row("Claude MCP bundle:", tilde(dest), existsSync(dest)))
  }
  if (plugin.contract.claudeSkill) {
    const dest = join(claudeSkillDir(plugin.name), "SKILL.md")
    ui.info(row("Claude skill file:", tilde(dest), existsSync(dest)))
  }
  if (plugin.contract.claudeMcp) {
    const cfg = readClaudeConfig()
    const mcpEntry = cfg.mcpServers?.[plugin.name]
    const mcpOk = mcpEntry !== undefined
    const detail = mcpOk
      ? `mcpServers.${plugin.name} -> ${mcpEntry!.command} ${mcpEntry!.args.join(" ")}`
      : `mcpServers.${plugin.name} missing`
    ui.info(row("Claude mcpServers:", detail, mcpOk))
  }

  // Requirements
  for (const req of plugin.contract.requires ?? []) {
    const { ok, version } = await checkBinary(req)
    ui.info(row(`Required: ${req.name}`, version, ok))
  }

  // Auth: just show logged in / not logged in based on exit code
  if (plugin.contract.auth) {
    const status = await tryRun(plugin.contract.auth.check)
    ui.info(row("Auth:", "logged in", status?.code === 0))
  }

  // Smoke test (postInstall)
  for (const cmd of plugin.contract.postInstall ?? []) {
    const res = await run(cmd, { throwOnError: false })
    if (res.code === 0) {
      const detail = summarizeOutput(res.stdout)
      ui.info(row(`${cmd.split(" ")[0]}:`, detail, true))
    } else {
      const errText = firstNonEmptyLine(res.stderr || res.stdout) || `(exit ${res.code})`
      ui.info(row(`${cmd.split(" ")[0]}:`, ui.red(errText), false))
    }
  }
}

/** Collapse multi-line output to a single readable line. */
function summarizeOutput(s: string): string {
  const collapsed = s.replace(/\s+/g, " ").trim()
  if (collapsed.length <= 120) return collapsed || "ok"
  return collapsed.slice(0, 117) + "..."
}

function parseArgs(args: string[]): { names: string[] } {
  const names: string[] = []
  for (const a of args) {
    if (a.startsWith("-")) ui.warn(`unknown flag: ${a}`)
    else names.push(a)
  }
  return { names }
}

export async function status(args: string[]): Promise<number> {
  const { names } = parseArgs(args)
  const targets = names.length > 0 ? names.map((n) => getPlugin(n)) : discoverPlugins()
  if (targets.length === 0) {
    ui.info("No plugins discovered.")
    return 0
  }
  for (const plugin of targets) {
    await reportOne(plugin)
  }
  return 0
}
