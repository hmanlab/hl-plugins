import type { StateStore } from "../persistence/index.ts"
import type { Toaster } from "../bridge/index.ts"
import type { Logger } from "../bridge/index.ts"
import { JOIN_TIMEOUT_MS } from "../constants.ts"
import { startHostServer } from "../server/index.ts"
import type { PeerInfo } from "../types.ts"
import type { WireMessage } from "../protocol/index.ts"
import type { RoleState } from "./role-state.ts"

export type DialResult =
  | { ok: true; hostHandle: string; myHandle: string }
  | { ok: false; reason: string; transferTo?: { new_code: string; new_url: string; new_handle: string } }

export type TransferToMeMsg = Extract<WireMessage, { type: "transfer_to_me" }>

export type PromoteResult = { ok: true; newCode: string; newUrl: string } | { ok: false; reason: string }

export class GuestRole implements RoleState {
  readonly kind = "guest" as const

  private ws: WebSocket | null = null
  private hostHandle: string | null = null
  private myHandle: string | null = null
  private hostUrl: string | null = null
  private endedReason: string | null = null
  private reconnectFn: ((newCode: string, newUrl: string) => Promise<void>) | null = null
  private peerList: { handle: string; joinedAt: number }[] = []

  constructor(
    private opts: {
      port: number
      host: string
      handle: string
      state: StateStore
      toaster: Toaster
      logger: Logger
      promote?: (msg: TransferToMeMsg, oldHostWs: WebSocket, oldHostUrl: string) => Promise<PromoteResult>
      reconnect?: (newCode: string, newUrl: string) => Promise<void>
      ended?: (reason: string) => void
      onPeersChanged?: (peers: { handle: string; joinedAt: number }[]) => void
      onChatReceived?: (msg: { from: string; text: string; ts: number }) => void
      onTypingReceived?: (from: string, state: "start" | "stop") => void
      onStateChange?: (state: "joining" | "joined" | "leaving" | "left" | "transferring") => void
    },
  ) {}

  getHostHandle(): string | null {
    return this.hostHandle
  }

  getMyHandle(): string | null {
    return this.myHandle
  }

  getHostUrl(): string | null {
    return this.hostUrl
  }

  getPeerList(): { handle: string; joinedAt: number }[] {
    return this.peerList
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  getWs(): WebSocket | null {
    return this.ws
  }

  getEndedReason(): string | null {
    return this.endedReason
  }

  async dial(code: string, mode: "join" | "rejoin"): Promise<DialResult> {
    const wsUrl = `ws://${this.opts.host}:${this.opts.port}`
    const ws = new WebSocket(wsUrl)
    this.ws = ws

    return await new Promise((resolve) => {
      let resolved = false
      const finish = (result: DialResult) => {
        if (resolved) return
        resolved = true
        resolve(result)
      }

      const timeout = setTimeout(() => {
        try {
          ws.close()
        } catch {
          /* ignore */
        }
        void this.opts.toaster.show(`join timed out (no host at ${wsUrl})`, "error", "multiplayer")
        void this.opts.logger.log("warn", "guest dial timed out", { code, wsUrl })
        finish({ ok: false, reason: "timeout" })
      }, JOIN_TIMEOUT_MS)

      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ type: "auth", code: code.toLowerCase() }))
      })

      ws.addEventListener("message", async (e) => {
        let msg: { type: string; [key: string]: unknown }
        try {
          msg = JSON.parse((e as MessageEvent).data as string) as { type: string; [key: string]: unknown }
        } catch {
          return
        }

        if (msg.type === "auth_fail") {
          clearTimeout(timeout)
          try {
            ws.close()
          } catch {
            /* ignore */
          }
          await this.opts.toaster.show(`join failed: ${msg.reason}`, "error", "multiplayer")
          await this.opts.logger.log("info", "guest auth rejected", { reason: msg.reason })
          finish({ ok: false, reason: msg.reason as string })
          return
        }

        if (msg.type === "auth_ok") {
          return
        }

        if (msg.type === "welcome") {
          ws.send(JSON.stringify({ type: "hello", handle: this.opts.handle }))
          this.ws = ws
          this.hostHandle = msg.handle as string
          this.hostUrl = wsUrl
          this.myHandle = this.opts.handle
          this.peerList = Array.isArray((msg as { peers?: unknown }).peers)
            ? (msg as unknown as { peers: { handle: string; joinedAt: number }[] }).peers.filter(
                (p) => p && typeof p.handle === "string" && typeof p.joinedAt === "number",
              )
            : []
          clearTimeout(timeout)
          await this.opts.logger.log("info", "guest joined", {
            hostHandle: msg.handle,
            requestedHandle: this.opts.handle,
            mode,
          })
          if (mode === "rejoin") {
            await this.opts.toaster.show(
              `✓ rejoined as guest (${this.opts.handle})`,
              "success",
              "multiplayer",
            )
          } else {
            await this.opts.toaster.show(`✓ connected to ${msg.handle}`, "success", "multiplayer")
          }
          await this.opts.state.recordGuestJoined(this.opts.handle, wsUrl)
          finish({ ok: true, hostHandle: msg.handle as string, myHandle: this.opts.handle })
          return
        }

        if (msg.type === "peers_update") {
          this.peerList = Array.isArray((msg as { peers?: unknown }).peers)
            ? (msg as unknown as { peers: { handle: string; joinedAt: number }[] }).peers.filter(
                (p) => p && typeof p.handle === "string" && typeof p.joinedAt === "number",
              )
            : []
          this.opts.onPeersChanged?.(this.peerList)
          return
        }

        if (msg.type === "host_leaving") {
          await this.opts.toaster.show(`host leaving in ${msg.grace_s}s`, "warning", "multiplayer")
          return
        }

        if (msg.type === "chat") {
          const m = msg as unknown as { text?: unknown; from?: unknown; ts?: unknown }
          const text = typeof m.text === "string" ? m.text : ""
          const from = typeof m.from === "string" ? m.from : (this.hostHandle ?? "host")
          const ts = typeof m.ts === "number" ? m.ts : Date.now()
          const truncated = text.length > 200 ? text.slice(0, 200) + "…" : text
          await this.opts.toaster.show(`${from}: ${truncated}`, "info", "chat")
          await this.opts.logger.log("debug", "guest: chat received", { from, len: text.length })
          this.opts.onChatReceived?.({ from, text, ts })
          return
        }

        if (msg.type === "typing") {
          const m = msg as unknown as { state?: unknown; from?: unknown }
          const state = m.state === "stop" ? "stop" : "start"
          const from = typeof m.from === "string" ? m.from : (this.hostHandle ?? "host")
          if (state === "start") {
            await this.opts.toaster.show(`${from} is typing…`, "info", "chat")
          }
          this.opts.onTypingReceived?.(from, state)
          return
        }

        if (msg.type === "leave_cancelled") {
          await this.opts.toaster.show("host cancelled leave", "info", "multiplayer")
          return
        }

        if (msg.type === "transfer_to_me") {
          // We are the chosen successor. Promote to host, mint a
          // new code, start our own host server, then send
          // transfer_confirmed back to the old host.
          if (!this.opts.promote) return
          if (!this.ws) return
          const oldWs = this.ws
          const oldUrl = this.hostUrl ?? ""
          clearTimeout(timeout)
          const result = await this.opts.promote(msg as unknown as TransferToMeMsg, oldWs, oldUrl)
          if (result.ok) {
            try {
              oldWs.send(
                JSON.stringify({
                  type: "transfer_confirmed",
                  new_code: result.newCode,
                  new_url: result.newUrl,
                }),
              )
            } catch {
              /* ignore */
            }
            try {
              oldWs.close()
            } catch {
              /* ignore */
            }
          } else {
            try {
              oldWs.send(
                JSON.stringify({
                  type: "transfer_failed",
                  reason: result.reason,
                }),
              )
            } catch {
              /* ignore */
            }
            try {
              oldWs.close()
            } catch {
              /* ignore */
            }
            this.opts.ended?.(`promote_failed: ${result.reason}`)
            this.ws = null
            this.hostHandle = null
            this.myHandle = null
            this.hostUrl = null
            await this.opts.toaster.show(`promotion failed: ${result.reason}`, "error", "multiplayer")
          }
          return
        }

        if (msg.type === "transfer_start") {
          // Close old WS and dial the new host with the new code.
          clearTimeout(timeout)
          if (this.ws) {
            try {
              this.ws.close()
            } catch {
              /* ignore */
            }
            this.ws = null
          }
          const oldUrl = this.hostUrl ?? ""
          const newHandle = typeof msg.new_handle === "string" ? msg.new_handle : "host"
          const newUrl = typeof msg.new_url === "string" ? msg.new_url : oldUrl
          const newCode = typeof msg.new_code === "string" ? msg.new_code : ""
          await this.opts.toaster.show(`transferring to ${newHandle} (${newUrl})`, "info", "multiplayer")
          if (this.opts.reconnect && newCode) {
            await this.opts.reconnect(newCode, newUrl)
          }
          return
        }

        if (msg.type === "session_ended") {
          clearTimeout(timeout)
          if (this.ws) {
            try {
              this.ws.close()
            } catch {
              /* ignore */
            }
            this.ws = null
          }
          this.hostHandle = null
          this.myHandle = null
          this.hostUrl = null
          const reason = typeof msg.reason === "string" ? msg.reason : "unknown"
          this.endedReason = reason
          await this.opts.toaster.show(`session ended: ${reason}`, "warning", "multiplayer")
          this.opts.ended?.(reason)
          return
        }
      })

      ws.addEventListener("close", async () => {
        if (resolved) return
        clearTimeout(timeout)
        await this.opts.toaster.show(`could not reach host at ${wsUrl}`, "error", "multiplayer")
        await this.opts.logger.log("error", "guest ws closed before completion", { wsUrl })
        finish({ ok: false, reason: "closed" })
      })

      ws.addEventListener("error", async () => {
        if (resolved) return
        clearTimeout(timeout)
        await this.opts.toaster.show(`could not reach host at ${wsUrl}`, "error", "multiplayer")
        await this.opts.logger.log("error", "guest ws error", { wsUrl })
        finish({ ok: false, reason: "error" })
      })
    })
  }

  sendVolunteer(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "volunteer" }))
    }
  }

  sendChat(text: string): { ok: true; ts: number } | { ok: false; reason: string } {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return { ok: false, reason: "not_connected" }
    }
    const trimmed = text.trim()
    if (trimmed.length === 0) return { ok: false, reason: "empty" }
    if (trimmed.length > 4000) return { ok: false, reason: "too_long" }
    const ts = Date.now()
    const handle = this.myHandle ?? this.opts.handle
    this.ws.send(JSON.stringify({ type: "chat", from: handle, text: trimmed, ts }))
    return { ok: true, ts }
  }

  sendTyping(state: "start" | "stop"): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const handle = this.myHandle ?? this.opts.handle
    this.ws.send(JSON.stringify({ type: "typing", from: handle, state }))
  }

  leave(): void {
    if (this.ws) {
      try {
        this.ws.send(JSON.stringify({ type: "bye" }))
      } catch {
        /* ignore */
      }
      try {
        this.ws.close()
      } catch {
        /* ignore */
      }
    }
    this.ws = null
    this.hostHandle = null
    this.myHandle = null
    this.hostUrl = null
  }

  dispose(): void {
    this.leave()
  }
}
