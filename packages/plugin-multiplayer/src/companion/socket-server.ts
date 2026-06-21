// Unix-domain-socket bridge between the in-process plugin and the companion
// TUI process. The server:
//
//   1. Generates a 32-byte random auth token on start and writes it to
//      `tokenPath` so the companion can read it.
//   2. Listens on `socketPath` and accepts one or more companion clients.
//   3. On every new connection, waits for a `hello` message carrying the
//      token; rejects (closes) the connection on mismatch.
//   4. Pushes the current plugin state to the client as soon as it
//      authenticates, then forwards every `push*` call to all live
//      connections.
//
// All `push*` methods are no-ops when the server is stopped or no
// authenticated clients are connected.

import { createServer, type Socket, type Server } from "node:net"
import { chmodSync, existsSync, unlinkSync } from "node:fs"
import { writeFile, unlink } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import {
  makeLineParser,
  encode,
  splitLines,
  IPC_VERSION,
  IPC_MAX_MESSAGE_BYTES,
  type IpcState,
  type IpcPeer,
  type IpcToastVariant,
  type IpcTypingState,
  type PluginToCompanion,
  type CompanionToPlugin,
  type LineParser,
} from "../../shared/index.ts"

export type CompanionServerHandlers = {
  onChat: (text: string) => void
  onTyping: (state: IpcTypingState) => void
  onCommand: (name: string, args: string[]) => void
  onLeave: () => void
  onConnect: () => void
  onDisconnect: () => void
  onAuthFail: (reason: string) => void
  onParseError: (err: Error) => void
  onError: (err: Error) => void
}

export type CompanionServerOptions = {
  socketPath: string
  tokenPath: string
  handlers: CompanionServerHandlers
  /** Override token (for tests). If not provided, a random one is generated. */
  token?: string
  /** Override line parser (for tests). */
  lineParser?: LineParser
  /** Override encode (for tests). */
  encodeFn?: (msg: PluginToCompanion | CompanionToPlugin) => string
}

type ClientConn = {
  socket: Socket
  buffer: string
  authenticated: boolean
  greeted: boolean
}

const HELLO_TIMEOUT_MS = 3000

export class CompanionSocketServer {
  private server: Server | null = null
  private clients = new Set<ClientConn>()
  private expectedToken: string
  private helloTimers = new WeakMap<Socket, ReturnType<typeof setTimeout>>()
  private lineParser: LineParser
  private encodeFn: (msg: PluginToCompanion | CompanionToPlugin) => string
  private stopped = false

  constructor(private opts: CompanionServerOptions) {
    this.expectedToken = opts.token ?? CompanionSocketServer.generateToken()
    this.lineParser = opts.lineParser ?? makeLineParser("companion")
    this.encodeFn = opts.encodeFn ?? encode
  }

  static generateToken(): string {
    return randomBytes(24).toString("hex")
  }

  getToken(): string {
    return this.expectedToken
  }

  getSocketPath(): string {
    return this.opts.socketPath
  }

  isRunning(): boolean {
    return this.server !== null && !this.stopped
  }

  clientCount(): number {
    return this.clients.size
  }

  async start(): Promise<void> {
    if (this.server) return
    this.stopped = false

    // Ensure parent dir exists.
    const dir = this.opts.socketPath.replace(/\/[^/]+$/, "")
    if (dir && dir !== this.opts.socketPath) {
      const { mkdir } = await import("node:fs/promises")
      await mkdir(dir, { recursive: true })
    }

    if (existsSync(this.opts.socketPath)) {
      try {
        unlinkSync(this.opts.socketPath)
      } catch {
        /* best-effort */
      }
    }
    if (existsSync(this.opts.tokenPath)) {
      try {
        unlinkSync(this.opts.tokenPath)
      } catch {
        /* best-effort */
      }
    }

    await writeFile(this.opts.tokenPath, this.expectedToken, { mode: 0o600 })
    try {
      chmodSync(this.opts.tokenPath, 0o600)
    } catch {
      /* best-effort */
    }

    await new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => this.onConnection(socket))
      server.on("error", (e) => {
        this.opts.handlers.onError(e)
        reject(e)
      })
      server.listen(this.opts.socketPath, () => {
        try {
          chmodSync(this.opts.socketPath, 0o600)
        } catch {
          /* best-effort */
        }
        this.server = server
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    for (const c of this.clients) {
      try {
        c.socket.end()
      } catch {
        /* ignore */
      }
      try {
        c.socket.destroy()
      } catch {
        /* ignore */
      }
    }
    this.clients.clear()
    if (this.server) {
      const s = this.server
      this.server = null
      await new Promise<void>((resolve) => {
        s.close(() => resolve())
      })
    }
    if (existsSync(this.opts.socketPath)) {
      try {
        await unlink(this.opts.socketPath)
      } catch {
        /* ignore */
      }
    }
    if (existsSync(this.opts.tokenPath)) {
      try {
        await unlink(this.opts.tokenPath)
      } catch {
        /* ignore */
      }
    }
  }

  pushState(state: IpcState): void {
    this.broadcast({ type: "init", state })
  }

  pushRoleChange(state: IpcState): void {
    this.broadcast({ type: "role_change", state })
  }

  pushPeersUpdate(peers: IpcPeer[]): void {
    this.broadcast({ type: "peers_update", peers })
  }

  pushChat(msg: { from: string; text: string; ts: number; mine: boolean }): void {
    this.broadcast({ type: "chat", ...msg })
  }

  pushTyping(from: string, state: IpcTypingState): void {
    this.broadcast({ type: "typing", from, state })
  }

  pushHostLeaving(grace_s: number): void {
    this.broadcast({ type: "host_leaving", grace_s })
  }

  pushLeaveCancelled(): void {
    this.broadcast({ type: "leave_cancelled" })
  }

  pushSessionEnded(reason: string): void {
    this.broadcast({ type: "session_ended", reason })
  }

  pushTransferStart(new_code: string, new_url: string, new_handle: string): void {
    this.broadcast({ type: "transfer_start", new_code, new_url, new_handle })
  }

  pushToast(message: string, variant: IpcToastVariant, title?: string): void {
    const msg: PluginToCompanion = title
      ? { type: "toast", message, variant, title }
      : { type: "toast", message, variant }
    this.broadcast(msg)
  }

  pushGoodbye(reason: string): void {
    this.broadcast({ type: "goodbye", reason })
  }

  private broadcast(msg: PluginToCompanion): void {
    if (!this.server) return
    const payload = this.encodeFn(msg)
    for (const c of this.clients) {
      if (!c.authenticated) continue
      try {
        c.socket.write(payload)
      } catch {
        /* ignore */
      }
    }
  }

  private onConnection(socket: Socket): void {
    if (this.stopped) {
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
      return
    }
    const conn: ClientConn = { socket, buffer: "", authenticated: false, greeted: false }
    this.clients.add(conn)

    const timer = setTimeout(() => {
      this.opts.handlers.onAuthFail("hello_timeout")
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
    }, HELLO_TIMEOUT_MS)
    this.helloTimers.set(socket, timer)

    socket.on("data", (chunk) => {
      if (this.stopped) return
      const buf = conn.buffer + chunk.toString("utf8")
      if (buf.length > IPC_MAX_MESSAGE_BYTES * 4) {
        this.opts.handlers.onAuthFail("buffer_overflow")
        try {
          socket.destroy()
        } catch {
          /* ignore */
        }
        return
      }
      const { lines, rest } = splitLines(buf)
      conn.buffer = rest
      for (const line of lines) {
        this.lineParser(
          line,
          (m) => this.onCompanionMessage(conn, m),
          (e) => this.opts.handlers.onParseError(e),
        )
      }
    })

    socket.on("close", () => {
      const t = this.helloTimers.get(socket)
      if (t) {
        clearTimeout(t)
        this.helloTimers.delete(socket)
      }
      this.clients.delete(conn)
      if (conn.authenticated) {
        try {
          this.opts.handlers.onDisconnect()
        } catch {
          /* ignore */
        }
      }
    })

    socket.on("error", (e) => {
      this.opts.handlers.onError(e)
    })
  }

  private onCompanionMessage(conn: ClientConn, msg: PluginToCompanion | CompanionToPlugin): void {
    if (
      msg.type !== "hello" &&
      msg.type !== "chat" &&
      msg.type !== "typing" &&
      msg.type !== "command" &&
      msg.type !== "leave" &&
      msg.type !== "ping" &&
      msg.type !== "goodbye"
    ) {
      // Plugin messages should not arrive on a companion stream; ignore.
      return
    }

    if (!conn.authenticated) {
      if (msg.type === "hello") {
        const t = this.helloTimers.get(conn.socket)
        if (t) {
          clearTimeout(t)
          this.helloTimers.delete(conn.socket)
        }
        if (msg.token !== this.expectedToken) {
          this.opts.handlers.onAuthFail("bad_token")
          try {
            conn.socket.destroy()
          } catch {
            /* ignore */
          }
          return
        }
        if (msg.version !== IPC_VERSION) {
          this.opts.handlers.onAuthFail(`version_mismatch:${msg.version}`)
          try {
            conn.socket.destroy()
          } catch {
            /* ignore */
          }
          return
        }
        conn.authenticated = true
        try {
          this.opts.handlers.onConnect()
        } catch {
          /* ignore */
        }
        // The plugin will call pushState() immediately after auth
        // (via getIpcState). The companion uses pushState as a signal
        // that it can begin normal operation.
        conn.greeted = true
      } else {
        this.opts.handlers.onAuthFail("not_hello")
        try {
          conn.socket.destroy()
        } catch {
          /* ignore */
        }
      }
      return
    }

    switch (msg.type) {
      case "chat":
        try {
          this.opts.handlers.onChat(msg.text)
        } catch {
          /* ignore */
        }
        return
      case "typing":
        try {
          this.opts.handlers.onTyping(msg.state)
        } catch {
          /* ignore */
        }
        return
      case "command":
        try {
          this.opts.handlers.onCommand(msg.name, msg.args)
        } catch {
          /* ignore */
        }
        return
      case "leave":
        try {
          this.opts.handlers.onLeave()
        } catch {
          /* ignore */
        }
        return
      case "ping":
        return
      case "goodbye":
        try {
          conn.socket.end()
        } catch {
          /* ignore */
        }
        return
    }
  }
}
