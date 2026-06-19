// Unix-domain-socket client. The companion reads `MP_COMPANION_SOCK` and
// `MP_COMPANION_TOKEN` from the environment (or `MP_COMPANION_TOKEN_FILE` for
// the manual `npx multiplayer-watch` fallback) and connects to the plugin.
//
// Reconnection is bounded: the companion retries up to 5 times with
// exponential backoff, then gives up and exits non-zero so the user sees
// the failure in their terminal.

import { connect, type Socket } from "node:net"
import { readFileSync } from "node:fs"
import {
  makeLineParser,
  encode,
  splitLines,
  IPC_VERSION,
  IPC_MAX_MESSAGE_BYTES,
  type PluginToCompanion,
  type CompanionToPlugin,
  type LineParser,
} from "../protocol.ts"

export type CompanionClientEvents = {
  message: (msg: PluginToCompanion) => void
  open: () => void
  close: (hadError: boolean) => void
  error: (err: Error) => void
  auth_fail: (reason: string) => void
}

export type CompanionClientOptions = {
  socketPath: string
  token: string
  lineParser?: LineParser
  encodeFn?: (msg: CompanionToPlugin) => string
  maxFrameBytes?: number
  handshakeTimeoutMs?: number
}

type Listener = (...args: unknown[]) => void

export class CompanionClient {
  private socket: Socket | null = null
  private buffer = ""
  private connected = false
  private authenticated = false
  private retryCount = 0
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  private lineParser: LineParser
  private encodeFn: (msg: CompanionToPlugin) => string
  private listeners = new Map<string, Set<Listener>>()

  readonly socketPath: string
  readonly token: string
  private readonly maxFrameBytes: number
  private readonly handshakeTimeoutMs: number

  constructor(opts: CompanionClientOptions) {
    this.socketPath = opts.socketPath
    this.token = opts.token
    this.lineParser = opts.lineParser ?? makeLineParser("plugin")
    this.encodeFn = opts.encodeFn ?? (encode as (msg: CompanionToPlugin) => string)
    this.maxFrameBytes = opts.maxFrameBytes ?? IPC_MAX_MESSAGE_BYTES
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 5000
  }

  on(event: keyof CompanionClientEvents, listener: Listener): this {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)
    return this
  }

  off(event: keyof CompanionClientEvents, listener: Listener): this {
    const set = this.listeners.get(event)
    if (set) set.delete(listener)
    return this
  }

  private emit(event: keyof CompanionClientEvents, ...args: unknown[]): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const l of [...set]) {
      try {
        l(...args)
      } catch {
        /* ignore */
      }
    }
  }

  connect(): void {
    if (this.socket) return
    this.connected = false
    this.authenticated = false
    const sock = connect(this.socketPath)
    this.socket = sock

    sock.once("connect", () => {
      this.connected = true
      this.retryCount = 0
      this.handshakeTimer = setTimeout(() => {
        this.failAuth("hello_timeout")
        try {
          sock.destroy()
        } catch {
          /* ignore */
        }
      }, this.handshakeTimeoutMs)
      this.write({ type: "hello", version: IPC_VERSION, token: this.token })
      this.emit("open")
    })

    sock.on("data", (chunk) => {
      if (!this.authenticated) {
        // The server pushes the initial state only after auth. We still
        // accept stray frames but ignore them until then.
      }
      const buf = this.buffer + chunk.toString("utf8")
      if (buf.length > this.maxFrameBytes * 4) {
        this.emit("error", new Error("buffer overflow from server"))
        try {
          sock.destroy()
        } catch {
          /* ignore */
        }
        return
      }
      const { lines, rest } = splitLines(buf)
      this.buffer = rest
      for (const line of lines) {
        this.lineParser(
          line,
          (m) => this.onPluginMessage(m),
          (e) => this.emit("error", e),
        )
      }
    })

    sock.once("close", (hadError) => {
      this.connected = false
      this.authenticated = false
      this.socket = null
      this.emit("close", hadError)
    })

    sock.once("error", (err) => {
      this.emit("error", err)
    })
  }

  write(msg: CompanionToPlugin): void {
    if (!this.socket || !this.connected) return
    try {
      this.socket.write(this.encodeFn(msg))
    } catch (e) {
      this.emit("error", e as Error)
    }
  }

  sendChat(text: string): void {
    this.write({ type: "chat", text })
  }

  sendTyping(state: "start" | "stop"): void {
    this.write({ type: "typing", state })
  }

  sendCommand(name: string, args: string[]): void {
    this.write({ type: "command", name, args })
  }

  sendLeave(): void {
    this.write({ type: "leave" })
  }

  close(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }
    if (this.socket) {
      try {
        this.write({ type: "goodbye" })
      } catch {
        /* ignore */
      }
      try {
        this.socket.end()
      } catch {
        /* ignore */
      }
      try {
        this.socket.destroy()
      } catch {
        /* ignore */
      }
      this.socket = null
    }
  }

  isAuthenticated(): boolean {
    return this.authenticated
  }

  private onPluginMessage(msg: PluginToCompanion | CompanionToPlugin): void {
    // The line parser enforces that this is a PluginToCompanion.
    if (!("type" in msg)) return
    const t = msg.type
    if (
      t !== "init" &&
      t !== "role_change" &&
      t !== "peers_update" &&
      t !== "chat" &&
      t !== "typing" &&
      t !== "host_leaving" &&
      t !== "leave_cancelled" &&
      t !== "session_ended" &&
      t !== "transfer_start" &&
      t !== "toast" &&
      t !== "goodbye"
    ) {
      return
    }
    if (!this.authenticated && t === "init") {
      if (this.handshakeTimer) {
        clearTimeout(this.handshakeTimer)
        this.handshakeTimer = null
      }
      this.authenticated = true
    }
    this.emit("message", msg)
  }

  private failAuth(reason: string): void {
    this.emit("auth_fail", reason)
    try {
      this.write({ type: "goodbye" })
    } catch {
      /* ignore */
    }
    if (this.socket) {
      try {
        this.socket.end()
      } catch {
        /* ignore */
      }
    }
  }
}

export function loadTokenFromEnv(): { socketPath: string; token: string } | null {
  const socketPath = process.env["MP_COMPANION_SOCK"]
  if (!socketPath) return null
  let token = process.env["MP_COMPANION_TOKEN"] ?? ""
  if (!token) {
    const tokenFile = process.env["MP_COMPANION_TOKEN_FILE"]
    if (tokenFile) {
      try {
        token = readFileSync(tokenFile, "utf8").trim()
      } catch {
        return null
      }
    }
  }
  if (!token) return null
  return { socketPath, token }
}
