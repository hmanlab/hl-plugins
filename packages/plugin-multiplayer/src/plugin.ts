import type { PluginInput } from "@opencode-ai/plugin"
import { Toaster, Logger } from "./bridge/index.ts"
import { StateStore, readHandleFileSync } from "./persistence/index.ts"
import { resolvePort, resolveHost } from "./env/index.ts"
import { IdleRole, HostRole, GuestRole, TransferController, type RoleState } from "./role/index.ts"
import {
  isValidHandle,
  normalizeHandle,
  osUser,
  mintCode,
  isValidCode,
  assignCollisionSuffix,
} from "./handle/index.ts"
import { GRACE_S, CASCADE_TIMEOUT_MS, DEFAULT_PORT, DEFAULT_HOST } from "./constants.ts"
import { peerListForBroadcast } from "./role/peer-helpers.ts"
import type { PeerInfo, Role, HostSocketData } from "./types.ts"
import type { WireMessage } from "./protocol/index.ts"
import { startHostServer } from "./server/index.ts"
import { CompanionSocketServer } from "./companion/socket-server.ts"
import { companionSocketPath, companionTokenPath } from "./companion/paths.ts"
import { computeIpcState, pushIpcState, pushPeersUpdate, pushRoleChange } from "./companion/state-pusher.ts"
import type { IpcState } from "../shared/protocol.ts"

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

  companionServer: CompanionSocketServer | null = null
  private companionDisabled = false

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

  /** Start the companion UDS server. Returns the server instance, or null on error.
   *
   * Does NOT respect `MP_NO_COMPANION` — callers (like the auto-spawn in
   * `createMultiplayerPlugin`) check that flag themselves. This lets
   * tests and other code start the UDS server explicitly while the
   * auto-spawn is disabled.
   */
  async startCompanionServer(): Promise<CompanionSocketServer | null> {
    if (this.companionServer && this.companionServer.isRunning()) {
      return this.companionServer
    }
    const server = new CompanionSocketServer({
      socketPath: companionSocketPath(),
      tokenPath: companionTokenPath(),
      handlers: {
        onChat: (text) => {
          void this.handleCompanionChat(text)
        },
        onTyping: (state) => {
          if (this.role === "host") this.hostRole?.sendTyping(state)
          if (this.role === "guest") this.guestRole?.sendTyping(state)
        },
        onCommand: (name, args) => {
          void this.handleCompanionCommand(name, args)
        },
        onLeave: () => {
          void this.mpLeave()
        },
        onConnect: () => {
          // Push the current state immediately on connect
          if (this.companionServer) {
            this.companionServer.pushState(computeIpcState(this))
          }
        },
        onDisconnect: () => {
          // The plugin uses this for crash detection; respawn is in 3e/3f.
        },
        onAuthFail: (reason) => {
          void this.logger.log("warn", "companion auth failed", { reason })
        },
        onParseError: (e) => {
          void this.logger.log("warn", "companion parse error", { err: e.message })
        },
        onError: (e) => {
          void this.logger.log("error", "companion server error", { err: e.message })
        },
      },
    })
    try {
      await server.start()
    } catch (e) {
      await this.logger.log("warn", "companion server failed to start", { err: (e as Error).message })
      this.companionDisabled = true
      return null
    }
    this.companionServer = server
    return server
  }

  async stopCompanionServer(): Promise<void> {
    if (this.companionServer) {
      this.companionServer.pushGoodbye("shutdown")
      await this.companionServer.stop()
      this.companionServer = null
    }
  }

  private async handleCompanionChat(text: string): Promise<void> {
    // Same path as /mp_chat from the OpenCode prompt.
    await this.mpChat(text)
    // Push the outgoing message to the companion so the user sees it in the chat history.
    if (this.companionServer) {
      const me = this.resolveHandle()
      this.companionServer.pushChat({
        from: me,
        text,
        ts: Date.now(),
        mine: true,
      })
    }
  }

  private async handleCompanionCommand(name: string, args: string[]): Promise<void> {
    switch (name) {
      case "join":
        if (args[0]) await this.mpJoin(args[0])
        return
      case "leave":
        await this.mpLeave()
        return
      case "cancel-leave":
        await this.mpCancelLeave()
        return
      case "volunteer":
        this.mpVolunteer()
        return
      case "code":
        this.companionServer?.pushToast(this.mpCode(), "info", "code")
        return
      case "status":
        this.companionServer?.pushToast(this.mpStatus(), "info", "status")
        return
      case "intent":
        // Phase 04 — for now, log a warning.
        await this.logger.log("warn", "intent not yet implemented (Phase 04)")
        this.companionServer?.pushToast("intents are coming in Phase 04", "info", "intent")
        return
      case "history":
        this.companionServer?.pushToast("/mp history is coming in Phase 07", "info", "history")
        return
      default:
        this.companionServer?.pushToast(`unknown command: ${name}`, "warning", "multiplayer")
    }
  }

  /** Push a state change to all connected companions. */
  pushStateToCompanions(): void {
    pushIpcState(this, this.companionServer)
  }

  pushRoleChangeToCompanions(): void {
    pushRoleChange(this, this.companionServer)
  }

  pushPeersToCompanions(): void {
    pushPeersUpdate(this, this.companionServer)
  }

  async mpHost(): Promise<string> {
    const handle = this.resolveHandle()
    const bindPort = resolvePort()
    const bindHost = resolveHost()
    const result = await this.startHost(handle, bindPort, bindHost)
    if (result.ok) {
      this.pushRoleChangeToCompanions()
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

    const hr = new HostRole({
      port: bindPort,
      host: bindHost,
      handle,
      state: this.store,
      toaster: this.toaster,
      logger: this.logger,
      onPeersChanged: () => this.pushPeersToCompanions(),
      onChatReceived: (msg) => {
        if (this.companionServer) {
          this.companionServer.pushChat({ ...msg, mine: false })
        }
      },
      onTypingReceived: (from, state) => {
        if (this.companionServer) {
          this.companionServer.pushTyping(from, state)
        }
      },
    })
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

  private broadcastPeersUpdate(): void {
    if (this.hostRole) {
      const peers = peerListForBroadcast(this.hostRole.getPeers())
      this.hostRole.broadcast({ type: "peers_update", peers })
    }
    this.pushPeersToCompanions()
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
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      return
    }

    if (ws.data.state === "awaiting_auth") {
      if (msg.type !== "auth") {
        this.sendToPeer(ws, { type: "auth_fail", reason: "expected_auth" })
        this.sendToPeer(ws, { type: "bye" })
        try {
          ws.close()
        } catch {
          /* ignore */
        }
        return
      }
      if (!isValidCode(msg.code)) {
        this.sendToPeer(ws, { type: "auth_fail", reason: "invalid_code" })
        this.sendToPeer(ws, { type: "bye" })
        try {
          ws.close()
        } catch {
          /* ignore */
        }
        await this.toaster.show("guest sent an invalid code", "warning", "multiplayer")
        return
      }
      const normalized = msg.code.toLowerCase()
      const isCurrent = this.hostCode !== null && normalized === this.hostCode
      const isGrace = !isCurrent
      if (!isCurrent && !isGrace) {
        this.sendToPeer(ws, { type: "auth_fail", reason: "unknown_code" })
        this.sendToPeer(ws, { type: "bye" })
        try {
          ws.close()
        } catch {
          /* ignore */
        }
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
        try {
          ws.close()
        } catch {
          /* ignore */
        }
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
    const gr = new GuestRole({
      port: this.port,
      host: resolveHost(),
      handle,
      state: this.store,
      toaster: this.toaster,
      logger: this.logger,
      promote: (msg, oldWs, oldUrl) => this.promoteToHost(msg, oldWs, oldUrl),
      reconnect: (newCode, newUrl) => this.reconnectAsGuest(newCode, newUrl, "rejoin"),
      ended: (reason) => this.onGuestEnded(reason),
      onPeersChanged: () => this.pushPeersToCompanions(),
      onChatReceived: (msg) => {
        if (this.companionServer) {
          this.companionServer.pushChat({ ...msg, mine: false })
        }
      },
      onTypingReceived: (from, state) => {
        if (this.companionServer) {
          this.companionServer.pushTyping(from, state)
        }
      },
    })
    const result = await gr.dial(code, "join")
    if (result.ok) {
      this.guestRole = gr
      this.guestWs = gr.getWs()
      this.setRoleGuest(gr)
      this.pushRoleChangeToCompanions()
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
    if (this.role === "guest")
      return this.guestRole?.getHostHandle() ? `host handle: ${this.guestRole.getHostHandle()}` : "(unknown)"
    return "Not in a session. Use mp_host or mp_join first."
  }

  mpChat(text: string): string {
    if (this.role === "host") {
      const result = this.hostRole?.sendChat(text)
      if (!result) return "Not hosting."
      if (!result.ok) return `Chat failed: ${result.reason}`
      if (this.companionServer) {
        this.companionServer.pushChat({
          from: this.resolveHandle(),
          text: text.trim(),
          ts: Date.now(),
          mine: true,
        })
      }
      return `Sent to ${result.peers} peer(s).`
    }
    if (this.role === "guest") {
      const result = this.guestRole?.sendChat(text)
      if (!result) return "Not connected."
      if (!result.ok) return `Chat failed: ${result.reason}`
      if (this.companionServer) {
        this.companionServer.pushChat({
          from: this.resolveHandle(),
          text: text.trim(),
          ts: Date.now(),
          mine: true,
        })
      }
      return `Sent to ${this.guestRole?.getHostHandle() ?? "host"}.`
    }
    return "Not in a session. Use mp_host or mp_join first."
  }

  mpTyping(state: "start" | "stop"): void {
    if (this.role === "host") this.hostRole?.sendTyping(state)
    if (this.role === "guest") this.guestRole?.sendTyping(state)
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
    const gr = new GuestRole({
      port: this.port,
      host: resolveHost(),
      handle,
      state: this.store,
      toaster: this.toaster,
      logger: this.logger,
      promote: (msg, oldWs, oldUrl) => this.promoteToHost(msg, oldWs, oldUrl),
      reconnect: (newCode, newUrl) => this.reconnectAsGuest(newCode, newUrl, "rejoin"),
      ended: (reason) => this.onGuestEnded(reason),
    })
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

  private async promoteToHost(
    msg: {
      type: "transfer_to_me"
      new_handle: string
      old_code: string
      old_handle: string
      peers: { handle: string; joinedAt: number }[]
    },
    oldHostWs: WebSocket,
    _oldHostUrl: string,
  ): Promise<{ ok: true; newCode: string; newUrl: string } | { ok: false; reason: string }> {
    const newHandle = msg.new_handle
    const newPort = resolvePort()
    const newBindHost = resolveHost()
    const newUrl = `ws://${newBindHost}:${newPort}`

    const hr = new HostRole({
      port: newPort,
      host: newBindHost,
      handle: newHandle,
      state: this.store,
      toaster: this.toaster,
      logger: this.logger,
    })
    // Add the old code to our grace list so other peers can rejoin
    // with it during the transfer window.
    hr.addGraceCode(msg.old_code)

    const result = await hr.start()
    if (!result.ok) {
      return { ok: false, reason: result.reason }
    }

    this.hostRole = hr
    this.hostCode = result.code
    this.hostHandle = newHandle
    this.port = newPort
    this.hostAddr = `${newBindHost}:${newPort}`
    this.setRoleHost(hr)
    return { ok: true, newCode: result.code, newUrl: result.url }
  }

  private async reconnectAsGuest(newCode: string, newUrl: string, mode: "join" | "rejoin"): Promise<void> {
    // The old WS has been closed by the transfer_start handler.
    // Re-dial the new host with the new code.
    const handle = this.resolveHandle()
    const gr = new GuestRole({
      port: this.port,
      host: resolveHost(),
      handle,
      state: this.store,
      toaster: this.toaster,
      logger: this.logger,
      promote: (msg, oldWs, oldUrl) => this.promoteToHost(msg, oldWs, oldUrl),
      reconnect: (code, url) => this.reconnectAsGuest(code, url, "rejoin"),
      ended: (reason) => this.onGuestEnded(reason),
    })
    const result = await gr.dial(newCode, mode)
    if (result.ok) {
      this.guestRole = gr
      this.guestWs = gr.getWs()
      this.setRoleGuest(gr)
    } else {
      this.guestRole = null
      this.guestWs = null
      this.resetToIdleRole()
      await this.toaster.show(`reconnect after transfer failed: ${result.reason}`, "error", "multiplayer")
    }
  }

  private onGuestEnded(reason: string): void {
    this.guestRole = null
    this.guestWs = null
    this.guestHostHandle = null
    this.guestMyHandle = null
    this.guestHostUrl = null
    this.resetToIdleRole()
    void this.toaster.show(`session ended: ${reason}`, "warning", "multiplayer")
  }

  dispose(): void {
    this.cleanup()
  }
}
