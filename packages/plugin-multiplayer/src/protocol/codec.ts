import type { WireMessage } from "./messages.ts"

export function encode(msg: WireMessage): string {
  return JSON.stringify(msg)
}

export function decode(raw: string): WireMessage | null {
  try {
    const x: unknown = JSON.parse(raw)
    return x as WireMessage
  } catch {
    return null
  }
}

export function safeSend(ws: { send(data: string): unknown }, msg: WireMessage): void {
  try {
    ws.send(encode(msg))
  } catch {
    // ignore
  }
}