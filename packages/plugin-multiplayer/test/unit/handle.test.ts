import { describe, it, expect } from "bun:test"
import { isValidHandle, normalizeHandle, resolveHandle } from "../../src/handle/resolver"

describe("isValidHandle", () => {
  it("returns true for valid lowercase alphanumeric handles", () => {
    expect(isValidHandle("alice")).toBe(true)
    expect(isValidHandle("bob123")).toBe(true)
    expect(isValidHandle("charlie-brown")).toBe(true)
    expect(isValidHandle("x")).toBe(true)
  })

  it("returns true for 16-char max handles", () => {
    expect(isValidHandle("abcdefghijklmnop")).toBe(true)
  })

  it("returns false for handles exceeding 16 chars", () => {
    expect(isValidHandle("abcdefghijklmnoqr")).toBe(false)
  })

  it("returns false for uppercase letters", () => {
    expect(isValidHandle("Alice")).toBe(false)
  })

  it("returns false for special characters", () => {
    expect(isValidHandle("alice@bob")).toBe(false)
    expect(isValidHandle("alice_bob")).toBe(false)
    expect(isValidHandle("alice bob")).toBe(false)
  })

  it("returns false for empty string", () => {
    expect(isValidHandle("")).toBe(false)
  })
})

describe("normalizeHandle", () => {
  it("converts to lowercase", () => {
    expect(normalizeHandle("ALICE")).toBe("alice")
    expect(normalizeHandle("Bob123")).toBe("bob123")
  })

  it("removes invalid characters", () => {
    expect(normalizeHandle("alice@bob!")).toBe("alicebob")
    expect(normalizeHandle("charlie_brown")).toBe("charliebrown")
    expect(normalizeHandle("d an#iel")).toBe("daniel")
  })

  it("truncates to 16 characters", () => {
    expect(normalizeHandle("abcdefghijklmnopqrstuv")).toBe("abcdefghijklmnop")
  })

  it("preserves dashes", () => {
    expect(normalizeHandle("charlie-brown")).toBe("charlie-brown")
  })

  it("handles empty string", () => {
    expect(normalizeHandle("")).toBe("")
  })
})

describe("resolveHandle", () => {
  it("prefers envHandle when valid", () => {
    expect(resolveHandle("alice", null)).toBe("alice")
  })

  it("normalizes envHandle before validating", () => {
    expect(resolveHandle("ALICE", null)).toBe("alice")
  })

  it("rejects envHandle that normalizes to empty and falls back to persistedHandle", () => {
    expect(resolveHandle("!!!", "bob")).toBe("bob")
  })

  it("falls back to persistedHandle", () => {
    expect(resolveHandle(null, "bob")).toBe("bob")
  })

  it("prefers envHandle over persistedHandle when valid", () => {
    expect(resolveHandle("alice", "bob")).toBe("alice")
  })

  it("falls back to persistedHandle when envHandle normalizes to empty", () => {
    expect(resolveHandle("!!!", "bob")).toBe("bob")
  })
})
