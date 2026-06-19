import type { StateStore } from "../persistence/index.ts"
import type { Toaster } from "../bridge/index.ts"
import type { Logger } from "../bridge/index.ts"
import { JOIN_TIMEOUT_MS } from "../constants.ts"
import { startHostServer } from "../server/index.ts"
import type { PeerInfo } from "../types.ts"
import type { WireMessage } from "../protocol/index.ts"

export type DialResult =
  | { ok: true; hostHandle: string; myHandle: string }
  | { ok: false; reason: string; transferTo?: { new_code: string; new_url: string; new_handle: string } }

export class GuestRole {
  readonly kind = "guest" as const

  private ws: WebSocket | null = null
  private hostHandle: string | null = null
  private myHandle: string | null = null
  private hostUrl: string | null = null

  constructor(
    private opts: {
      port: number
      host: string
      handle: string
      state: StateStore
      toaster: Toaster
      logger: Logger
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

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  getWs(): WebSocket | null {
    return this.ws
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
        try { ws.close() } catch { /* ignore */ }
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
        } catch { return }

        if (msg.type === "auth_fail") {
          clearTimeout(timeout)
          try { ws.close() } catch { /* ignore */ }
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
          clearTimeout(timeout)
          await this.opts.logger.log("info", "guest joined", { hostHandle: msg.handle, requestedHandle: this.opts.handle, mode })
          if (mode === "rejoin") {
            await this.opts.toaster.show(`✓ rejoined as guest (${this.opts.handle})`, "success", "multiplayer")
          } else {
            await this.opts.toaster.show(`✓ connected to ${msg.handle}`, "success", "multiplayer")
          }
          await this.opts.state.recordGuestJoined(this.opts.handle, wsUrl)
          finish({ ok: true, hostHandle: msg.handle as string, myHandle: this.opts.handle })
          return
        }

        if (msg.type === "host_leaving") {
          await this.opts.toaster.show(`host leaving in ${msg.grace_s}s`, "warning", "multiplayer")
          return
        }

        if (msg.type === "leave_cancelled") {
          await this.opts.toaster.show("host cancelled leave", "info", "multiplayer")
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

  leave(): void {
    if (this.ws) {
      try { this.ws.send(JSON.stringify({ type: "bye" })) } catch { /* ignore */ }
      try { this.ws.close() } catch { /* ignore */ }
    }
    this.ws = null
    this.hostHandle = null
    this.myHandle = null
    this.hostUrl = null
  }
}
