import { describe, it, expect } from "bun:test"
import { isWireMessage } from "../../src/protocol/messages"

describe("isWireMessage: chat", () => {
  it("accepts a valid chat message", () => {
    expect(isWireMessage({ type: "chat", from: "carol", text: "hi", ts: 1234567890 })).toBe(true)
  })

  it("accepts a multi-line chat message", () => {
    expect(isWireMessage({ type: "chat", from: "bob", text: "line1\nline2", ts: 1 })).toBe(true)
  })

  it("accepts a chat message at exactly the max length", () => {
    expect(isWireMessage({ type: "chat", from: "bob", text: "a".repeat(4000), ts: 1 })).toBe(true)
  })

  it("rejects a chat message over the max length", () => {
    expect(isWireMessage({ type: "chat", from: "bob", text: "a".repeat(4001), ts: 1 })).toBe(false)
  })

  it("rejects an empty chat message", () => {
    expect(isWireMessage({ type: "chat", from: "bob", text: "", ts: 1 })).toBe(false)
  })

  it("rejects a chat message with a non-string from", () => {
    expect(isWireMessage({ type: "chat", from: 42, text: "hi", ts: 1 })).toBe(false)
  })

  it("rejects a chat message with a non-number ts", () => {
    expect(isWireMessage({ type: "chat", from: "bob", text: "hi", ts: "now" })).toBe(false)
  })

  it("rejects a chat message with a non-string text", () => {
    expect(isWireMessage({ type: "chat", from: "bob", text: 42, ts: 1 })).toBe(false)
  })
})

describe("isWireMessage: typing", () => {
  it("accepts typing start", () => {
    expect(isWireMessage({ type: "typing", from: "carol", state: "start" })).toBe(true)
  })

  it("accepts typing stop", () => {
    expect(isWireMessage({ type: "typing", from: "carol", state: "stop" })).toBe(true)
  })

  it("rejects typing with an invalid state", () => {
    expect(isWireMessage({ type: "typing", from: "carol", state: "maybe" })).toBe(false)
  })

  it("rejects typing without a from", () => {
    expect(isWireMessage({ type: "typing", state: "start" })).toBe(false)
  })
})
