// Decay engine tests: multiplier values + pin/cold/expire paths.

import { describe, it, expect } from "bun:test"
import { decayMultiplier, shouldMarkCold, shouldMarkExpired, type DecayRow } from "../src/decay/engine.ts"
import { DEFAULT_DECAY_POLICY } from "../src/decay/policy.ts"

const DAY = 24 * 60 * 60 * 1000

function row(overrides: Partial<DecayRow> = {}): DecayRow {
  return {
    created_at: 0,
    last_accessed_at: 0,
    importance: 0.5,
    access_count: 1,
    is_pinned: 0,
    is_expired: 0,
    ...overrides,
  }
}

describe("decayMultiplier", () => {
  it("fresh row → 1.0", () => {
    const r = row({ created_at: 1000, last_accessed_at: 1000 })
    expect(decayMultiplier(r, DEFAULT_DECAY_POLICY, 1000)).toBe(1.0)
  })

  it("pinned → 1.0 regardless of age / importance", () => {
    const r = row({
      created_at: 0,
      last_accessed_at: 0,
      access_count: 0,
      importance: 0.1,
      is_pinned: 1,
    })
    expect(decayMultiplier(r, DEFAULT_DECAY_POLICY, 365 * DAY)).toBe(1.0)
  })

  it("expired → 0.0", () => {
    const r = row({ is_expired: 1, created_at: 0, importance: 0.9 })
    expect(decayMultiplier(r, DEFAULT_DECAY_POLICY, DAY)).toBe(0.0)
  })

  it("access-zero after policy days → factor applied", () => {
    const r = row({
      created_at: 0,
      last_accessed_at: 0,
      access_count: 0,
      importance: 0.9, // high importance → not cold
    })
    // 31 days after created_at, 0 access, importance 0.9
    const mult = decayMultiplier(r, DEFAULT_DECAY_POLICY, 31 * DAY)
    expect(mult).toBeCloseTo(DEFAULT_DECAY_POLICY.access_zero_decay_factor, 5)
  })

  it("cold after cold_days + low importance → 0.5×", () => {
    const r = row({
      created_at: 0,
      last_accessed_at: 0,
      access_count: 0,
      importance: 0.1,
    })
    // 91 days old, importance 0.1 → both rules apply
    const mult = decayMultiplier(r, DEFAULT_DECAY_POLICY, 91 * DAY)
    expect(mult).toBeCloseTo(0.7 * 0.5, 5)
  })
})

describe("shouldMarkCold", () => {
  it("false when pinned", () => {
    const r = row({ is_pinned: 1, importance: 0.1, last_accessed_at: 0 })
    expect(shouldMarkCold(r, DEFAULT_DECAY_POLICY, 91 * DAY)).toBe(false)
  })

  it("true when old + low importance", () => {
    const r = row({
      importance: 0.2,
      created_at: 0,
      last_accessed_at: 0,
    })
    expect(shouldMarkCold(r, DEFAULT_DECAY_POLICY, 91 * DAY)).toBe(true)
  })

  it("false when recent", () => {
    const r = row({
      importance: 0.2,
      created_at: 0,
      last_accessed_at: 80 * DAY,
    })
    expect(shouldMarkCold(r, DEFAULT_DECAY_POLICY, 90 * DAY)).toBe(false)
  })
})

describe("shouldMarkExpired", () => {
  it("true when expires_at in the past", () => {
    expect(shouldMarkExpired({ expires_at: 100 }, 200)).toBe(true)
  })

  it("false when expires_at in the future", () => {
    expect(shouldMarkExpired({ expires_at: 200 }, 100)).toBe(false)
  })

  it("false when expires_at is null", () => {
    expect(shouldMarkExpired({ expires_at: null }, 100)).toBe(false)
  })
})
