// install [plugin] -- full install flow.
//
// Steps (mirrors docs/architecture.md):
//   1. Resolve plugin
//   2. Pre-flight (Node version, opencode config dir)
//   3. Requirements (auto-install missing binaries)
//   4. Authenticate (hidden API key prompt, region auto-retry on 401)
//   5. Copy files (plugin + skill + claudeMcp bundle + claudeSkill)
//   6. Merge config (additive, idempotent — opencode + claude.json)
//   7. Verify (run postInstall commands)

import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { discoverPlugins, defaultInstallPlugins, ensurePluginAvailable } from "../lib/registry.js"
import { run, runArgv, tryRun, ShellError, fillTemplate } from "../lib/shell.js"
import { ui } from "../lib/ui.js"
import {
  claudeConfigDir,
  claudeSkillDir,
  hmanlabPluginDir,
  hmanlabPluginsDir,
  legacyHlPluginsDataDir,
  opencodeConfigDir,
  opencodePluginDir,
  opencodeSkillDir,
  tilde,
} from "../lib/paths.js"
import { addBashPermission, addMcpServer, addPluginToConfig, type McpServerSpec } from "../lib/config.js"
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
    throw new Error(`Installed ${req.name} but "${req.check}" still fails. ` + `Make sure it's on your PATH.`)
  }
  return "installed"
}

/**
 * Resolve the absolute path to the plugin's copied CLI bundle, or null if
 * the plugin didn't declare one. Used to invoke preInstall/disableCommand
 * without relying on PATH.
 */
function cliBundlePath(plugin: PluginManifest): string | null {
  if (!plugin.contract.cli) return null
  return join(hmanlabPluginDir(plugin.name), basename(plugin.contract.cli))
}

/**
 * Run a plugin subcommand via the copied CLI bundle. `subcommand` is the
 * rest of the argv (e.g. "embedder install"). Returns the run result; the
 * caller decides whether to fail the install.
 */
async function runPluginCli(plugin: PluginManifest, subcommand: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const bundle = cliBundlePath(plugin)
  if (!bundle || !existsSync(bundle)) {
    throw new Error(
      `Plugin "${plugin.name}" declares an embedder but no copied CLI bundle was found at ` +
        `${bundle ?? "<missing>"}. The install is incomplete — re-run \`hl-plugins install ${plugin.name}\`.`,
    )
  }
  return run(`bun ${JSON.stringify(bundle)} ${subcommand}`, { throwOnError: false })
}

/**
 * Prompt the user about an optional embedder (local model) the plugin wants
 * to use, then *persist the answer immediately* — there's no "run later."
 *
 *   Yes → run `bun <copied-cli> <preInstall>`. Sets embedder_mode=minilm.
 *          The model downloads on the very next memory call (~2s warmup).
 *   No  → run `bun <copied-cli> <disableCommand>`. Sets embedder_mode=hash.
 *          The model is never downloaded — `loadExtractor()` short-circuits
 *          because of the config flag.
 *
 * Non-TTY installs (CI, piped scripts) treat it as Yes — the install never
 * blocks waiting for user input.
 */
async function promptEmbedder(plugin: PluginManifest): Promise<string> {
  const emb = plugin.contract.embedder
  if (!emb) return "no embedder declared"
  const nonInteractive = !process.stdin.isTTY
  if (!nonInteractive) {
    const lines: string[] = []
    lines.push(`${ui.bold(emb.name)} (~${emb.sizeMb} MB) ${emb.purpose}.`)
    if (emb.tradeoff) {
      const t = emb.tradeoff
      lines.push("")
      lines.push(`  ${ui.green("With it:")}    ${t.with}`)
      lines.push(`  ${ui.yellow("Without it:")} ${t.without}`)
      if (t.note) lines.push(`  ${ui.dim(`(${t.note})`)}`)
    }
    lines.push("")
    const answer = await ui.promptYesNo("Enable?", true)
    if (!answer) {
      // User declined. Persist immediately via the disable subcommand.
      if (!emb.disableCommand || emb.disableCommand.length === 0) {
        throw new Error(
          `Plugin "${plugin.name}" declares an embedder but no disableCommand. ` +
            `Cannot persist "no" answer — refusing to install in an inconsistent state.`,
        )
      }
      for (const cmd of emb.disableCommand) {
        const res = await runPluginCli(plugin, cmd)
        if (res.code !== 0) {
          throw new Error(
            `Failed to persist "no" answer for ${plugin.name}'s embedder:\n` +
              `  command: bun <cli> ${cmd}\n` +
              `  ${(res.stderr || res.stdout).trim() || "(no output)"}`,
          )
        }
      }
      return `declined (embedder_mode=hash; ${emb.name} will never download)`
    }
    // User accepted. Persist.
  }

  // Yes path: persist embedder_mode=minilm.
  if (!emb.preInstall || emb.preInstall.length === 0) {
    throw new Error(
      `Plugin "${plugin.name}" declares an embedder but no preInstall commands. ` +
        `Cannot persist "yes" answer — refusing to install in an inconsistent state.`,
    )
  }
  for (const cmd of emb.preInstall) {
    const res = await runPluginCli(plugin, cmd)
    if (res.code !== 0) {
      const tail = (res.stderr || res.stdout).trim() || "(no output)"
      throw new Error(
        `Failed to persist "yes" answer for ${plugin.name}'s embedder:\n` +
          `  command: bun <cli> ${cmd}\n` +
          `  ${tail}`,
      )
    }
  }
  return `accepted (embedder_mode=minilm; ${emb.name} will download on first memory call)`
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
  const loginRes =
    typeof login === "string"
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
  for (const attempt of [
    auth.verify,
    ...regions.map((r) => `mmx config set --key region --value ${r} && ${auth.verify}`),
  ]) {
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
  if (plugin.contract.claudeMcp) {
    const src = join(plugin.packageDir, plugin.contract.claudeMcp)
    if (!existsSync(src)) {
      throw new Error(
        `Claude MCP bundle missing: ${src}\n` + `Run \`bun run build\` inside the plugin package first.`,
      )
    }
    // Ship the bundle under <HMANLAB_HOME>/plugins/<plugin>/ so it
    // survives the source package being moved/renamed, and Claude Code
    // launches the same path on every machine.
    const dest = join(hmanlabPluginDir(plugin.name), basename(plugin.contract.claudeMcp))
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(src, dest)
    copied.push(tilde(dest))
  }
  if (plugin.contract.cli) {
    // Ship the CLI bundle alongside the MCP bundle so install-time prompts
    // (e.g. embedder install/disable) can invoke plugin subcommands by
    // absolute path without depending on PATH or a global install.
    const src = join(plugin.packageDir, plugin.contract.cli)
    if (!existsSync(src)) {
      throw new Error(`Plugin CLI bundle missing: ${src}\n` + `Run \`bun run build\` inside the plugin package first.`)
    }
    const dest = join(hmanlabPluginDir(plugin.name), basename(plugin.contract.cli))
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(src, dest)
    copied.push(tilde(dest))
  }
  if (plugin.contract.claudeSkill) {
    const src = join(plugin.packageDir, plugin.contract.claudeSkill)
    if (!existsSync(src)) {
      throw new Error(`Claude skill source missing: ${src}`)
    }
    // Claude Code scans ~/.claude/skills/<plugin>/SKILL.md, so the
    // destination filename is always SKILL.md.
    const dest = join(claudeSkillDir(plugin.name), "SKILL.md")
    if (statSync(src).isDirectory()) {
      // Mirror the dir under ~/.claude/skills/<plugin>/ (Claude scans
      // subfolders for ancillary files too).
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

/**
 * One-time migration from the legacy `~/.local/share/hl-plugins/<plugin>/`
 * (or `%LOCALAPPDATA%\hl-plugins\<plugin>\` on Windows) layout to the new
 * `<HMANLAB_HOME>/plugins/<plugin>/` home. Pure fs ops, no UI — exported
 * for unit testing.
 *
 * - If `legacy` is null or doesn't exist → no-op (returns empty lists).
 * - For each `<plugin>` subdir: rename to `<dest>/<plugin>/` if the
 *   destination is empty, else copy contents via `copy` and remove the source.
 * - If the legacy dir is empty after the move, remove it.
 * - Foreign files inside the legacy dir get a warning, not a deletion.
 *
 * Idempotent: a second call is a no-op because the legacy dir is gone.
 */
export function migrateLegacyBundles(
  legacy: string | null,
  dest: string,
  copy: (src: string, dst: string) => Promise<void> = copyDir,
): { moved: string[]; warnings: string[]; cleanedLegacy: boolean } {
  const moved: string[] = []
  const warnings: string[] = []
  if (!legacy || !existsSync(legacy)) return { moved, warnings, cleanedLegacy: false }
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(legacy)) {
    const srcPlugin = join(legacy, entry)
    if (!statSync(srcPlugin).isDirectory()) {
      warnings.push(`legacy plugin dir contains unexpected file ${srcPlugin}; leaving it in place`)
      continue
    }
    const dstPlugin = join(dest, entry)
    if (!existsSync(dstPlugin)) {
      renameSync(srcPlugin, dstPlugin)
    } else {
      // Destination already populated (likely a partial earlier install).
      // The install step that follows re-copies bundles anyway, so a
      // straight copy is fine here.
      void copy(srcPlugin, dstPlugin)
      for (const f of readdirSync(srcPlugin)) {
        unlinkSync(join(srcPlugin, f))
      }
      rmdirSync(srcPlugin)
    }
    moved.push(`${srcPlugin} → ${dstPlugin}`)
  }
  let cleanedLegacy = false
  if (readdirSync(legacy).length === 0) {
    rmdirSync(legacy)
    cleanedLegacy = true
  }
  return { moved, warnings, cleanedLegacy }
}

/** Convenience wrapper for the install command — resolves paths and
 *  formats the result for the UI. */
async function runLegacyMigration(): Promise<string[]> {
  const legacy = legacyHlPluginsDataDir()
  const dest = hmanlabPluginsDir()
  const { moved, warnings } = migrateLegacyBundles(legacy, dest)
  for (const w of warnings) ui.warn(w)
  return moved.map((m) => {
    const [src, dst] = m.split(" → ")
    return `${tilde(src ?? "")} → ${tilde(dst ?? "")}`
  })
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
  if (plugin.contract.claudeMcp) {
    const bundlePath = join(hmanlabPluginDir(plugin.name), basename(plugin.contract.claudeMcp))
    // The MCP server is built --target=bun, so we launch it with bun.
    // The bun binary is a hard requirement of this plugin (declared in
    // requires[]) so it will be on PATH by the time we get here.
    const spec: McpServerSpec = { command: "bun", args: [bundlePath] }
    if (addMcpServer(plugin.name, spec)) {
      changes.push(`added mcpServers.${plugin.name} → bun ${bundlePath}`)
    } else {
      changes.push(`mcpServers.${plugin.name} already registered`)
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
      throw new Error(`Verification failed: ${cmd}\n` + `  ${text || "(no output)"}`)
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

async function installOne(
  plugin: PluginManifest,
  opts: InstallOpts,
  step: number,
  total: number,
): Promise<void> {
  ui.info(ui.bold(`\n[${step}/${total}] ${plugin.name} -- ${plugin.description}`))

  await ui.spinner("Pre-flight checks", async () => {
    await checkPreflight()
  })

  // One-time move from the legacy `~/.local/share/hl-plugins/` layout.
  // Runs before any file ops so the rest of the install sees a clean state.
  // First plugin in the batch does the move; subsequent ones are no-ops.
  const migrated = await ui.spinner("Migrate legacy bundles", () => runLegacyMigration())
  for (const line of migrated) ui.info(`    ${ui.dim("→")} ${line}`)

  for (const req of plugin.contract.requires ?? []) {
    const note = await ui.spinner(`Requirement: ${req.name}`, () => ensureRequirement(req))
    if (note) ui.info(`    ${ui.dim(note)}`)
  }

  // If the plugin declares an embedder, the CLI bundle must be on disk
  // BEFORE we ask the user — the prompt invokes plugin subcommands via the
  // copied bundle. Copy just the CLI bundle here; the rest of the files
  // (MCP bundle, skill) come in the normal "Copy files" step below.
  if (plugin.contract.embedder && plugin.contract.cli) {
    await ui.spinner("Stage plugin CLI for embedder prompt", () => copyCliBundle(plugin))
  }

  if (plugin.contract.embedder) {
    ui.info("")
    const note = await promptEmbedder(plugin)
    if (note) ui.info(`    ${ui.dim("→")} ${ui.dim(note)}`)
  }

  const auth = plugin.contract.auth
  if (auth) {
    const note = await ui.spinner(`Authenticate: ${auth.keyLabel}`, () => authenticate(plugin, opts))
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

/** Copy only the plugin's CLI bundle (not the MCP bundle or skill).
 *  Called early so embedder prompts can invoke plugin subcommands. */
async function copyCliBundle(plugin: PluginManifest): Promise<void> {
  if (!plugin.contract.cli) return
  const src = join(plugin.packageDir, plugin.contract.cli)
  if (!existsSync(src)) {
    throw new Error(`Plugin CLI bundle missing: ${src}\n` + `Run \`bun run build\` inside the plugin package first.`)
  }
  const dest = join(hmanlabPluginDir(plugin.name), basename(plugin.contract.cli))
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(src, dest)
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
  return {
    names,
    skipAuth,
    key,
    verbose: args.includes("--verbose") || args.includes("-v") || process.env["HL_PLUGINS_DEBUG"] === "1",
  }
}

export async function install(args: string[]): Promise<number> {
  const opts = parseArgs(args)
  const targets =
    opts.names.length > 0
      ? await Promise.all(opts.names.map((n) => ensurePluginAvailable(n)))
      : defaultInstallPlugins()
  if (targets.length === 0) {
    ui.warn("No plugins to install (none marked defaultInstall in this monorepo).")
    return 0
  }

  // Install hint: detect Claude Code systems that lack OpenCode. The
  // user almost certainly wants mmx-claude, not mmx.
  if (existsSync(claudeConfigDir()) && !existsSync(opencodeConfigDir())) {
    const wantsMmx = targets.some((p) => p.name === "mmx")
    if (wantsMmx) {
      ui.info(
        ui.yellow(
          "Heads up: ~/.claude/ is present but ~/.opencode/ is not — looks like a Claude Code system. " +
            "Did you mean `hl-plugins install mmx-claude` instead? " +
            "Proceeding with the OpenCode install anyway.",
        ),
      )
    }
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
