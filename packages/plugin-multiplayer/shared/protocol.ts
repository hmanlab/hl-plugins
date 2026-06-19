// Shared IPC protocol between the in-proc plugin and the companion process.
//
// The plugin and companion communicate over a Unix domain socket (or named
// pipe on Windows) using newline-delimited JSON. Both ends validate incoming
// messages with the `isPluginToCompanion` / `isCompanionToPlugin` guards.
//
// Versioning: every `hello` from the companion carries a `version` string.
// Bump `IPC_VERSION` on any breaking change; the plugin rejects mismatches.

export const IPC_VERSION = "1.0.0"
export const IPC_MAX_MESSAGE_BYTES = 64 * 1024

export type IpcRole = "host" | "guest" | "idle"
export type IpcLeaving = "none" | "pending" | "transferring"
export type IpcToastVariant = "info" | "success" | "warning" | "error"
export type IpcTypingState = "start" | "stop"

export type IpcPeer = { handle: string; joinedAt: number }

export type IpcState = {
  role: IpcRole
  handle: string
  code: string | null
  port: number
  hostHandle: string | null
  peers: IpcPeer[]
  leaving: IpcLeaving
  grace_s: number | null
}

export type PluginToCompanion =
  | { type: "init"; state: IpcState }
  | { type: "peers_update"; peers: IpcPeer[] }
  | { type: "chat"; from: string; text: string; ts: number; mine: boolean }
  | { type: "typing"; from: string; state: IpcTypingState }
  | { type: "host_leaving"; grace_s: number }
  | { type: "leave_cancelled" }
  | { type: "session_ended"; reason: string }
  | { type: "transfer_start"; new_code: string; new_url: string; new_handle: string }
  | { type: "role_change"; state: IpcState }
  | { type: "toast"; message: string; variant: IpcToastVariant; title?: string }
  | { type: "goodbye"; reason: string }

export type CompanionToPlugin =
  | { type: "hello"; version: string; token: string }
  | { type: "chat"; text: string }
  | { type: "typing"; state: IpcTypingState }
  | { type: "command"; name: string; args: string[] }
  | { type: "leave" }
  | { type: "ping" }
  | { type: "goodbye" }

const MAX_TEXT = 4000
const MAX_HANDLE = 16
const HANDLE_RE = /^[a-z0-9-]{1,16}$/
const CODE_RE = /^mp-([a-z0-9-]{1,16})-([a-z0-9]{4})-([a-z0-9]{4})$/
const URL_RE = /^wss?:\/\/.+/
const VARIANT_SET = new Set<IpcToastVariant>(["info", "success", "warning", "error"])
const ROLE_SET = new Set<IpcRole>(["host", "guest", "idle"])
const LEAVING_SET = new Set<IpcLeaving>(["none", "pending", "transferring"])
const TYPING_SET = new Set<IpcTypingState>(["start", "stop"])

function isPeer(x: unknown): x is IpcPeer {
  if (typeof x !== "object" || x === null) return false
  const p = x as { handle?: unknown; joinedAt?: unknown }
  return typeof p.handle === "string" && HANDLE_RE.test(p.handle) && typeof p.joinedAt === "number"
}

function isState(x: unknown): x is IpcState {
  if (typeof x !== "object" || x === null) return false
  const s = x as {
    role?: unknown
    handle?: unknown
    code?: unknown
    port?: unknown
    hostHandle?: unknown
    peers?: unknown
    leaving?: unknown
    grace_s?: unknown
  }
  if (typeof s.role !== "string" || !ROLE_SET.has(s.role as IpcRole)) return false
  if (typeof s.handle !== "string" || s.handle.length === 0 || s.handle.length > MAX_HANDLE) return false
  if (s.code !== null && !(typeof s.code === "string" && CODE_RE.test(s.code))) return false
  if (typeof s.port !== "number" || s.port < 1 || s.port > 65535) return false
  if (s.hostHandle !== null && !(typeof s.hostHandle === "string" && HANDLE_RE.test(s.hostHandle)))
    return false
  if (!Array.isArray(s.peers) || !s.peers.every(isPeer)) return false
  if (typeof s.leaving !== "string" || !LEAVING_SET.has(s.leaving as IpcLeaving)) return false
  if (s.grace_s !== null && typeof s.grace_s !== "number") return false
  return true
}

export function isPluginToCompanion(x: unknown): x is PluginToCompanion {
  if (typeof x !== "object" || x === null) return false
  const m = x as { type?: unknown }
  if (typeof m.type !== "string") return false
  switch (m.type) {
    case "init":
      return isState((x as { state?: unknown }).state)
    case "peers_update":
      return (
        Array.isArray((x as { peers?: unknown }).peers) && (x as { peers: unknown[] }).peers.every(isPeer)
      )
    case "chat": {
      const v = x as { from?: unknown; text?: unknown; ts?: unknown; mine?: unknown }
      return (
        typeof v.from === "string" &&
        v.from.length > 0 &&
        v.from.length <= MAX_HANDLE &&
        typeof v.text === "string" &&
        v.text.length > 0 &&
        v.text.length <= MAX_TEXT &&
        typeof v.ts === "number" &&
        typeof v.mine === "boolean"
      )
    }
    case "typing": {
      const v = x as { from?: unknown; state?: unknown }
      return (
        typeof v.from === "string" &&
        v.from.length > 0 &&
        v.from.length <= MAX_HANDLE &&
        typeof v.state === "string" &&
        TYPING_SET.has(v.state as IpcTypingState)
      )
    }
    case "host_leaving":
      return typeof (x as { grace_s?: unknown }).grace_s === "number"
    case "leave_cancelled":
      return true
    case "session_ended":
      return typeof (x as { reason?: unknown }).reason === "string"
    case "transfer_start": {
      const v = x as { new_code?: unknown; new_url?: unknown; new_handle?: unknown }
      return (
        typeof v.new_code === "string" &&
        CODE_RE.test(v.new_code) &&
        typeof v.new_url === "string" &&
        URL_RE.test(v.new_url) &&
        typeof v.new_handle === "string" &&
        HANDLE_RE.test(v.new_handle)
      )
    }
    case "role_change":
      return isState((x as { state?: unknown }).state)
    case "toast": {
      const v = x as { message?: unknown; variant?: unknown; title?: unknown }
      return (
        typeof v.message === "string" &&
        v.message.length > 0 &&
        v.message.length <= MAX_TEXT &&
        typeof v.variant === "string" &&
        VARIANT_SET.has(v.variant as IpcToastVariant) &&
        (v.title === undefined || typeof v.title === "string")
      )
    }
    case "goodbye":
      return typeof (x as { reason?: unknown }).reason === "string"
    default:
      return false
  }
}

export function isCompanionToPlugin(x: unknown): x is CompanionToPlugin {
  if (typeof x !== "object" || x === null) return false
  const m = x as { type?: unknown }
  if (typeof m.type !== "string") return false
  switch (m.type) {
    case "hello": {
      const v = x as { version?: unknown; token?: unknown }
      return (
        typeof v.version === "string" &&
        v.version.length > 0 &&
        v.version.length <= 32 &&
        typeof v.token === "string" &&
        v.token.length > 0 &&
        v.token.length <= 256
      )
    }
    case "chat": {
      const v = x as { text?: unknown }
      return typeof v.text === "string" && v.text.length > 0 && v.text.length <= MAX_TEXT
    }
    case "typing": {
      const v = x as { state?: unknown }
      return typeof v.state === "string" && TYPING_SET.has(v.state as IpcTypingState)
    }
    case "command": {
      const v = x as { name?: unknown; args?: unknown }
      return (
        typeof v.name === "string" &&
        v.name.length > 0 &&
        v.name.length <= 32 &&
        Array.isArray(v.args) &&
        v.args.every((a) => typeof a === "string" && a.length <= MAX_TEXT)
      )
    }
    case "leave":
    case "ping":
    case "goodbye":
      return true
    default:
      return false
  }
}
