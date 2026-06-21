import { CHAT_MAX_TEXT } from "../constants.ts"

export type Peer = { handle: string; joinedAt: number }

export type ChatMessage = { type: "chat"; from: string; text: string; ts: number }
export type TypingMessage = { type: "typing"; from: string; state: "start" | "stop" }

export type WireMessage =
  | { type: "auth"; code: string }
  | { type: "auth_ok"; handle: string }
  | { type: "auth_fail"; reason: string }
  | { type: "hello"; handle: string }
  | { type: "welcome"; handle: string; peers: Peer[] }
  | { type: "peers_update"; peers: Peer[] }
  | { type: "host_leaving"; grace_s: number }
  | { type: "volunteer" }
  | { type: "leave_cancelled" }
  | { type: "transfer_to_me"; new_handle: string; old_code: string; old_handle: string; peers: Peer[] }
  | { type: "transfer_confirmed"; new_code: string; new_url: string }
  | { type: "transfer_failed"; reason: string }
  | { type: "transfer_start"; new_code: string; new_url: string; new_handle: string }
  | { type: "session_ended"; reason: string }
  | ChatMessage
  | TypingMessage
  | { type: "bye" }

export { CHAT_MAX_TEXT, CHAT_MAX_HISTORY } from "../constants.ts"

export function isWireMessage(x: unknown): x is WireMessage {
  if (typeof x !== "object" || x === null) return false
  const m = x as { type?: unknown }
  if (typeof m.type !== "string") return false
  switch (m.type) {
    case "auth":
      return typeof (x as { code?: unknown }).code === "string"
    case "auth_ok":
    case "welcome":
      return typeof (x as { handle?: unknown }).handle === "string"
    case "auth_fail":
    case "session_ended":
      return typeof (x as { reason?: unknown }).reason === "string"
    case "hello":
      return typeof (x as { handle?: unknown }).handle === "string"
    case "peers_update":
      return Array.isArray((x as { peers?: unknown }).peers)
    case "host_leaving":
      return typeof (x as { grace_s?: unknown }).grace_s === "number"
    case "volunteer":
    case "leave_cancelled":
    case "bye":
      return true
    case "transfer_to_me":
      return (
        typeof (x as { new_handle?: unknown }).new_handle === "string" &&
        typeof (x as { old_code?: unknown }).old_code === "string" &&
        typeof (x as { old_handle?: unknown }).old_handle === "string" &&
        Array.isArray((x as { peers?: unknown }).peers)
      )
    case "transfer_confirmed":
      return (
        typeof (x as { new_code?: unknown }).new_code === "string" &&
        typeof (x as { new_url?: unknown }).new_url === "string"
      )
    case "transfer_failed":
      return typeof (x as { reason?: unknown }).reason === "string"
    case "transfer_start":
      return (
        typeof (x as { new_code?: unknown }).new_code === "string" &&
        typeof (x as { new_url?: unknown }).new_url === "string" &&
        typeof (x as { new_handle?: unknown }).new_handle === "string"
      )
    case "chat": {
      const v = x as { from?: unknown; text?: unknown; ts?: unknown }
      return (
        typeof v.from === "string" &&
        typeof v.text === "string" &&
        v.text.length > 0 &&
        v.text.length <= CHAT_MAX_TEXT &&
        typeof v.ts === "number"
      )
    }
    case "typing": {
      const v = x as { from?: unknown; state?: unknown }
      return typeof v.from === "string" && (v.state === "start" || v.state === "stop")
    }
    default:
      return false
  }
}
