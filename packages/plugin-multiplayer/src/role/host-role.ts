import type { HostSocketData, PeerInfo } from "../types.ts"
import type { StateStore } from "../persistence/index.ts"
import type { Toaster } from "../bridge/index.ts"
import type { Logger } from "../bridge/index.ts"
import type { HostServerHandlers } from "../server/index.ts"
import { startHostServer } from "../server/index.ts"
import { mintCode, parseCode, assignCollisionSuffix, isValidCode } from "../handle/index.ts"
import { peerListForBroadcast } from "./peer-helpers.ts"
import type { RoleState } from "./role-state.ts"

export class HostRole implements RoleState {
  readonly kind = "host" as const

  private server: ReturnType<typeof Bun.serve> | null = null
  private code: string | null = null
  private handle: string
  private peers = new Map<Bun.ServerWebSocket<HostSocketData>, PeerInfo>()
  private volunteers = new Set<string>()

  constructor(
    private opts: {
      port: number
      host: string
      handle: string
      state: StateStore
      toaster: Toaster
      logger: Logger
    },
  ) {
    this.handle = opts.handle
  }

  getCode(): string | null {
    return this.code
  }

  getHandle(): string | null {
    return this.handle
  }

  getPeers(): Map<Bun.ServerWebSocket<HostSocketData>, PeerInfo> {
    return this.peers
  }

  acceptVolunteer(handle: string): void {
    this.volunteers.add(handle)
  }

  isVolunteer(handle: string): boolean {
    return this.volunteers.has(handle)
  }

  private takenHandles(): string[] {
    const out: string[] = []
    if (this.handle) out.push(this.handle)
    for (const p of this.peers.values()) {
      if (p.handle !== "__pending__") out.push(p.handle)
    }
    return out
  }

  broadcast(msg: { type: string; [key: string]: unknown }, except?: Bun.ServerWebSocket<HostSocketData>): void {
    for (const ws of this.peers.keys()) {
      if (except && ws === except) continue
      try {
        ws.send(JSON.stringify(msg))
      } catch { /* ignore */ }
    }
  }

  private broadcastPeersUpdate(): void {
    const peers = peerListForBroadcast(this.peers)
    this.broadcast({ type: "peers_update", peers })
  }

  private findPeerWs(handle: string): Bun.ServerWebSocket<HostSocketData> | null {
    for (const [ws, peer] of this.peers.entries()) {
      if (peer.handle === handle) return ws
    }
    return null
  }

  private sendToPeer(ws: { send(data: string): unknown }, msg: { type: string; [key: string]: unknown }): void {
    try {
      ws.send(JSON.stringify(msg))
    } catch { /* ignore */ }
  }

  private async onPeerClose(ws: Bun.ServerWebSocket<HostSocketData>): Promise<void> {
    if (ws.data.state === "authenticated") {
      const peer = ws.data.peer
      this.peers.delete(ws)
      if (peer.handle !== "__pending__") {
        this.volunteers.delete(peer.handle)
        await this.opts.logger.log("info", "peer disconnected", { handle: peer.handle })
        await this.opts.toaster.show(`peer disconnected (${peer.handle})`, "warning", "multiplayer")
        this.broadcastPeersUpdate()
      }
    }
  }

  private async onMessage(ws: Bun.ServerWebSocket<HostSocketData>, raw: string | Buffer): Promise<void> {
    const text = typeof raw === "string" ? raw : raw.toString("utf8")
    let msg: { type: string; [key: string]: unknown }
    try {
      msg = JSON.parse(text) as { type: string; [key: string]: unknown }
    } catch {
      this.sendToPeer(ws, { type: "auth_fail", reason: "invalid_json" })
      this.sendToPeer(ws, { type: "bye" })
      try { ws.close() } catch { /* ignore */ }
      return
    }

    if (ws.data.state === "awaiting_auth") {
      if (msg.type !== "auth") {
        this.sendToPeer(ws, { type: "auth_fail", reason: "expected_auth" })
        this.sendToPeer(ws, { type: "bye" })
        try { ws.close() } catch { /* ignore */ }
        return
      }
      const code = msg.code as string
      if (!isValidCode(code)) {
        this.sendToPeer(ws, { type: "auth_fail", reason: "invalid_code" })
        this.sendToPeer(ws, { type: "bye" })
        try { ws.close() } catch { /* ignore */ }
        await this.opts.toaster.show("guest sent an invalid code", "warning", "multiplayer")
        return
      }
      const normalized = code.toLowerCase()
      const isCurrent = this.code !== null && normalized === this.code
      const isGrace = !isCurrent
      if (!isCurrent && !isGrace) {
        this.sendToPeer(ws, { type: "auth_fail", reason: "unknown_code" })
        this.sendToPeer(ws, { type: "bye" })
        try { ws.close() } catch { /* ignore */ }
        return
      }
      const peer: PeerInfo = { handle: "__pending__", joinedAt: Date.now(), isVolunteer: false }
      ws.data = { state: "authenticated", peer }
      this.peers.set(ws, peer)
      this.sendToPeer(ws, { type: "auth_ok", handle: this.handle ?? "host" })
      this.sendToPeer(ws, {
        type: "welcome",
        handle: this.handle ?? "host",
        peers: peerListForBroadcast(this.peers),
      })
      return
    }

    // authenticated
    if (msg.type === "hello") {
      const requested = (msg.handle as string ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 16)
      const peer = ws.data.peer
      const existing = this.takenHandles()
      let assigned = requested
      if (existing.includes(assigned)) {
        assigned = assignCollisionSuffix(requested, existing)
      }
      peer.handle = assigned
      await this.opts.logger.log("info", "peer connected", { guestHandle: assigned })
      await this.opts.toaster.show(`✓ peer connected (${assigned})`, "success", "multiplayer")
      this.broadcastPeersUpdate()
      return
    }

    if (msg.type === "volunteer") {
      const peer = ws.data.peer
      if (peer.handle === "__pending__") return
      peer.isVolunteer = true
      this.volunteers.add(peer.handle)
      await this.opts.logger.log("info", "peer volunteered", { handle: peer.handle })
      await this.opts.toaster.show(`volunteer accepted (${peer.handle})`, "info", "multiplayer")
      return
    }

    if (msg.type === "bye") {
      return
    }

    await this.opts.logger.log("warn", "host: unexpected message", { msg, state: ws.data.state })
  }

  async start(): Promise<{ ok: true; code: string; url: string } | { ok: false; reason: string }> {
    this.code = mintCode(this.handle)
    const code = this.code
    const url = `ws://${this.opts.host}:${this.opts.port}`

    const handlers: HostServerHandlers = {
      onMessage: (ws, raw) => { void this.onMessage(ws, raw) },
      onClose: (ws) => { void this.onPeerClose(ws) },
    }

    const result = await startHostServer({ port: this.opts.port, host: this.opts.host, handlers })
    if (!result.ok) {
      this.code = null
      this.handle = ""
      if (result.reason.startsWith("port_")) {
        await this.opts.logger.log("warn", "host start failed: port in use", { port: this.opts.port })
      } else {
        await this.opts.logger.log("error", "host start failed", { error: result.reason })
      }
      return { ok: false, reason: result.reason }
    }

    this.server = result.server
    await this.opts.state.recordHostStarted(this.handle, code)
    await this.opts.logger.log("info", "host started", { handle: this.handle, port: this.opts.port, code, url })
    await this.opts.toaster.show(`invite: ${code}`, "success", "multiplayer")
    await this.opts.toaster.show(`hosting on ${url}`, "info", "multiplayer")
    return { ok: true, code, url }
  }

  stop(): void {
    if (this.server) {
      try { this.server.stop(true) } catch { /* ignore */ }
      this.server = null
    }
    this.code = null
    this.handle = ""
    this.peers = new Map()
    this.volunteers = new Set()
  }

  dispose(): void {
    this.stop()
  }
}
