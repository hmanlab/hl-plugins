import { describe, it, expect } from "bun:test"
import { encode, decode } from "../../src/protocol/codec"
import type { WireMessage } from "../../src/protocol/messages"

describe("encode", () => {
  it("encodes auth message", () => {
    const msg: WireMessage = { type: "auth", code: "mp-bob-abcd-efgh" }
    expect(encode(msg)).toBe(JSON.stringify(msg))
  })

  it("encodes welcome message with peers", () => {
    const msg: WireMessage = {
      type: "welcome",
      handle: "alice",
      peers: [{ handle: "bob", joinedAt: 1234567890 }],
    }
    expect(encode(msg)).toBe(JSON.stringify(msg))
  })
})

describe("decode", () => {
  it("decodes valid JSON to WireMessage", () => {
    const raw = JSON.stringify({ type: "auth", code: "mp-bob-abcd-efgh" })
    expect(decode(raw)).toEqual({ type: "auth", code: "mp-bob-abcd-efgh" })
  })

  it("decodes welcome message with peers", () => {
    const raw = JSON.stringify({
      type: "welcome",
      handle: "alice",
      peers: [{ handle: "bob", joinedAt: 1234567890 }],
    })
    expect(decode(raw)).toEqual({
      type: "welcome",
      handle: "alice",
      peers: [{ handle: "bob", joinedAt: 1234567890 }],
    })
  })

  it("returns null for invalid JSON", () => {
    expect(decode("not json")).toBeNull()
  })

  it("returns null for empty string", () => {
    expect(decode("")).toBeNull()
  })
})
