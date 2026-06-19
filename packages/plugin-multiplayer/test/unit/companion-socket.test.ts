import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { connect, type Socket } from "node:net"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CompanionSocketServer } from "../../src/companion/socket-server"
import { IPC_VERSION } from "../../shared/protocol"
import type { IpcState } from "../../shared/protocol"
import { encode, makeLineParser } from "../../shared/codec"

type Captured = {
  chats: string[]
  typings: ("start" | "stop")[]
  commands: { name: string; args: string[] }[]
  leaves: number
  connects: number
  disconnects: number
  authFails: string[]
  parseErrors: Error[]
  errors: Error[]
  received: string[]
}

function capture(): Captured {
  return {
    chats: [],
    typings: [],
    commands: [],
    leaves: 0,
    connects: 0,
    disconnects: 0,
    authFails: [],
    parseErrors: [],
    errors: [],
    received: [],
  }
}

const baseState: IpcState = {
  role: "host",
  handle: "bob",
  code: "mp-bob-abcd-efgh",
  port: 7332,
  hostHandle: "bob",
  peers: [],
  leaving: "none",
  grace_s: null,
}

function makeClient(
  socketPath: string,
  captured: Captured,
): { open: () => Promise<Socket>; write: (s: Socket, m: unknown) => void } {
  const parser = makeLineParser("plugin")
  let buffer = ""
  const open = (): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const sock = connect(socketPath)
      sock.once("connect", () => resolve(sock))
      sock.once("error", reject)
      sock.on("data", (chunk) => {
        buffer += chunk.toString("utf8")
        const { lines, rest } = ((): { lines: string[]; rest: string } => {
          const parts = buffer.split("\n")
          return { lines: parts.slice(0, -1), rest: parts[parts.length - 1] ?? "" }
        })()
        buffer = rest
        for (const line of lines) {
          parser(
            line,
            (m) => captured.received.push(line),
            (e) => captured.parseErrors.push(e),
          )
        }
      })
    })
  const write = (s: Socket, m: unknown) => {
    s.write(JSON.stringify(m) + "\n")
  }
  return { open, write }
}

describe("CompanionSocketServer", () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: CompanionSocketServer
  let cap: Captured

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "mp-companion-"))
    socketPath = join(dir, "companion.sock")
    tokenPath = join(dir, "companion.token")
    cap = capture()
  })

  afterEach(async () => {
    if (server && server.isRunning()) {
      await server.stop()
    }
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  async function startServer(token?: string): Promise<CompanionSocketServer> {
    server = new CompanionSocketServer({
      socketPath,
      tokenPath,
      token,
      handlers: {
        onChat: (t) => cap.chats.push(t),
        onTyping: (s) => cap.typings.push(s),
        onCommand: (n, a) => cap.commands.push({ name: n, args: a }),
        onLeave: () => cap.leaves++,
        onConnect: () => cap.connects++,
        onDisconnect: () => cap.disconnects++,
        onAuthFail: (r) => cap.authFails.push(r),
        onParseError: (e) => cap.parseErrors.push(e),
        onError: (e) => cap.errors.push(e),
      },
    })
    await server.start()
    return server
  }

  it("writes a token file and listens on the socket", async () => {
    const s = await startServer()
    expect(s.getToken().length).toBeGreaterThan(0)
    expect(existsSync(tokenPath)).toBe(true)
    expect(existsSync(socketPath)).toBe(true)
  })

  it("uses a provided token when supplied", async () => {
    const s = await startServer("custom-token-1234")
    expect(s.getToken()).toBe("custom-token-1234")
    const onDisk = (await Bun.file(tokenPath).text()).trim()
    expect(onDisk).toBe("custom-token-1234")
  })

  it("rejects a client with the wrong token", async () => {
    const s = await startServer("good-token")
    const { open, write } = makeClient(socketPath, cap)
    const sock = await open()
    write(sock, { type: "hello", version: IPC_VERSION, token: "wrong-token" })
    await new Promise((r) => sock.once("close", r))
    await new Promise((r) => setTimeout(r, 50))
    expect(cap.authFails).toContain("bad_token")
    expect(cap.connects).toBe(0)
  })

  it("rejects a client with the wrong version", async () => {
    const s = await startServer("good-token")
    const { open, write } = makeClient(socketPath, cap)
    const sock = await open()
    write(sock, { type: "hello", version: "0.0.0", token: "good-token" })
    await new Promise((r) => sock.once("close", r))
    await new Promise((r) => setTimeout(r, 50))
    expect(cap.authFails.some((r) => r.startsWith("version_mismatch"))).toBe(true)
  })

  it("accepts a client with the right token + version", async () => {
    const s = await startServer("good-token")
    const { open, write } = makeClient(socketPath, cap)
    const sock = await open()
    write(sock, { type: "hello", version: IPC_VERSION, token: "good-token" })
    await new Promise((r) => setTimeout(r, 50))
    expect(cap.connects).toBe(1)
    sock.destroy()
  })

  it("dispatches chat, typing, command, and leave to the handlers", async () => {
    const s = await startServer("good-token")
    const { open, write } = makeClient(socketPath, cap)
    const sock = await open()
    write(sock, { type: "hello", version: IPC_VERSION, token: "good-token" })
    await new Promise((r) => setTimeout(r, 50))

    write(sock, { type: "chat", text: "hi from companion" })
    write(sock, { type: "typing", state: "start" })
    write(sock, { type: "typing", state: "stop" })
    write(sock, { type: "command", name: "join", args: ["mp-bob-abcd-efgh"] })
    write(sock, { type: "leave" })

    await new Promise((r) => setTimeout(r, 100))

    expect(cap.chats).toEqual(["hi from companion"])
    expect(cap.typings).toEqual(["start", "stop"])
    expect(cap.commands).toEqual([{ name: "join", args: ["mp-bob-abcd-efgh"] }])
    expect(cap.leaves).toBe(1)
    sock.destroy()
  })

  it("rejects messages sent before hello", async () => {
    const s = await startServer("good-token")
    const { open, write } = makeClient(socketPath, cap)
    const sock = await open()
    write(sock, { type: "chat", text: "before hello" })
    await new Promise((r) => sock.once("close", r))
    await new Promise((r) => setTimeout(r, 50))
    expect(cap.authFails).toContain("not_hello")
  })

  it("pushState writes init to authenticated clients", async () => {
    const s = await startServer("good-token")
    const { open, write } = makeClient(socketPath, cap)
    const sock = await open()
    write(sock, { type: "hello", version: IPC_VERSION, token: "good-token" })
    await new Promise((r) => setTimeout(r, 50))
    cap.received.length = 0

    s.pushState(baseState)
    await new Promise((r) => setTimeout(r, 30))
    expect(cap.received.length).toBeGreaterThan(0)
    const last = JSON.parse(cap.received[cap.received.length - 1]!)
    expect(last).toEqual({ type: "init", state: baseState })
    sock.destroy()
  })

  it("pushPeersUpdate / pushChat / pushTyping / pushToast are delivered", async () => {
    const s = await startServer("good-token")
    const { open, write } = makeClient(socketPath, cap)
    const sock = await open()
    write(sock, { type: "hello", version: IPC_VERSION, token: "good-token" })
    await new Promise((r) => setTimeout(r, 50))
    cap.received.length = 0

    s.pushPeersUpdate([{ handle: "carol", joinedAt: 1 }])
    s.pushChat({ from: "carol", text: "hi", ts: 2, mine: false })
    s.pushTyping("carol", "start")
    s.pushHostLeaving(10)
    s.pushLeaveCancelled()
    s.pushSessionEnded("no_peers")
    s.pushTransferStart("mp-carol-wxyz-1234", "ws://localhost:7332", "carol")
    s.pushRoleChange(baseState)
    s.pushToast("hello", "info")
    s.pushGoodbye("shutdown")
    await new Promise((r) => setTimeout(r, 30))

    const types = cap.received.map((line) => JSON.parse(line).type)
    expect(types).toContain("peers_update")
    expect(types).toContain("chat")
    expect(types).toContain("typing")
    expect(types).toContain("host_leaving")
    expect(types).toContain("leave_cancelled")
    expect(types).toContain("session_ended")
    expect(types).toContain("transfer_start")
    expect(types).toContain("role_change")
    expect(types).toContain("toast")
    expect(types).toContain("goodbye")
    sock.destroy()
  })

  it("multi-line frames are split correctly on the server→client path", async () => {
    const s = await startServer("good-token")
    const { open, write } = makeClient(socketPath, cap)
    const sock = await open()
    write(sock, { type: "hello", version: IPC_VERSION, token: "good-token" })
    await new Promise((r) => setTimeout(r, 50))
    cap.received.length = 0

    // Server writes two messages in one frame
    s.pushLeaveCancelled()
    s.pushLeaveCancelled()
    await new Promise((r) => setTimeout(r, 30))
    expect(cap.received.length).toBe(2)
    sock.destroy()
  })

  it("multi-line frames are split correctly on the client→server path", async () => {
    const s = await startServer("good-token")
    const { open } = makeClient(socketPath, cap)
    const sock = await open()
    sock.write(
      JSON.stringify({ type: "hello", version: IPC_VERSION, token: "good-token" }) +
        "\n" +
        JSON.stringify({ type: "chat", text: "frame 1" }) +
        "\n" +
        JSON.stringify({ type: "chat", text: "frame 2" }) +
        "\n",
    )
    await new Promise((r) => setTimeout(r, 80))
    expect(cap.connects).toBe(1)
    expect(cap.chats).toEqual(["frame 1", "frame 2"])
    sock.destroy()
  })

  it("fires onDisconnect when a client closes", async () => {
    const s = await startServer("good-token")
    const { open, write } = makeClient(socketPath, cap)
    const sock = await open()
    write(sock, { type: "hello", version: IPC_VERSION, token: "good-token" })
    await new Promise((r) => setTimeout(r, 50))
    sock.destroy()
    await new Promise((r) => setTimeout(r, 50))
    expect(cap.disconnects).toBe(1)
    expect(s.clientCount()).toBe(0)
  })

  it("stop() removes the socket and token files", async () => {
    const s = await startServer("good-token")
    expect(existsSync(socketPath)).toBe(true)
    expect(existsSync(tokenPath)).toBe(true)
    await s.stop()
    expect(existsSync(socketPath)).toBe(false)
    expect(existsSync(tokenPath)).toBe(false)
    expect(s.isRunning()).toBe(false)
  })

  it("is idempotent on start()", async () => {
    const s = await startServer("good-token")
    await s.start() // second call should be a no-op
    expect(s.isRunning()).toBe(true)
  })

  it("supports multiple concurrent clients", async () => {
    const s = await startServer("good-token")
    const a = makeClient(socketPath, cap)
    const b = makeClient(socketPath, cap)
    const sa = await a.open()
    const sb = await b.open()
    a.write(sa, { type: "hello", version: IPC_VERSION, token: "good-token" })
    b.write(sb, { type: "hello", version: IPC_VERSION, token: "good-token" })
    await new Promise((r) => setTimeout(r, 50))
    expect(s.clientCount()).toBe(2)
    sa.destroy()
    sb.destroy()
  })

  it("refuses to send to unauthenticated clients", async () => {
    const s = await startServer("good-token")
    const { open, write } = makeClient(socketPath, cap)
    const sock = await open()
    // No hello yet
    s.pushState(baseState)
    await new Promise((r) => setTimeout(r, 30))
    expect(cap.received.length).toBe(0)
    sock.destroy()
  })
})

void writeFileSync
void encode
