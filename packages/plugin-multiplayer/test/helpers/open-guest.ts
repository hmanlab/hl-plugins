import type { Captured } from "./context.ts"

export type GuestMessage =
  | { type: "auth_fail"; reason: string }
  | { type: "auth_ok"; handle: string }
  | { type: "welcome"; handle: string; peers: { handle: string; joinedAt: number }[] }
  | { type: "peers_update"; peers: { handle: string; joinedAt: number }[] }
  | { type: "host_leaving"; grace_s: number }
  | { type: "leave_cancelled" }
  | {
      type: "transfer_to_me"
      new_handle: string
      old_code: string
      old_handle: string
      peers: { handle: string; joinedAt: number }[]
    }
  | { type: "transfer_confirmed"; new_code: string; new_url: string }
  | { type: "transfer_failed"; reason: string }
  | { type: "transfer_start"; new_code: string; new_url: string; new_handle: string }
  | { type: "session_ended"; reason: string }
  | { type: "chat"; from: string; text: string; ts: number }
  | { type: "typing"; from: string; state: "start" | "stop" }
  | { type: "bye" }

export type GuestHandle = {
  ws: WebSocket
  messages: GuestMessage[]
  close: () => void
}

export async function openGuest(port: number, code: string, requestedHandle: string): Promise<GuestHandle> {
  const messages: GuestMessage[] = []
  const ws = new WebSocket(`ws://localhost:${port}`)
  return await new Promise((resolve, reject) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve({
        ws,
        messages,
        close: () => {
          try {
            ws.close()
          } catch {
            /* ignore */
          }
        },
      })
    }
    const fail = (err: Error) => {
      if (done) return
      done = true
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      reject(err)
    }
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "auth", code }))
    })
    ws.addEventListener("message", (e) => {
      let msg: GuestMessage
      try {
        msg = JSON.parse((e as MessageEvent).data as string) as GuestMessage
      } catch {
        return
      }
      messages.push(msg)
      if (msg.type === "welcome") {
        ws.send(JSON.stringify({ type: "hello", handle: requestedHandle }))
        setTimeout(finish, 30)
      }
    })
    ws.addEventListener("error", () => fail(new Error("ws error")))
    setTimeout(() => fail(new Error("guest dial timeout")), 3000)
  })
}

export function drainAfter(handle: GuestHandle, after: number): GuestMessage[] {
  return handle.messages.slice(after)
}
