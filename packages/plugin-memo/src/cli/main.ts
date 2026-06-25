// hmanlab-memory CLI.
//
// Wraps the same backend functions the MCP tools use. No logic duplication —
// every command eventually calls into src/* (persona/registry, project/registry,
// memory/crud, memory/search, etc.) and serializes the result.
//
// Output:
//   - "list" / "status" commands → pretty tables via the built-in `formatTable`
//   - "search" / "hygiene" / "config get" → JSON (pipeable to jq)
//   - everything else → plain text

import { Command } from "commander"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import {
  ensureHome,
  hmanlabHome,
  personasDirPath,
  projectsDirPath,
  readConfig,
  writeConfig,
} from "../config.js"
import { openRootDb } from "../db.js"
import {
  setBuiltins,
  extractStarterPack,
  syncFromDisk,
  createPersona,
  deletePersona,
  clonePersona,
  updatePersona,
} from "../persona/registry.js"
import { projectArchive, projectList, projectRegister } from "../project/registry.js"
import { ProjectSwitcher } from "../project/switcher.js"
import { projectExport } from "../export-import/exporter.js"
import { projectImport } from "../export-import/importer.js"
import { memorySave } from "../memory/crud.js"
import { memorySearch, memoryRecent } from "../memory/search.js"
import { buildHygieneReport } from "../memory/hygiene.js"
import type { Database } from "bun:sqlite"

// ─── helpers ──────────────────────────────────────────────────────────

function table(rows: Array<Record<string, unknown>>, columns: string[]): string {
  if (rows.length === 0) return "(no rows)"
  const widths = columns.map((c: string) =>
    Math.max(c.length, ...rows.map((r: Record<string, unknown>) => String(r[c] ?? "").length)),
  )
  const fmt = (vals: string[]) => vals.map((v: string, i: number) => v.padEnd(widths[i]!)).join("  ")
  const lines: string[] = []
  lines.push(fmt(columns))
  lines.push(widths.map((w: number) => "-".repeat(w)).join("  "))
  for (const r of rows) lines.push(fmt(columns.map((c: string) => String(r[c] ?? ""))))
  return lines.join("\n")
}

function json(v: unknown): string {
  return JSON.stringify(v, null, 2)
}

/** AI personas from ai_personas table. Includes the joined YAML fields. */
function listAiPersonas(db: Database) {
  return db
    .prepare(
      "SELECT name, version, description, voice, traits, system_prompt, parent, is_builtin, is_archived FROM ai_personas ORDER BY name",
    )
    .all() as Array<{
    name: string
    version: number
    description: string
    voice: string
    traits: string
    system_prompt: string
    parent: string | null
    is_builtin: number
    is_archived: number
  }>
}

/** Read a single persona row. Returns null if not found. */
function getPersona(db: Database, name: string) {
  const row = db
    .prepare(
      "SELECT name, version, description, voice, traits, system_prompt, parent, is_builtin, is_archived FROM ai_personas WHERE name = ?",
    )
    .get(name) as
    | {
        name: string
        version: number
        description: string
        voice: string
        traits: string
        system_prompt: string
        parent: string | null
        is_builtin: number
        is_archived: number
      }
    | undefined
  return row ?? null
}

/** Load + resolve a persona's YAML from disk. */
function loadPersona(name: string) {
  const path = join(personasDirPath(), `${name}.yaml`)
  if (!existsSync(path)) return null
  // The loader in persona/loader.ts handles parsing + parent resolution.
  // We keep it as a thin wrapper here to avoid coupling CLI to internals.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { loadPersonaFromFile, resolveChain } = require("../persona/loader.js") as {
    loadPersonaFromFile: (p: string) => unknown
    resolveChain: (name: string, byName: Map<string, unknown>) => unknown
  }
  const p = loadPersonaFromFile(path)
  return p
}

// ─── build the program ────────────────────────────────────────────────

const program = new Command()
program
  .name("hmanlab-memory")
  .description("Local-first MCP memory server with personas, projects, decay, and conflict detection.")
  .version("0.5.1")

// init
program
  .command("init")
  .description("First-time setup. Idempotent.")
  .action(async () => {
    ensureHome()
    // Seed built-in personas (idempotent).
    setBuiltins({
      default: `name: default\nversion: 1\ndescription: Warm, balanced, concise.\nvoice: friendly\ntraits: [clear, concise]\nsystem_prompt: |\n  Default persona.\n`,
      work: `name: work\nversion: 1\ndescription: Terse, technical.\nvoice: terse\nparent: default\ntraits: [terse]\nsystem_prompt: |\n  Work persona.\n`,
      creative: `name: creative\nversion: 1\ndescription: Expansive.\nvoice: playful\nparent: default\ntraits: [playful]\nsystem_prompt: |\n  Creative persona.\n`,
    })
    const db = openRootDb()
    extractStarterPack(personasDirPath())
    syncFromDisk(db, personasDirPath())
    db.close()
    console.log(`✓ hmanlab-memory initialized at ${hmanlabHome()}`)
    console.log(`Next: register projects with: hmanlab-memory project register <path> <name>`)
  })

// start (alias for the MCP server)
program
  .command("start")
  .description("Run the MCP server (same binary as claude mcp add launches).")
  .action(async () => {
    const { spawn } = await import("node:child_process")
    const proc = spawn(process.execPath, [join(import.meta.dirname, "..", "dist", "memo-mcp-server.js")], {
      stdio: "inherit",
    })
    proc.on("exit", (code) => process.exit(code ?? 0))
  })

// persona
const personaCmd = program.command("persona").description("Manage AI personas.")
personaCmd
  .command("list")
  .description("List all personas (built-in + user).")
  .action(() => {
    const db = openRootDb()
    try {
      const rows = listAiPersonas(db)
      console.log(
        table(
          rows.map((r) => ({
            name: r.name,
            version: r.version,
            is_builtin: r.is_builtin,
            is_archived: r.is_archived,
          })),
          ["name", "version", "is_builtin", "is_archived"],
        ),
      )
    } finally {
      db.close()
    }
  })
personaCmd
  .command("get <name>")
  .description("Show a persona's resolved YAML.")
  .action((name: string) => {
    const db = openRootDb()
    try {
      const p = getPersona(db, name)
      if (!p) {
        console.error(`Persona "${name}" not found.`)
        process.exit(1)
      }
      console.log(json(p))
    } finally {
      db.close()
    }
  })
personaCmd
  .command("new <name>")
  .description("Create a new persona. Opens $EDITOR on a template.")
  .action((name: string) => {
    const template = `name: ${name}\nversion: 1\ndescription: \nvoice: \ntraits: []\nsystem_prompt: |\n  You are a helpful assistant named ${name}.\n`
    const path = join(personasDirPath(), `${name}.yaml`)
    if (existsSync(path)) {
      console.error(`Persona YAML already exists at ${path}`)
      process.exit(1)
    }
    writeFileSync(path, template, "utf8")
    const editor = process.env["EDITOR"] ?? "vi"
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process")
    spawnSync(editor, [path], { stdio: "inherit" })
  })
personaCmd
  .command("clone <source> <new>")
  .description("Clone an existing persona to a new name.")
  .action((source: string, newName: string) => {
    const db = openRootDb()
    try {
      clonePersona(db, personasDirPath(), source, newName)
      console.log(`Cloned ${source} → ${newName}`)
    } catch (err) {
      console.error((err as Error).message)
      process.exit(1)
    } finally {
      db.close()
    }
  })
personaCmd
  .command("delete <name>")
  .description("Soft-delete (archive) a persona.")
  .action((name: string) => {
    const db = openRootDb()
    try {
      deletePersona(db, name)
      console.log(`Archived persona ${name}`)
    } finally {
      db.close()
    }
  })
personaCmd
  .command("reset-builtins")
  .description("Restore the 3 built-in personas. Re-extracts if missing.")
  .action(() => {
    ensureHome()
    setBuiltins({
      default: `name: default\nversion: 1\ndescription: Warm, balanced, concise.\nvoice: friendly\ntraits: [clear, concise]\nsystem_prompt: |\n  Default persona.\n`,
      work: `name: work\nversion: 1\ndescription: Terse, technical.\nvoice: terse\nparent: default\ntraits: [terse]\nsystem_prompt: |\n  Work persona.\n`,
      creative: `name: creative\nversion: 1\ndescription: Expansive.\nvoice: playful\nparent: default\ntraits: [playful]\nsystem_prompt: |\n  Creative persona.\n`,
    })
    const extracted = extractStarterPack(personasDirPath())
    const db = openRootDb()
    try {
      syncFromDisk(db, personasDirPath())
    } finally {
      db.close()
    }
    console.log(`Restored: ${extracted.join(", ") || "(all present)"}`)
  })

// project
const projectCmd = program.command("project").description("Manage projects.")
projectCmd
  .command("list")
  .description("List registered projects.")
  .option("--archived", "Include archived projects.")
  .action((opts: { archived?: boolean }) => {
    const db = openRootDb()
    try {
      const rows = projectList(db, { includeArchived: !!opts.archived })
      console.log(
        table(
          rows.map((r) => ({
            name: r.name,
            path: r.path,
            is_archived: r.is_archived,
            last_opened_at: r.last_opened_at ?? "",
          })),
          ["name", "path", "is_archived", "last_opened_at"],
        ),
      )
    } finally {
      db.close()
    }
  })
projectCmd
  .command("register <path> <name>")
  .description("Register a project at <path> with <name>.")
  .action((path: string, name: string) => {
    if (!existsSync(path)) {
      console.error(`Path "${path}" does not exist.`)
      process.exit(1)
    }
    const db = openRootDb()
    try {
      projectRegister(db, projectsDirPath(), { name, path })
      console.log(`Registered ${name} at ${path}`)
    } catch (err) {
      console.error((err as Error).message)
      process.exit(1)
    } finally {
      db.close()
    }
  })
projectCmd
  .command("switch <name>")
  .description("Make <name> the active project.")
  .action((name: string) => {
    const db = openRootDb()
    try {
      const switcher = new ProjectSwitcher(db, () => projectsDirPath())
      switcher.switchTo(name)
      writeConfig({ active_project: name })
      console.log(`Switched to ${name}`)
    } catch (err) {
      console.error((err as Error).message)
      process.exit(1)
    } finally {
      db.close()
    }
  })
projectCmd
  .command("archive <name>")
  .description("Soft-archive a project.")
  .action((name: string) => {
    const db = openRootDb()
    try {
      projectArchive(db, name)
      console.log(`Archived ${name}`)
    } finally {
      db.close()
    }
  })
projectCmd
  .command("export <name> [out_path]")
  .description("Export <name> to a zip (project.yaml + hmanlab.db + manifest.json).")
  .action(async (name: string, outPath?: string) => {
    try {
      const result = await projectExport({ name, outputPath: outPath })
      console.log(`Exported to ${result.path} (${result.sizeBytes} bytes, ${result.memoryCount} memories)`)
    } catch (err) {
      console.error((err as Error).message)
      process.exit(1)
    }
  })
projectCmd
  .command("import <archive> [name]")
  .description("Import a project from a zip.")
  .action(async (archive: string, name?: string) => {
    try {
      const result = await projectImport({ archivePath: archive, name })
      console.log(`Imported ${result.name} (${result.memoryCount} memories)`)
    } catch (err) {
      console.error((err as Error).message)
      process.exit(1)
    }
  })

// memory
const memoryCmd = program.command("memory").description("Memory operations.")
memoryCmd
  .command("search <query>")
  .description("Hybrid search (FTS + vector + recency). Outputs JSON.")
  .option("--project <name>", "Active project (uses config's active_project if omitted)")
  .option("--scope <scope>", "all | project | global", "all")
  .option("--limit <n>", "Max results", "10")
  .action(async (query: string, opts: { project?: string; scope?: string; limit?: string }) => {
    const scope = (opts.scope ?? "all") as "all" | "project" | "global"
    const limit = parseInt(opts.limit ?? "10", 10)
    const db = openRootDb()
    try {
      let projectDb: import("bun:sqlite").Database | undefined
      let projectName: string | null = null
      if (scope === "all" || scope === "project") {
        const cfg = readConfig()
        const name = opts.project ?? cfg.active_project ?? null
        if (name) {
          const { openProjectDb } = await import("../db.js")
          const { projectDbPath } = await import("../project/registry.js")
          projectDb = openProjectDb(projectDbPath(projectsDirPath(), name))
          projectName = name
        }
      }
      try {
        const result = memorySearch(db, {
          query,
          scope,
          limit,
          projectDb,
          projectName,
        })
        console.log(json(result))
      } finally {
        if (projectDb) projectDb.close()
      }
    } finally {
      db.close()
    }
  })
memoryCmd
  .command("recent")
  .description("Recent memories (created_at DESC). Outputs JSON.")
  .option("--project <name>", "Active project")
  .option("--scope <scope>", "all | project | global", "all")
  .option("--limit <n>", "Max results", "10")
  .action((opts: { project?: string; scope?: string; limit?: string }) => {
    const scope = (opts.scope ?? "all") as "all" | "project" | "global"
    const limit = parseInt(opts.limit ?? "10", 10)
    const db = openRootDb()
    try {
      console.log(json(memoryRecent(db, { scope, limit })))
    } finally {
      db.close()
    }
  })
memoryCmd
  .command("save <content>")
  .description("Save a memory.")
  .option("--category <c>", "Category")
  .option("--importance <n>", "0..1", "0.5")
  .option("--scope <s>", "project | global", "project")
  .action(async (content: string, opts: { category?: string; importance?: string; scope?: string }) => {
    const scope = (opts.scope ?? "project") as "project" | "global"
    const importance = parseFloat(opts.importance ?? "0.5")
    const cfg = readConfig()
    if (scope === "project") {
      if (!cfg.active_project) {
        console.error("no active project — run: hmanlab-memory project switch <name>")
        process.exit(1)
      }
      const { openProjectDb } = await import("../db.js")
      const { projectDbPath } = await import("../project/registry.js")
      const db = openProjectDb(projectDbPath(projectsDirPath(), cfg.active_project))
      try {
        const result = await memorySave(db, {
          content,
          category: opts.category ?? null,
          importance,
          scope,
          project_id: cfg.active_project,
        })
        console.log(json(result))
      } finally {
        db.close()
      }
    } else {
      const db = openRootDb()
      try {
        const result = await memorySave(db, {
          content,
          category: opts.category ?? null,
          importance,
          scope: "global",
        })
        console.log(json(result))
      } finally {
        db.close()
      }
    }
  })
memoryCmd
  .command("hygiene [scope]")
  .description("Memory hygiene report. Outputs JSON.")
  .action((scopeArg?: string) => {
    const scope = (scopeArg ?? "project") as "all" | "project" | "global"
    const db = openRootDb()
    try {
      buildHygieneReport({ rootDb: db, scope }).then((r) => console.log(json(r)))
    } finally {
      db.close()
    }
  })

// status
program
  .command("status")
  .description("Show install state, active project, persona, embedder.")
  .action(() => {
    const db = openRootDb()
    try {
      const cfg = readConfig()
      const active = cfg.active_project ?? "(none)"
      const personas = listAiPersonas(db)
      const projects = projectList(db)
      console.log(`hmanlab-memory v0.5.1`)
      console.log(`  Root DB:    ${hmanlabHome()}/root.db`)
      console.log(
        `  Personas:   ${personas.length} (${personas.filter((p) => p.is_builtin).length} built-in)`,
      )
      console.log(`  Projects:   ${projects.length}`)
      console.log(`  Active:     ${active}`)
      console.log(`  cwd_auto:   ${cfg.cwd_auto_detect ? "enabled" : "disabled"}`)
      console.log(`  Persona filter: ${cfg.persona_filter_mode ?? "inclusive"}`)
      console.log(`  Embedder mode: ${cfg.embedder_mode ?? "auto"} (model: ${cfg.embedding_model})`)
    } finally {
      db.close()
    }
  })

// embedder — toggle the optional MiniLM model on/off.
//
// `install` writes `embedder_mode: minilm`. The actual model download
// happens lazily on the first MCP-server `memory_save`/`memory_search`
// call (~25 MB, ~2 s warmup, then ~50 ms/query). We can't reliably force
// an eager download here: shipping the native onnxruntime-node binary
// (~210 MB) with the install is impractical, and the bundled CLI doesn't
// have a path to trigger loading from its copied location.
//
// What `hl-plugins install memo` is doing is asking the user to commit at
// install time. After Yes, the choice is locked in via the config flag —
// the very next memory call will download. After No, the flag is "hash"
// and the embedder short-circuits without ever touching the model.
const embedderCmd = program.command("embedder").description("Manage the optional MiniLM embedder.")
embedderCmd
  .command("install")
  .description("Enable MiniLM. Persists embedder_mode=minilm; model downloads on first memory call.")
  .action(() => {
    ensureHome()
    writeConfig({ embedder_mode: "minilm" })
    console.log("✓ embedder_mode set to minilm. MiniLM will download on first memory call (~2s warmup).")
  })
embedderCmd
  .command("disable")
  .description("Use the hash fallback. Skips the model download entirely.")
  .action(() => {
    ensureHome()
    writeConfig({ embedder_mode: "hash" })
    console.log("✓ Embedder set to hash fallback. MiniLM will never download.")
  })
embedderCmd
  .command("status")
  .description("Show which embedder mode is active.")
  .action(() => {
    const cfg = readConfig()
    console.log(`embedder_mode: ${cfg.embedder_mode ?? "auto"}`)
    console.log(`embedding_model: ${cfg.embedding_model}`)
  })

// config
const configCmd = program.command("config").description("Config read/write.")
configCmd
  .command("show")
  .description("Print all config keys.")
  .action(() => {
    console.log(json(readConfig()))
  })
configCmd
  .command("get <key>")
  .description("Read a single config key.")
  .action((key: string) => {
    const cfg = readConfig() as Record<string, unknown>
    console.log(JSON.stringify(cfg[key] ?? null))
  })
configCmd
  .command("set <key> <value>")
  .description("Write a config key (string, number, or true/false).")
  .action((key: string, value: string) => {
    let parsed: unknown = value
    if (value === "true") parsed = true
    else if (value === "false") parsed = false
    else if (/^-?\d+(\.\d+)?$/.test(value)) parsed = Number(value)
    writeConfig({ [key]: parsed } as Record<string, unknown>)
    console.log(`Set ${key} = ${JSON.stringify(parsed)}`)
  })

// mcp-config
const mcpCmd = program.command("mcp-config").description("Print MCP client config snippets.")
mcpCmd
  .command("claude-code")
  .description("Print the claude mcp add command.")
  .action(() => {
    console.log(`claude mcp add hmanlab-memory -- ${homedir()}/.local/bin/hmanlab-memory start`)
    console.log(`# or for local dev:`)
    console.log(
      `claude mcp add hmanlab-memory -s user -- bun ${join(import.meta.dirname, "..", "bin", "hmanlab-memory.js")} start`,
    )
  })
mcpCmd
  .command("cursor")
  .description("Print Cursor mcp.json snippet.")
  .action(() => {
    console.log(
      json({
        mcpServers: {
          "hmanlab-memory": {
            command: "hmanlab-memory",
            args: ["start"],
          },
        },
      }),
    )
  })

export function run(argv: string[]): void {
  program.parse(argv)
  // commander handles argv; if no subcommand matches, help is printed.
}

// Auto-run when invoked directly (e.g. `bun dist/cli.js embedder install`).
// Skip when imported as a library (e.g. by tests or the bin shim).
if (import.meta.main) {
  run(process.argv)
}
