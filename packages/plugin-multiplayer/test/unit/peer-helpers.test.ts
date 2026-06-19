import { describe, it, expect } from "bun:test"
import { peerListForBroadcast } from "../../src/role/peer-helpers"
import type { PeerInfo } from "../../src/types"

describe("peerListForBroadcast", () => {
  it("returns empty array for empty map", () => {
    expect(peerListForBroadcast(new Map())).toEqual([])
  })

  it("filters out pending peers", () => {
    const peers = new Map<object, PeerInfo>([
      [{ id: 1 }, { handle: "__pending__", joinedAt: 1000, isVolunteer: false }],
      [{ id: 2 }, { handle: "alice", joinedAt: 2000, isVolunteer: false }],
    ])
    expect(peerListForBroadcast(peers)).toEqual([{ handle: "alice", joinedAt: 2000 }])
  })

  it("sorts peers by joinedAt ascending", () => {
    const peers = new Map<object, PeerInfo>([
      [{ id: 1 }, { handle: "charlie", joinedAt: 3000, isVolunteer: false }],
      [{ id: 2 }, { handle: "alice", joinedAt: 1000, isVolunteer: false }],
      [{ id: 3 }, { handle: "bob", joinedAt: 2000, isVolunteer: false }],
    ])
    expect(peerListForBroadcast(peers)).toEqual([
      { handle: "alice", joinedAt: 1000 },
      { handle: "bob", joinedAt: 2000 },
      { handle: "charlie", joinedAt: 3000 },
    ])
  })

  it("returns only handle and joinedAt fields", () => {
    const peers = new Map<object, PeerInfo>([
      [{ id: 1 }, { handle: "alice", joinedAt: 1000, isVolunteer: true }],
    ])
    expect(peerListForBroadcast(peers)).toEqual([{ handle: "alice", joinedAt: 1000 }])
  })
})
