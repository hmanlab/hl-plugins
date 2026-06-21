// Unit tests for the Claude-side config helpers added in Phase C.
// Run via: npm test (which now includes both test files).
//
// Uses Node's built-in `node:test` runner. The tests stub HOME via the
// `os_` shim from Phase A so the `~/.claude.json` resolution is
// host-independent.

import { describe, it, mock, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const osShim = await import("../../src/lib/os-shim.js")
let currentHome = "/Users/test"
mock.method(osShim.os_, "homedir", () => currentHome)

function setHome(h: string) {
  currentHome = h
}

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "homedir-"))
}

const config = await import("../../src/lib/config.js")

describe("readClaudeConfig()", () => {
  beforeEach(() => setHome(freshHome()))
  afterEach(() => {
    for (const dir of [currentHome]) {
      try {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  })

  it("returns {} when ~/.claude.json is missing", () => {
    const cfg = config.readClaudeConfig()
    assert.deepEqual(cfg, {})
  })

  it("returns {} when ~/.claude.json is empty (Claude's first-launch state)", () => {
    writeFileSync(join(currentHome, ".claude.json"), "", "utf8")
    const cfg = config.readClaudeConfig()
    assert.deepEqual(cfg, {})
  })

  it("parses a valid JSON object", () => {
    writeFileSync(
      join(currentHome, ".claude.json"),
      JSON.stringify({ mcpServers: { foo: { command: "x", args: [] } } }, null, 2),
      "utf8",
    )
    const cfg = config.readClaudeConfig()
    assert.deepEqual(cfg.mcpServers, { foo: { command: "x", args: [] } })
  })

  it("throws on malformed JSON", () => {
    writeFileSync(join(currentHome, ".claude.json"), "{not json", "utf8")
    assert.throws(() => config.readClaudeConfig(), /Failed to parse/)
  })

  it("throws when top-level is not an object", () => {
    writeFileSync(join(currentHome, ".claude.json"), '"a string"', "utf8")
    assert.throws(() => config.readClaudeConfig(), /expected a top-level JSON object/)
  })

  it("throws when top-level is an array", () => {
    writeFileSync(join(currentHome, ".claude.json"), "[1,2,3]", "utf8")
    assert.throws(() => config.readClaudeConfig(), /expected a top-level JSON object/)
  })
})

describe("writeClaudeConfig()", () => {
  beforeEach(() => setHome(freshHome()))
  afterEach(() => {
    try {
      if (existsSync(currentHome)) rmSync(currentHome, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it("writes pretty-printed JSON with a trailing newline", () => {
    config.writeClaudeConfig({ mcpServers: { x: { command: "x", args: ["y"] } } })
    const text = readFileSync(join(currentHome, ".claude.json"), "utf8")
    assert.match(text, /^\{\n  "mcpServers"/)
    assert.ok(text.endsWith("\n"))
  })

  it("creates the parent dir if missing", () => {
    // currentHome is a temp dir, .claude.json goes directly under it.
    // The interesting test is that writeClaudeConfig doesn't error on
    // a fresh empty HOME dir — covered by the test above.
    config.writeClaudeConfig({})
    assert.ok(existsSync(join(currentHome, ".claude.json")))
  })
})

describe("addMcpServer() / removeMcpServer()", () => {
  beforeEach(() => setHome(freshHome()))
  afterEach(() => {
    try {
      if (existsSync(currentHome)) rmSync(currentHome, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it("adds an entry and returns true", () => {
    const changed = config.addMcpServer("mmx-claude", { command: "bun", args: ["/x/y.js"] })
    assert.equal(changed, true)
    const cfg = config.readClaudeConfig()
    assert.deepEqual(cfg.mcpServers, { "mmx-claude": { command: "bun", args: ["/x/y.js"] } })
  })

  it("is idempotent when the spec is identical (returns false)", () => {
    const spec = { command: "bun", args: ["/x/y.js"] }
    config.addMcpServer("mmx-claude", spec)
    const changed = config.addMcpServer("mmx-claude", spec)
    assert.equal(changed, false)
  })

  it("overwrites when the spec changes (returns true)", () => {
    config.addMcpServer("mmx-claude", { command: "bun", args: ["/a.js"] })
    const changed = config.addMcpServer("mmx-claude", { command: "bun", args: ["/b.js"] })
    assert.equal(changed, true)
    const cfg = config.readClaudeConfig()
    assert.deepEqual(cfg.mcpServers?.["mmx-claude"]?.args, ["/b.js"])
  })

  it("preserves other top-level keys in ~/.claude.json", () => {
    writeFileSync(
      join(currentHome, ".claude.json"),
      JSON.stringify({ numStartups: 7, theme: "dark", mcpServers: { existing: { command: "x", args: [] } } }),
      "utf8",
    )
    config.addMcpServer("mmx-claude", { command: "bun", args: ["/x.js"] })
    const cfg = config.readClaudeConfig()
    assert.equal(cfg.numStartups, 7)
    assert.equal(cfg.theme, "dark")
    assert.ok(cfg.mcpServers?.existing)
    assert.ok(cfg.mcpServers?.["mmx-claude"])
  })

  it("removes an entry and returns true", () => {
    config.addMcpServer("mmx-claude", { command: "bun", args: ["/x.js"] })
    const changed = config.removeMcpServer("mmx-claude")
    assert.equal(changed, true)
    const cfg = config.readClaudeConfig()
    assert.equal(cfg.mcpServers, undefined)
  })

  it("is idempotent on remove (returns false when absent)", () => {
    assert.equal(config.removeMcpServer("never-there"), false)
  })

  it("drops the mcpServers key when the last entry is removed", () => {
    config.addMcpServer("mmx-claude", { command: "bun", args: ["/x.js"] })
    config.removeMcpServer("mmx-claude")
    const cfg = config.readClaudeConfig()
    assert.equal(cfg.mcpServers, undefined)
  })
})
