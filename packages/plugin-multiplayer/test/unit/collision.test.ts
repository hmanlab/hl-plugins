import { describe, it, expect } from "bun:test"
import { assignCollisionSuffix } from "../../src/handle/collision"

describe("assignCollisionSuffix", () => {
  it("returns a valid handle when base is available", () => {
    const result = assignCollisionSuffix("alice", [])
    expect(result).toMatch(/^alice-/)
    expect(result.length).toBeLessThanOrEqual(16)
  })

  it("avoids taken handles", () => {
    const taken = new Array(50).fill(null).map((_, i) => `alice-${i.toString(36).padStart(4, "0")}`)
    const result = assignCollisionSuffix("alice", taken)
    expect(result).not.toBeOneOf(taken)
    expect(result.length).toBeLessThanOrEqual(16)
  })
})
