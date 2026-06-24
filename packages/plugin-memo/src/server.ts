// hmanlab-memo MCP server entry point.
//
// Boots an MCP server over stdio, registers the 9 phase-01 tools, and exits
// cleanly on SIGTERM/SIGINT. The root DB is opened, the persona starter pack
// is extracted (idempotent — never overwrites user-edited YAMLs), and the DB
// is resynced from disk before the first tool call can land.
//
// Built with:  bun build ./src/server.ts --target=bun
//                   --outfile=./dist/memo-mcp-server.js
//
// All logging goes to stderr — stdout is reserved for MCP JSON-RPC frames.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
// Import from `zod/v3` so the type identity matches the SDK's internal
// zod-compat (same trick used in packages/plugin-mmx-claude/claude/mcp/mmx-mcp-server.ts).
import { z } from "zod/v3"

import { ensureHome, hmanlabHome, personasDirPath } from "./config.js"
import { installShutdownHooks, openRootDb } from "./db.js"
import { extractStarterPack, setBuiltins, syncFromDisk } from "./persona/registry.js"
import { registerPersonaTools } from "./tools/persona-tools.js"

// Bundled YAML assets. `with { type: "text" }` instructs Bun's bundler to
// inline the file content as a string literal at build time.
import defaultYaml from "./persona/builtin/default.yaml" with { type: "text" }
import workYaml from "./persona/builtin/work.yaml" with { type: "text" }
import creativeYaml from "./persona/builtin/creative.yaml" with { type: "text" }

async function main(): Promise<void> {
  process.stderr.write(`[hmanlab-memo] booting (home=${hmanlabHome()})\n`)

  // 1) Wire bundled YAML into the registry before any DB op reads it.
  setBuiltins({ default: defaultYaml, work: workYaml, creative: creativeYaml })

  // 2) Make sure ~/.hmanlab/ and config.yaml exist; create personas/ subdir.
  ensureHome()

  // 3) Open root DB (WAL + schema bootstrap). Assert WAL is active.
  const db = openRootDb()
  installShutdownHooks(db)

  // 4) Extract the starter pack (no-op if YAMLs already exist).
  const extracted = extractStarterPack(personasDirPath())
  if (extracted.length > 0) {
    process.stderr.write(`[hmanlab-memo] extracted starter personas: ${extracted.join(", ")}\n`)
  }

  // 5) Resync DB from disk so any YAML edits since last boot are reflected.
  const summary = syncFromDisk(db, personasDirPath())
  process.stderr.write(
    `[hmanlab-memo] synced ${summary.upserted.length} personas` +
      (Object.keys(summary.load_errors).length > 0
        ? `, ${Object.keys(summary.load_errors).length} parse errors`
        : "") +
      "\n",
  )

  // 6) Build MCP server and register tools.
  const server = new McpServer({ name: "hmanlab-memo", version: "0.4.5" })
  registerPersonaTools(server, db, () => personasDirPath())

  // 7) Connect stdio transport and wait for the client to close us.
  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write("[hmanlab-memo] server ready on stdio\n")
}

main().catch((err) => {
  process.stderr.write(`[hmanlab-memo] fatal: ${(err as Error).message}\n`)
  process.stderr.write((err as Error).stack ?? "")
  process.exit(1)
})

// Suppress the unused-z import lint: z is imported for type parity with the
// rest of the file (consistent with the SDK's AnySchema = z3.ZodTypeAny).
void z
