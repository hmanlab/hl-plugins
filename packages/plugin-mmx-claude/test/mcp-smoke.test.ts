// Smoke test for the bundled MCP server. Spawns dist/mmx-mcp-server.js
// (built by `bun run build` at the package root), sends a JSON-RPC
// initialize + tools/list handshake over stdio, and asserts all seven
// tool names come back.
//
// Run: bun test packages/plugin-mmx-claude/test/mcp-smoke.test.ts
// Prereq: dist/mmx-mcp-server.js exists (run `bun run build` first).

import { describe, it, expect, beforeAll } from "bun:test"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(HERE, "..", "dist", "mmx-mcp-server.js")

const SEVEN_TOOLS = [
  "mmx_image",
  "mmx_speech",
  "mmx_video",
  "mmx_music",
  "mmx_search",
  "mmx_vision",
  "mmx_quota",
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

  const child = spawn("node", [BUNDLE], { stdio: ["pipe", "pipe", "pipe"] })

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

  child.stderr.setEncoding("utf8")
  child.stderr.on("data", () => {
    // The MCP server writes logging to stderr in some setups; we don't
    // assert anything on it here.
  })

  child.on("exit", (code) => {
    if (resolveList === null) return
    if (code !== 0 && code !== null) {
      rejectList?.(new Error(`MCP server exited with code ${code} before responding`))
    }
  })

  function send(msg: object) {
    child.stdin.write(JSON.stringify(msg) + "\n")
  }

  // 1) initialize
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "0.0.0" },
    },
  })

  // 2) initialized notification
  send({ jsonrpc: "2.0", method: "notifications/initialized" })

  // 3) tools/list
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" })

  // Wait for the tools/list response (id=2).
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
  throw new Error("Timed out waiting for tools/list response from MCP server")
}

describe("MCP server bundle (dist/mmx-mcp-server.js)", () => {
  let toolNames: string[]

  beforeAll(async () => {
    toolNames = await handshakeWithBundle()
  })

  it("responds to initialize + tools/list over stdio", () => {
    expect(Array.isArray(toolNames)).toBe(true)
    expect(toolNames.length).toBeGreaterThan(0)
  })

  it.each(SEVEN_TOOLS)("registers tool: %s", (name) => {
    expect(toolNames).toContain(name)
  })

  it("registers exactly the seven expected tools (no extras)", () => {
    expect([...toolNames].sort()).toEqual([...SEVEN_TOOLS].sort())
  })
})
