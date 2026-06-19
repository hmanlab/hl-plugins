import type { StateStore } from "../persistence/state-store.ts"
import { peerListForBroadcast } from "./peer-helpers.ts"
import type { PeerInfo, HostSocketData } from "../types.ts"
import type { HostRole } from "./host-role.ts"
import type { Toaster } from "../bridge/toast.ts"
import type { Logger } from "../bridge/logger.ts"
import type { WireMessage } from "../protocol/messages.ts"

export type TransferState = "none" | "pending" | "transferring"

function sendToPeer(ws: { send(data: string): unknown }, msg: WireMessage): void {
  try {
    ws.send(JSON.stringify(msg))
  } catch {
    // ignore
  }
}

export interface TransferControllerCallbacks {
  getHostRole(): HostRole | null
  getHostPeers(): Map<Bun.ServerWebSocket<HostSocketData>, PeerInfo>
  getHostCode(): string | null
  getHostHandle(): string | null
  mintCode(handle: string): string
  stopHost(): void
  recordSessionEnded(handle: string, reason: string): Promise<void>
  recordHostChanged(newHandle: string, newCode: string, oldCode: string, oldHandle: string, newUrl: string): Promise<void>
  toast: Toaster["show"]
  log: Logger["log"]
}

export class TransferController {
  private state: TransferState = "none"
  private leaveTimer: ReturnType<typeof setTimeout> | null = null
  private transferTimer: ReturnType<typeof setTimeout> | null = null
  private queue: { handle: string; code: string }[] = []
  private snapshot: { code: string; handle: string; peers: { handle: string; joinedAt: number }[] } | null = null

  constructor(
    private cb: TransferControllerCallbacks,
    private graceMs: number,
    private cascadeMs: number,
  ) {}

  getState(): TransferState {
    return this.state
  }

  isPending(): boolean {
    return this.state !== "none"
  }

  private getPeers(): Map<Bun.ServerWebSocket<HostSocketData>, PeerInfo> {
    return this.cb.getHostRole()?.getPeers() ?? this.cb.getHostPeers()
  }

  private broadcast(msg: WireMessage, except?: Bun.ServerWebSocket<HostSocketData>): void {
    const hr = this.cb.getHostRole()
    if (hr) {
      hr.broadcast(msg, except)
    }
  }

  private findPeerWs(handle: string): Bun.ServerWebSocket<HostSocketData> | null {
    for (const [ws, peer] of this.getPeers().entries()) {
      if (peer.handle === handle) return ws
    }
    return null
  }

  private buildQueue(): { handle: string; code: string }[] {
    const all = Array.from(this.getPeers().values()).filter((p) => p.handle !== "__pending__")
    const hr = this.cb.getHostRole()
    const vols = all
      .filter((p) => (hr ? hr.isVolunteer(p.handle) : p.isVolunteer))
      .sort((a, b) => a.joinedAt - b.joinedAt)
    const nonVols = all
      .filter((p) => (hr ? !hr.isVolunteer(p.handle) : !p.isVolunteer))
      .sort((a, b) => a.joinedAt - b.joinedAt)
    const seen = new Set<string>()
    const ordered: PeerInfo[] = []
    for (const p of [...vols, ...nonVols]) {
      if (seen.has(p.handle)) continue
      seen.add(p.handle)
      ordered.push(p)
    }
    return ordered.map((p) => ({ handle: p.handle, code: this.cb.mintCode(p.handle) }))
  }

  private clearTimers(): void {
    if (this.leaveTimer) {
      clearTimeout(this.leaveTimer)
      this.leaveTimer = null
    }
    if (this.transferTimer) {
      clearTimeout(this.transferTimer)
      this.transferTimer = null
    }
  }

  async startLeave(): Promise<void> {
    if (this.state !== "none") return
    const peers = peerListForBroadcast(this.getPeers())
    if (peers.length === 0) {
      await this.cb.log("info", "host leaving with no peers; ending session")
      this.cb.stopHost()
      return
    }
    this.state = "pending"
    this.queue = this.buildQueue()
    this.snapshot = {
      code: this.cb.getHostCode() ?? "",
      handle: this.cb.getHostHandle() ?? "host",
      peers,
    }
    this.broadcast({ type: "host_leaving", grace_s: this.graceMs / 1000 })
    await this.cb.log("info", "host leaving; grace started", { grace_s: this.graceMs / 1000, peers: peers.length })
    await this.cb.toast(`leaving in ${this.graceMs / 1000}s — auto-transfer pending`, "info", "multiplayer")
    this.leaveTimer = setTimeout(() => {
      void this.onGraceExpired()
    }, this.graceMs)
  }

  async cancelLeave(): Promise<void> {
    if (this.state !== "pending") return
    this.clearTimers()
    this.state = "none"
    this.queue = []
    this.snapshot = null
    this.broadcast({ type: "leave_cancelled" })
    await this.cb.log("info", "host leave cancelled")
    await this.cb.toast("leave cancelled — staying as host", "info", "multiplayer")
  }

  async onGraceExpired(): Promise<void> {
    if (this.state !== "pending") return
    this.leaveTimer = null
    if (this.queue.length === 0) {
      this.broadcast({ type: "session_ended", reason: "no_peers" })
      await this.cb.recordSessionEnded(this.cb.getHostHandle() ?? "host", "no_peers")
      this.cb.stopHost()
      this.state = "none"
      await this.cb.toast("session ended (no successors)", "warning", "multiplayer")
      return
    }
    await this.tryNextSuccessor()
  }

  async tryNextSuccessor(): Promise<void> {
    if (this.state !== "pending") return
    const next = this.queue.shift()
    if (!next) {
      this.broadcast({ type: "session_ended", reason: "no_reachable_successor" })
      await this.cb.recordSessionEnded(this.cb.getHostHandle() ?? "host", "no_reachable_successor")
      this.cb.stopHost()
      this.state = "none"
      await this.cb.toast("session ended: no reachable successor", "error", "multiplayer")
      return
    }
    this.state = "transferring"
    const successorWs = this.findPeerWs(next.handle)
    if (!successorWs) {
      this.state = "pending"
      await this.onTransferFailed("successor_disconnected")
      return
    }
    const snap = this.snapshot
    if (!snap) {
      this.state = "pending"
      await this.onTransferFailed("no_snapshot")
      return
    }
    sendToPeer(successorWs, {
      type: "transfer_to_me",
      new_handle: next.handle,
      old_code: snap.code,
      old_handle: snap.handle,
      peers: snap.peers.filter((p) => p.handle !== next.handle),
    })
    await this.cb.log("info", "transfer_to_me sent", { successor: next.handle })
    await this.cb.toast(`transferring to ${next.handle}...`, "info", "multiplayer")
    this.transferTimer = setTimeout(() => {
      void this.onTransferFailed("timeout")
    }, this.cascadeMs)
  }

  async onTransferConfirmed(successorWs: { send(data: string): unknown }, newCode: string, newUrl: string): Promise<void> {
    if (this.transferTimer) {
      clearTimeout(this.transferTimer)
      this.transferTimer = null
    }
    const snap = this.snapshot
    if (!snap) return
    await this.cb.log("info", "transfer confirmed by successor", { newCode, newUrl })
    await this.cb.toast(`✓ transferred to ${newUrl.replace(/^ws:\/\//, "")}`, "success", "multiplayer")
    await this.cb.recordHostChanged(
      newCode && newCode.startsWith("mp-") ? newCode.split("-")[1] ?? "host" : "host",
      newCode,
      snap.code,
      snap.handle,
      newUrl,
    )
    this.broadcast(
      {
        type: "transfer_start",
        new_code: newCode,
        new_url: newUrl,
        new_handle: newCode && newCode.startsWith("mp-") ? newCode.split("-")[1] ?? "host" : "host",
      },
      successorWs as Bun.ServerWebSocket<HostSocketData>,
    )
    this.cb.stopHost()
    this.state = "none"
    this.snapshot = null
    this.queue = []
  }

  async onTransferFailed(reason: string): Promise<void> {
    if (this.transferTimer) {
      clearTimeout(this.transferTimer)
      this.transferTimer = null
    }
    await this.cb.log("warn", "transfer failed; cascading", { reason })
    await this.cb.toast(`transfer failed (${reason}); trying next successor`, "warning", "multiplayer")
    this.state = "pending"
    await this.tryNextSuccessor()
  }

  reset(): void {
    this.clearTimers()
    this.state = "none"
    this.queue = []
    this.snapshot = null
  }
}
