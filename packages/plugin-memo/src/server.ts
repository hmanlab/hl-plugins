// hmanlab-memo MCP server entry point.
//
// Phase 04 wires:
//   - cwd auto-detect middleware (opt-in via config.yaml cwd_auto_detect).
//   - SessionManager (start/end/list tools).
//   - session-aware project_switch return shape (bundle fields added).
//
// All logging goes to stderr — stdout is reserved for MCP JSON-RPC frames.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod/v3"

import { ensureHome, hmanlabHome, personasDirPath, projectsDirPath, readConfig } from "./config.js"
import { installShutdownHooks, openRootDb } from "./db.js"
import { extractStarterPack, setBuiltins, syncFromDisk } from "./persona/registry.js"
import { ProjectSwitcher } from "./project/switcher.js"
import { projectList } from "./project/registry.js"
import { SessionManager } from "./sessions/manager.js"
import { currentCwd, matchProjectByCwd } from "./cwd.js"
import { registerPersonaTools } from "./tools/persona-tools.js"
import { registerProjectTools } from "./tools/project-tools.js"
import { registerMemoryTools } from "./tools/memory-tools.js"
import { registerSessionTools } from "./tools/session-tools.js"

import defaultYaml from "./persona/builtin/default.yaml" with { type: "text" }
import workYaml from "./persona/builtin/work.yaml" with { type: "text" }
import creativeYaml from "./persona/builtin/creative.yaml" with { type: "text" }

/** Cheap best-effort auto-switch. Called at the top of any tool handler that
 *  cares about the active project. Skipped if cwd_auto_detect is off, no
 *  registered project matches cwd, or the match is already the active one. */
export function maybeAutoSwitch(switcher: ProjectSwitcher, rootDb: import("bun:sqlite").Database): void {
  const cfg = readConfig()
  if (!cfg.cwd_auto_detect) return
  const cwd = currentCwd()
  const projects = projectList(rootDb, { includeArchived: true })
  const match = matchProjectByCwd(cwd, projects)
  if (!match) return
  if (switcher.getActive()?.name === match.name) return
  try {
    switcher.switchTo(match.name)
    process.stderr.write(`[hmanlab-memo] auto-switched to ${match.name} (cwd: ${cwd})\n`)
  } catch (err) {
    process.stderr.write(`[hmanlab-memo] auto-switch failed: ${(err as Error).message}\n`)
  }
}

async function main(): Promise<void> {
  process.stderr.write(`[hmanlab-memo] booting (home=${hmanlabHome()})\n`)

  setBuiltins({ default: defaultYaml, work: workYaml, creative: creativeYaml })
  ensureHome()

  const db = openRootDb()
  installShutdownHooks(db)

  const extracted = extractStarterPack(personasDirPath())
  if (extracted.length > 0) {
    process.stderr.write(`[hmanlab-memo] extracted starter personas: ${extracted.join(", ")}\n`)
  }

  const summary = syncFromDisk(db, personasDirPath())
  process.stderr.write(
    `[hmanlab-memo] synced ${summary.upserted.length} personas` +
      (Object.keys(summary.load_errors).length > 0
        ? `, ${Object.keys(summary.load_errors).length} parse errors`
        : "") +
      "\n",
  )

  const switcher = new ProjectSwitcher(db, () => projectsDirPath())
  const restored = switcher.restore()
  if (restored) {
    process.stderr.write(`[hmanlab-memo] restored active project: ${restored.name}\n`)
  }

  // Auto-switch on boot if cwd matches a registered project (per PRD §11 —
  // "on every MCP call", and the first MCP call after boot is a fair trigger).
  maybeAutoSwitch(switcher, db)

  const sessions = new SessionManager(db, switcher, () => projectsDirPath())

  const server = new McpServer({ name: "hmanlab-memo", version: "0.4.5" })
  registerPersonaTools(server, db, () => personasDirPath())
  registerProjectTools(server, db, switcher, () => projectsDirPath(), sessions)
  registerMemoryTools(server, db, switcher, () => projectsDirPath())
  registerSessionTools(server, sessions)

  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write("[hmanlab-memo] server ready on stdio\n")
}

main().catch((err) => {
  process.stderr.write(`[hmanlab-memo] fatal: ${(err as Error).message}\n`)
  process.stderr.write((err as Error).stack ?? "")
  process.exit(1)
})

void z
