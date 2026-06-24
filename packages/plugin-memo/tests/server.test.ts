// MCP server smoke test.
//
// Spawns the built MCP bundle (dist/memo-mcp-server.js) over stdio, runs the
// JSON-RPC `initialize` + `notifications/initialized` + `tools/list` handshake,
// and asserts that exactly the expected tools (Phases 01-04) are registered.
//
// Prereq: run `bun run --filter @hmanlab/memo build` first.

import { describe, it, expect, beforeAll } from "bun:test"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(HERE, "..", "dist", "memo-mcp-server.js")

const EXPECTED_TOOLS = [
  "persona_list",
  "persona_get",
  "persona_create",
  "persona_update",
  "persona_delete",
  "persona_clone",
  "persona_reload",
  "user_persona_get",
  "user_persona_update",
  "project_register",
  "project_list",
  "project_get",
  "project_switch",
  "get_active_project",
  "project_archive",
  "project_unregister",
  "memory_save",
  "memory_get",
  "memory_update",
  "memory_delete",
  "memory_search",
  "memory_semantic_search",
  "memory_recent",
  "session_start",
  "session_end",
  "session_list",
]

interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: number
  result?: unknown
  error?: { code: number; message: string }
}

async function handshakeWithBundle(): Promise<string[]> {
  if (!existsSync(BUNDLE)) {
    throw new Error(`Bundle not found at ${BUNDLE}. Run \`bun run build\` first.`)
  }

  const child = spawn("bun", [BUNDLE], { stdio: ["pipe", "pipe", "pipe"] })

  const responses: JsonRpcResponse[] = []
  let buffer = ""
  let resolveList: ((tools: string[]) => void) | null = null
  let rejectList: ((err: Error) => void) | null = null
  const listPromise = new Promise<string[]>((resolve, reject) => {
    resolveList = resolve
    rejectList = reject
  })

  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk
    let nl: number
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      try {
        responses.push(JSON.parse(line) as JsonRpcResponse)
      } catch {
        // not JSON — skip
      }
    }
  })

  let stderrTail = ""
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    stderrTail += chunk
    if (stderrTail.length > 2000) stderrTail = stderrTail.slice(-2000)
  })

  child.on("exit", (code) => {
    if (resolveList === null) return
    if (code !== 0 && code !== null) {
      rejectList?.(new Error(`MCP server exited with code ${code} before responding\nstderr: ${stderrTail}`))
    }
  })

  function send(msg: object) {
    child.stdin.write(JSON.stringify(msg) + "\n")
  }

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "memo-smoke-test", version: "0.0.0" },
    },
  })
  send({ jsonrpc: "2.0", method: "notifications/initialized" })
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" })

  const start = Date.now()
  while (Date.now() - start < 5_000) {
    const match = responses.find((r) => r.id === 2)
    if (match) {
      if (match.error) throw new Error(`tools/list error: ${match.error.message}`)
      const result = match.result as { tools?: Array<{ name: string }> }
      const tools = (result.tools ?? []).map((t) => t.name)
      child.kill()
      return tools
    }
    await new Promise((r) => setTimeout(r, 25))
  }

  child.kill()
  throw new Error(`Timed out waiting for tools/list response\nstderr: ${stderrTail}`)
}

describe("MCP server bundle (dist/memo-mcp-server.js)", () => {
  let toolNames: string[]

  beforeAll(async () => {
    toolNames = await handshakeWithBundle()
  })

  it("responds to initialize + tools/list over stdio", () => {
    expect(Array.isArray(toolNames)).toBe(true)
    expect(toolNames.length).toBeGreaterThan(0)
  })

  it.each(EXPECTED_TOOLS)("registers tool: %s", (name) => {
    expect(toolNames).toContain(name)
  })

  it("registers exactly the expected tools (no extras)", () => {
    expect([...toolNames].sort()).toEqual([...EXPECTED_TOOLS].sort())
  })
})
