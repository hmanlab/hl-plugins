// Computes the IpcState that the companion renders and pushes state changes
// to the in-process CompanionSocketServer. This is the single source of truth
// for what the companion sees — every plugin state change eventually calls
// `pushIpcState()` so the companion's view stays in sync.

import type { MultiplayerPlugin } from "../plugin.ts"
import type { IpcState, IpcPeer, IpcLeaving } from "../../shared/protocol.ts"
import { GRACE_S } from "../constants.ts"
import { peerListForBroadcast } from "../role/peer-helpers.ts"
import type { CompanionSocketServer } from "./socket-server.ts"

function getPeersForHost(plugin: MultiplayerPlugin): IpcPeer[] {
  const peers = plugin.hostRole?.getPeers() ?? plugin.hostPeers
  return peerListForBroadcast(peers)
}

function getPeersForGuest(plugin: MultiplayerPlugin): IpcPeer[] {
  const list = plugin.guestRole?.getPeerList() ?? []
  const hostHandle = plugin.guestRole?.getHostHandle() ?? null
  // The host isn't in the welcome.peers list, so prepend it.
  if (hostHandle) {
    const hostEntry: IpcPeer = { handle: hostHandle, joinedAt: 0 }
    const withoutHost = list.filter((p) => p.handle !== hostHandle)
    return [hostEntry, ...withoutHost]
  }
  return list
}

function leavingState(plugin: MultiplayerPlugin): IpcLeaving {
  return plugin.tc?.getState() ?? "none"
}

export function computeIpcState(plugin: MultiplayerPlugin): IpcState {
  const handle = plugin.resolveHandle()
  const port = plugin.port
  if (plugin.role === "host") {
    return {
      role: "host",
      handle,
      code: plugin.hostRole?.getCode() ?? plugin.hostCode,
      port,
      hostHandle: handle,
      peers: getPeersForHost(plugin),
      leaving: leavingState(plugin),
      grace_s: plugin.tc?.isPending() ? GRACE_S : null,
    }
  }
  if (plugin.role === "guest") {
    return {
      role: "guest",
      handle,
      code: null,
      port,
      hostHandle: plugin.guestRole?.getHostHandle() ?? null,
      peers: getPeersForGuest(plugin),
      leaving: "none",
      grace_s: null,
    }
  }
  return {
    role: "idle",
    handle,
    code: null,
    port,
    hostHandle: null,
    peers: [],
    leaving: "none",
    grace_s: null,
  }
}

export function pushIpcState(plugin: MultiplayerPlugin, server: CompanionSocketServer | null): void {
  if (!server || !server.isRunning()) return
  if (server.clientCount() === 0) return
  server.pushState(computeIpcState(plugin))
}

export function pushRoleChange(plugin: MultiplayerPlugin, server: CompanionSocketServer | null): void {
  if (!server || !server.isRunning()) return
  if (server.clientCount() === 0) return
  server.pushRoleChange(computeIpcState(plugin))
}

export function pushPeersUpdate(plugin: MultiplayerPlugin, server: CompanionSocketServer | null): void {
  if (!server || !server.isRunning()) return
  if (server.clientCount() === 0) return
  if (plugin.role === "host") {
    server.pushPeersUpdate(getPeersForHost(plugin))
  } else if (plugin.role === "guest") {
    server.pushPeersUpdate(getPeersForGuest(plugin))
  }
}
