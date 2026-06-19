import type { PeerInfo } from "../types.ts"

export function peerListForBroadcast(
  peers: Map<object, PeerInfo>,
): { handle: string; joinedAt: number }[] {
  const out: { handle: string; joinedAt: number }[] = []
  for (const p of peers.values()) {
    if (p.handle === "__pending__") continue
    out.push({ handle: p.handle, joinedAt: p.joinedAt })
  }
  out.sort((a, b) => a.joinedAt - b.joinedAt)
  return out
}