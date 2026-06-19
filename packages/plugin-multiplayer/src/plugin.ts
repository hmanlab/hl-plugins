import type { PluginInput } from "@opencode-ai/plugin"
import { Toaster, Logger } from "./bridge/index.ts"
import { StateStore, readHandleFileSync } from "./persistence/index.ts"
import { resolvePort, resolveHost } from "./env/index.ts"
import { IdleRole, HostRole, GuestRole, TransferController, type RoleState } from "./role/index.ts"
import { isValidHandle, normalizeHandle, osUser, mintCode, isValidCode, assignCollisionSuffix } from "./handle/index.ts"
import { GRACE_S, CASCADE_TIMEOUT_MS, DEFAULT_PORT, DEFAULT_HOST } from "./constants.ts"
import { peerListForBroadcast } from "./role/peer-helpers.ts"
import type { PeerInfo, Role, HostSocketData } from "./types.ts"
import type { WireMessage } from "./protocol/index.ts"
import { startHostServer } from "./server/index.ts"

export type { PluginInput } from "@opencode-ai/plugin"

export class MultiplayerPlugin {
  readonly toaster: Toaster
  readonly logger: Logger
  readonly store: StateStore

  role: Role = "idle"
  roleState: RoleState
  port = DEFAULT_PORT
  hostAddr = `${DEFAULT_HOST}:${DEFAULT_PORT}`
  hostServer: ReturnType<typeof Bun.serve> | null = null
  hostCode: string | null = null
  hostHandle: string | null = null
  hostPeers = new Map<Bun.ServerWebSocket<HostSocketData>, PeerInfo>()
  volunteers = new Set<string>()
  hostRole: HostRole | null = null
  guestRole: GuestRole | null = null

  guestWs: WebSocket | null = null
  guestHostHandle: string | null = null
  guestMyHandle: string | null = null
  guestHostUrl: string | null = null

  myResolvedHandle: string | null = null
  tc: TransferController | null = null

  constructor(toaster: Toaster, logger: Logger, store: StateStore) {
    this.toaster = toaster
    this.logger = logger
    this.store = store
    this.roleState = new IdleRole(this.deps)
  }

  get deps() {
    return {
      handle: this.resolveHandle(),
      port: this.port,
      hostAddr: this.hostAddr,
      store: this.store,
      toaster: this.toaster,
      logger: this.logger,
    }
  }

  resolveHandle(): string {
    if (this.myResolvedHandle) return this.myResolvedHandle
    const envHandle = process.env["MP_HANDLE"]
    if (envHandle) {
      const norm = normalizeHandle(envHandle)
      if (norm.length > 0 && isValidHandle(norm)) {
        this.myResolvedHandle = norm
        return norm
      }
    }
    const persisted = readHandleFileSync()
    if (persisted) {
      this.myResolvedHandle = persisted
      return persisted
    }
    const fallback = normalizeHandle(osUser()) || "anon"
    this.myResolvedHandle = fallback
    return fallback
  }

  private takenHandles(): string[] {
    const out: string[] = []
    if (this.hostHandle) out.push(this.hostHandle)
    for (const p of (this.hostRole?.getPeers() ?? this.hostPeers).values()) {
      if (p.handle !== "__pending__") out.push(p.handle)
    }
    return out
  }

  private sendToPeer(ws: { send(data: string): unknown }, msg: WireMessage): void {
    try {
      ws.send(JSON.stringify(msg))
    } catch {
      // ignore
    }
  }

  private broadcastPeersUpdate(): void {
    if (this.hostRole) {
      const peers = peerListForBroadcast(this.hostRole.getPeers())
      this.hostRole.broadcast({ type: "peers_update", peers })
    }
  }

  private findPeerWs(handle: string): Bun.ServerWebSocket<HostSocketData> | null {
    const peers = this.hostRole?.getPeers() ?? this.hostPeers
    for (const [ws, peer] of peers.entries()) {
      if (peer.handle === handle) return ws
    }
    return null
  }

  private resetToIdleRole(): void {
    this.role = "idle"
    this.roleState = new IdleRole(this.deps)
  }

  private setRoleHost(hr: HostRole): void {
    this.role = "host"
    this.roleState = hr
  }

  private setRoleGuest(gr: GuestRole): void {
    this.role = "guest"
    this.roleState = gr
  }

  private cleanup(): void {
    this.tc?.reset()
    this.volunteers = new Set()

    if (this.hostRole) {
      this.hostRole.stop()
      this.hostRole = null
    }
    try {
      this.hostServer?.stop(true)
    } catch {
      // ignore
    }
    this.hostServer = null
    this.hostCode = null
    this.hostHandle = null
    this.hostPeers = new Map()

    try {
      if (this.guestWs && this.guestWs.readyState === WebSocket.OPEN) {
        try {
          this.guestWs.send(JSON.stringify({ type: "bye" }))
        } catch {
          // ignore
        }
        this.guestWs.close()
      }
    } catch {
      // ignore
    }
    this.guestRole?.leave()
    this.guestRole = null
    this.guestWs = null
    this.guestHostHandle = null
    this.guestMyHandle = null
    this.guestHostUrl = null
    this.resetToIdleRole()
  }

  async mpHost(): Promise<string> {
    const handle = this.resolveHandle()
    const bindPort = resolvePort()
    const bindHost = resolveHost()
    const result = await this.startHost(handle, bindPort, bindHost)
    if (result.ok) {
      return `Hosting on ${result.url}\nInvite code: ${result.code}\nShare the code with your peer. They run: mp_join ${result.code}\n(mp_status shows the current peers and leaving state.)`
    }
    if (result.reason.startsWith("port_") && result.reason.endsWith("_busy")) {
      const busyPort = result.reason.replace(/^port_/, "").replace(/_busy$/, "")
      return `Port ${busyPort} is already in use. Try a different port by setting MP_PORT before launching opencode, e.g.\n  MP_PORT=${busyPort === "7332" ? "8332" : String(Number(busyPort) + 1)} opencode`
    }
    return `Could not start host: ${result.reason}`
  }

  private async startHost(
    handle: string,
    bindPort: number,
    bindHost: string,
  ): Promise<{ ok: true; code: string; url: string } | { ok: false; reason: string }> {
    if (this.roleState.kind !== "idle") {
      return { ok: false, reason: `not_idle (currently ${this.roleState.kind})` }
    }

    const hr = new HostRole({ port: bindPort, host: bindHost, handle, state: this.store, toaster: this.toaster, logger: this.logger })
    const result = await hr.start()

    if (!result.ok) {
      return result
    }

    this.hostRole = hr
    this.hostServer = null
    this.hostCode = result.code
    this.hostHandle = handle
    this.setRoleHost(hr)
    this.port = bindPort
    this.hostAddr = `${bindHost}:${bindPort}`
    return result
  }

  private async handleHostMessage(
    ws: Bun.ServerWebSocket<HostSocketData>,
    raw: string | Buffer,
  ): Promise<void> {
    const text = typeof raw === "string" ? raw : raw.toString("utf8")
    let msg: WireMessage
    try {
      msg = JSON.parse(text) as WireMessage
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
      if (!isValidCode(msg.code)) {
        this.sendToPeer(ws, { type: "auth_fail", reason: "invalid_code" })
        this.sendToPeer(ws, { type: "bye" })
        try { ws.close() } catch { /* ignore */ }
        await this.toaster.show("guest sent an invalid code", "warning", "multiplayer")
        return
      }
      const normalized = msg.code.toLowerCase()
      const isCurrent = this.hostCode !== null && normalized === this.hostCode
      const isGrace = !isCurrent
      if (!isCurrent && !isGrace) {
        this.sendToPeer(ws, { type: "auth_fail", reason: "unknown_code" })
        this.sendToPeer(ws, { type: "bye" })
        try { ws.close() } catch { /* ignore */ }
        return
      }
      const peer: PeerInfo = { handle: "__pending__", joinedAt: Date.now(), isVolunteer: false }
      ws.data = { state: "authenticated", peer }
      this.hostPeers.set(ws, peer)

      this.sendToPeer(ws, { type: "auth_ok", handle: this.hostHandle ?? "host" })
      this.sendToPeer(ws, {
        type: "welcome",
        handle: this.hostHandle ?? "host",
        peers: peerListForBroadcast(this.hostRole?.getPeers() ?? this.hostPeers),
      })
      return
    }

    if (msg.type === "hello") {
      const requested = normalizeHandle(msg.handle)
      if (!isValidHandle(requested)) {
        this.sendToPeer(ws, { type: "auth_fail", reason: "invalid_handle" })
        this.sendToPeer(ws, { type: "bye" })
        try { ws.close() } catch { /* ignore */ }
        return
      }
      const peer = ws.data.peer
      const existing = this.takenHandles()
      let assigned = requested
      if (existing.includes(assigned)) {
        assigned = assignCollisionSuffix(requested, existing)
      }
      peer.handle = assigned
      await this.logger.log("info", "peer connected", { guestHandle: assigned })
      await this.toaster.show(`✓ peer connected (${assigned})`, "success", "multiplayer")
      this.broadcastPeersUpdate()
      return
    }

    if (msg.type === "volunteer") {
      const peer = ws.data.peer
      if (peer.handle === "__pending__") return
      peer.isVolunteer = true
      await this.logger.log("info", "peer volunteered", { handle: peer.handle })
      await this.toaster.show(`volunteer accepted (${peer.handle})`, "info", "multiplayer")
      return
    }

    if (msg.type === "transfer_confirmed") {
      await this.tc?.onTransferConfirmed(ws, msg.new_code, msg.new_url)
      return
    }

    if (msg.type === "transfer_failed") {
      await this.tc?.onTransferFailed(msg.reason)
      return
    }

    if (msg.type === "bye") {
      return
    }

    await this.logger.log("warn", "host: unexpected message", { msg, state: ws.data.state })
  }

  private async handleHostClose(ws: Bun.ServerWebSocket<HostSocketData>): Promise<void> {
    if (ws.data.state === "authenticated") {
      const peer = ws.data.peer
      this.hostPeers.delete(ws)
      if (peer.handle !== "__pending__") {
        this.volunteers.delete(peer.handle)
        await this.logger.log("info", "peer disconnected", { handle: peer.handle })
        await this.toaster.show(`peer disconnected (${peer.handle})`, "warning", "multiplayer")
        this.broadcastPeersUpdate()
      }
    }
  }

  async mpJoin(code: string): Promise<string> {
    if (this.role !== "idle") {
      return `Not idle (currently ${this.role}). Use mp_leave first.`
    }
    if (!isValidCode(code)) {
      return "Invalid code format. Expected `mp-<handle>-XXXX-XXXX`."
    }
    const handle = this.resolveHandle()
    const gr = new GuestRole({ port: this.port, host: resolveHost(), handle, state: this.store, toaster: this.toaster, logger: this.logger })
    const result = await gr.dial(code, "join")
    if (result.ok) {
      this.guestRole = gr
      this.guestWs = gr.getWs()
      this.setRoleGuest(gr)
      return `Connected to ${result.hostHandle}. You are ${result.myHandle} in the session.`
    }
    if (result.reason === "timeout") {
      return `No host responded at ws://${resolveHost()}:${this.port}. Is the host's opencode running, and are both using the same MP_HOST/MP_PORT?`
    }
    return `Join failed: ${result.reason}`
  }

  async mpLeave(): Promise<string> {
    if (this.role === "host") {
      await this.tc?.startLeave()
      return `Leaving in ${GRACE_S}s — auto-transfer pending. Use mp_cancel_leave to abort, or mp_volunteer (as a guest) to opt in as next host.`
    }
    if (this.role === "guest") {
      this.guestRole?.leave()
      this.guestRole = null
      this.resetToIdleRole()
      return "Left the session."
    }
    return "Not in a session."
  }

  async mpCancelLeave(): Promise<string> {
    if (this.role !== "host") return "Only the host can cancel a leave."
    if (this.tc?.getState() !== "pending") return "No leave is pending."
    await this.tc?.cancelLeave()
    return "Leave cancelled. Staying as host."
  }

  mpVolunteer(): string {
    if (this.role !== "guest") return "Only guests can volunteer."
    if (!this.guestRole?.isConnected()) return "Not connected."
    this.guestRole.sendVolunteer()
    return "Volunteered as next host candidate."
  }

  mpCode(): string {
    if (this.role === "host") return this.hostCode ?? "(no code)"
    if (this.role === "guest") return this.guestRole?.getHostHandle() ? `host handle: ${this.guestRole.getHostHandle()}` : "(unknown)"
    return "Not in a session. Use mp_host or mp_join first."
  }

  mpStatus(): string {
    if (this.role === "host") {
      const lines: string[] = []
      lines.push(`role: host`)
      lines.push(`port: ${this.port}`)
      lines.push(`url: ws://${this.hostAddr}`)
      lines.push(`invite: ${this.hostRole?.getCode() ?? this.hostCode ?? "(none)"}`)
      lines.push(`handle: ${this.hostRole?.getHandle() ?? this.hostHandle ?? "(none)"}`)
      const peersMap = this.hostRole?.getPeers() ?? this.hostPeers
      const peers = peerListForBroadcast(peersMap)
      if (peers.length === 0) {
        lines.push(`peers: (none)`)
      } else {
        lines.push(`peers (${peers.length}):`)
        for (const p of peers) {
          const v = this.hostRole?.isVolunteer(p.handle) ? " [volunteer]" : ""
          lines.push(`  - ${p.handle} (joined ${Math.round((Date.now() - p.joinedAt) / 1000)}s ago)${v}`)
        }
      }
      if (this.tc?.isPending()) {
        lines.push(`leaving: ${this.tc.getState()}`)
      }
      return lines.join("\n")
    }
    if (this.role === "guest") {
      const connected = this.guestRole?.isConnected() ? "yes" : "no"
      return [
        `role: guest`,
        `connected: ${connected}`,
        `port: ${this.port}`,
        `host: ${this.guestRole?.getHostHandle() ?? "(unknown)"}`,
        `me: ${this.guestRole?.getMyHandle() ?? this.resolveHandle()}`,
        `host url: ${this.guestRole?.getHostUrl() ?? `ws://${this.hostAddr}`}`,
      ].join("\n")
    }
    return `role: idle\nport: ${this.port}\nhost: ${this.hostAddr}\nhandle: ${this.resolveHandle()}\nurl: ws://${this.hostAddr}`
  }

  async mpRejoin(code: string): Promise<string> {
    if (this.role !== "idle") {
      return `Not idle (currently ${this.role}). Use mp_leave first.`
    }
    if (!isValidCode(code)) {
      return "Invalid code format. Expected `mp-<handle>-XXXX-XXXX`."
    }
    const handle = this.resolveHandle()
    const gr = new GuestRole({ port: this.port, host: resolveHost(), handle, state: this.store, toaster: this.toaster, logger: this.logger })
    const result = await gr.dial(code, "rejoin")
    if (result.ok) {
      this.guestRole = gr
      this.guestWs = gr.getWs()
      this.setRoleGuest(gr)
      return `Rejoined as guest (${result.myHandle}). Connected to ${result.hostHandle}.`
    }
    if (result.reason === "timeout") {
      return `No host responded at ws://${resolveHost()}:${this.port}. Is the host's opencode running? The grace code may have expired (>1 hour).`
    }
    return `Rejoin failed: ${result.reason}`
  }

  dispose(): void {
    this.cleanup()
  }
}
