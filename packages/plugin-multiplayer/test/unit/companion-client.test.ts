import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { connect, type Socket } from "node:net"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CompanionClient, loadTokenFromEnv } from "../../../multiplayer-watch/src/transport/uds"
import { IPC_VERSION } from "../../shared/protocol"
import { encode, makeLineParser } from "../../shared/codec"
import type { PluginToCompanion } from "../../shared/protocol"

function makeServer(
  socketPath: string,
  onConnection: (sock: Socket) => void,
): { close: () => Promise<void> } {
  const { createServer } = require("node:net") as typeof import("node:net")
  const server = createServer((sock) => onConnection(sock))
  server.listen(socketPath)
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

describe("CompanionClient (transport/uds)", () => {
  let dir: string
  let socketPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mp-companion-client-"))
    socketPath = join(dir, "companion.sock")
  })

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  })

  it("connects, sends hello, and receives init", async () => {
    const parser = makeLineParser("companion")
    const server = makeServer(socketPath, (sock) => {
      sock.on("data", (chunk) => {
        const text = chunk.toString("utf8")
        for (const line of text.split("\n").filter(Boolean)) {
          parser(
            line,
            (m) => {
              if (m.type === "hello") {
                sock.write(encode({ type: "init", state: mkState() }))
              }
            },
            () => {},
          )
        }
      })
    })

    const messages: PluginToCompanion[] = []
    const client = new CompanionClient({ socketPath, token: "test-token" })
    client.on("message", (m) => messages.push(m))
    client.connect()

    // Wait until the init message arrives
    const start = Date.now()
    while (Date.now() - start < 1000) {
      if (messages.some((m) => m.type === "init")) break
      await new Promise((r) => setTimeout(r, 10))
    }

    client.close()
    await new Promise<void>((resolve) => server.close().then(resolve))

    expect(messages.some((m) => m.type === "init")).toBe(true)
  })

  it("sendChat writes a chat message to the server", async () => {
    let received = ""
    const server = makeServer(socketPath, (sock) => {
      sock.on("data", (chunk) => {
        received += chunk.toString("utf8")
      })
    })

    const client = new CompanionClient({ socketPath, token: "t" })
    client.connect()
    await new Promise((r) => setTimeout(r, 50))
    client.sendChat("hello world")
    await new Promise((r) => setTimeout(r, 50))
    client.close()
    await new Promise<void>((resolve) => server.close().then(resolve))

    expect(received).toContain("hello world")
    expect(received).toContain('"type":"chat"')
  })

  it("sendTyping writes a typing message", async () => {
    let received = ""
    const server = makeServer(socketPath, (sock) => {
      sock.on("data", (chunk) => {
        received += chunk.toString("utf8")
      })
    })
    const client = new CompanionClient({ socketPath, token: "t" })
    client.connect()
    await new Promise((r) => setTimeout(r, 50))
    client.sendTyping("start")
    client.sendTyping("stop")
    await new Promise((r) => setTimeout(r, 50))
    client.close()
    await new Promise<void>((resolve) => server.close().then(resolve))
    expect(received).toContain('"state":"start"')
    expect(received).toContain('"state":"stop"')
  })

  it("close() disconnects cleanly", async () => {
    const server = makeServer(socketPath, () => {})
    const client = new CompanionClient({ socketPath, token: "t" })
    client.connect()
    await new Promise((r) => setTimeout(r, 50))
    let closed = false
    client.on("close", () => {
      closed = true
    })
    client.close()
    await new Promise((r) => setTimeout(r, 50))
    await new Promise<void>((resolve) => server.close().then(resolve))
    expect(closed).toBe(true)
  })
})

function mkState(): import("../../shared/protocol").IpcState {
  return {
    role: "host",
    handle: "bob",
    code: "mp-bob-abcd-efgh",
    port: 7332,
    hostHandle: "bob",
    peers: [],
    leaving: "none",
    grace_s: null,
  }
}

describe("loadTokenFromEnv", () => {
  it("returns null when no env is set", () => {
    const prev = {
      sock: process.env["MP_COMPANION_SOCK"],
      token: process.env["MP_COMPANION_TOKEN"],
      file: process.env["MP_COMPANION_TOKEN_FILE"],
    }
    delete process.env["MP_COMPANION_SOCK"]
    delete process.env["MP_COMPANION_TOKEN"]
    delete process.env["MP_COMPANION_TOKEN_FILE"]
    try {
      expect(loadTokenFromEnv()).toBeNull()
    } finally {
      if (prev.sock) process.env["MP_COMPANION_SOCK"] = prev.sock
      if (prev.token) process.env["MP_COMPANION_TOKEN"] = prev.token
      if (prev.file) process.env["MP_COMPANION_TOKEN_FILE"] = prev.file
    }
  })

  it("loads from MP_COMPANION_SOCK + MP_COMPANION_TOKEN", () => {
    process.env["MP_COMPANION_SOCK"] = "/tmp/x.sock"
    process.env["MP_COMPANION_TOKEN"] = "abc"
    const r = loadTokenFromEnv()
    expect(r).toEqual({ socketPath: "/tmp/x.sock", token: "abc" })
    delete process.env["MP_COMPANION_SOCK"]
    delete process.env["MP_COMPANION_TOKEN"]
  })

  it("loads from MP_COMPANION_TOKEN_FILE when MP_COMPANION_TOKEN is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "mp-token-"))
    const file = join(dir, "token")
    writeFileSync(file, "filetoken\n")
    process.env["MP_COMPANION_SOCK"] = "/tmp/y.sock"
    process.env["MP_COMPANION_TOKEN_FILE"] = file
    delete process.env["MP_COMPANION_TOKEN"]
    const r = loadTokenFromEnv()
    expect(r).toEqual({ socketPath: "/tmp/y.sock", token: "filetoken" })
    rmSync(dir, { recursive: true, force: true })
    delete process.env["MP_COMPANION_SOCK"]
    delete process.env["MP_COMPANION_TOKEN_FILE"]
  })
})

void connect
void IPC_VERSION
