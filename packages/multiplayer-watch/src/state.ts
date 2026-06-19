// State hook for the companion UI. Wraps the UDS client and exposes a
// React-friendly state object that the components render against.

import { useEffect, useReducer, useRef } from "react"
import { CompanionClient, type CompanionClientOptions, loadTokenFromEnv } from "./transport/uds.ts"
import type { IpcState, PluginToCompanion, CompanionToPlugin } from "./protocol.ts"
import { CHAT_MAX_HISTORY } from "./protocol.ts"

export type ChatLine = {
  id: number
  from: string
  text: string
  ts: number
  mine: boolean
}

export type Toast = {
  id: number
  message: string
  variant: "info" | "success" | "warning" | "error"
  title?: string
}

export type CompanionUiState = {
  connected: boolean
  authenticated: boolean
  authFail: string | null
  state: IpcState | null
  chat: ChatLine[]
  typingFrom: string | null
  toasts: Toast[]
  transferPending: { new_code: string; new_url: string; new_handle: string } | null
  sessionEnded: string | null
}

type Action =
  | { type: "open" }
  | { type: "auth_fail"; reason: string }
  | { type: "close"; hadError: boolean }
  | { type: "message"; msg: PluginToCompanion }
  | { type: "clear_session_ended" }
  | { type: "clear_transfer" }
  | { type: "drop_toast"; id: number }

const initial: CompanionUiState = {
  connected: false,
  authenticated: false,
  authFail: null,
  state: null,
  chat: [],
  typingFrom: null,
  toasts: [],
  transferPending: null,
  sessionEnded: null,
}

let idSeq = 0
const nextId = () => ++idSeq

function reducer(s: CompanionUiState, a: Action): CompanionUiState {
  switch (a.type) {
    case "open":
      return { ...s, connected: true, authFail: null }
    case "auth_fail":
      return { ...s, authFail: a.reason, authenticated: false, connected: false }
    case "close":
      if (s.authFail) return s
      return { ...s, connected: false, authenticated: false }
    case "clear_session_ended":
      return { ...s, sessionEnded: null }
    case "clear_transfer":
      return { ...s, transferPending: null }
    case "drop_toast":
      return { ...s, toasts: s.toasts.filter((t) => t.id !== a.id) }
    case "message": {
      const m = a.msg
      switch (m.type) {
        case "init":
          return { ...s, authenticated: true, state: m.state, transferPending: null, sessionEnded: null }
        case "role_change":
          return { ...s, state: m.state }
        case "peers_update":
          return s.state ? { ...s, state: { ...s.state, peers: m.peers } } : s
        case "chat": {
          if (m.from === s.typingFrom) s = { ...s, typingFrom: null }
          const line: ChatLine = {
            id: nextId(),
            from: m.from,
            text: m.text,
            ts: m.ts,
            mine: m.mine,
          }
          const chat = [...s.chat, line].slice(-CHAT_MAX_HISTORY)
          return { ...s, chat }
        }
        case "typing":
          if (m.state === "stop") {
            return s.typingFrom === m.from ? { ...s, typingFrom: null } : s
          }
          return { ...s, typingFrom: m.from }
        case "host_leaving":
          return s.state ? { ...s, state: { ...s.state, leaving: "pending", grace_s: m.grace_s } } : s
        case "leave_cancelled":
          return s.state ? { ...s, state: { ...s.state, leaving: "none", grace_s: null } } : s
        case "session_ended":
          return {
            ...s,
            state: s.state ? { ...s.state, role: "idle", leaving: "none", peers: [], grace_s: null } : null,
            sessionEnded: m.reason,
            typingFrom: null,
          }
        case "transfer_start":
          return {
            ...s,
            transferPending: { new_code: m.new_code, new_url: m.new_url, new_handle: m.new_handle },
          }
        case "toast": {
          const t: Toast = { id: nextId(), message: m.message, variant: m.variant, title: m.title }
          return { ...s, toasts: [...s.toasts.slice(-3), t] }
        }
        case "goodbye":
          return s
      }
      return s
    }
  }
}

export type UseCompanionOptions = {
  clientOptions: CompanionClientOptions
  onCommand?: (name: string, args: string[]) => void
}

export function useCompanion(opts: UseCompanionOptions): {
  state: CompanionUiState
  client: CompanionClient
  send: (msg: CompanionClient extends never ? never : Parameters<CompanionClient["write"]>[0]) => void
} {
  const [state, dispatch] = useReducer(reducer, initial)
  const clientRef = useRef<CompanionClient | null>(null)
  const optsRef = useRef(opts)
  optsRef.current = opts

  useEffect(() => {
    const client = new CompanionClient(opts.clientOptions)
    clientRef.current = client
    client.on("open", () => dispatch({ type: "open" }))
    client.on("auth_fail", (...args) => {
      const reason = typeof args[0] === "string" ? args[0] : "unknown"
      dispatch({ type: "auth_fail", reason })
    })
    client.on("close", (...args) => {
      const hadError = args[0] === true
      dispatch({ type: "close", hadError })
    })
    client.on("message", (...args) => {
      const m = args[0] as PluginToCompanion
      dispatch({ type: "message", msg: m })
    })
    client.on("error", () => {
      // Errors are already surfaced via close; no-op.
    })
    client.connect()
    return () => {
      client.close()
      clientRef.current = null
    }
  }, [opts.clientOptions.socketPath, opts.clientOptions.token])

  const send = (msg: Parameters<CompanionClient["write"]>[0]) => {
    clientRef.current?.write(msg)
  }

  return { state, client: clientRef.current as CompanionClient, send }
}

export { loadTokenFromEnv }
