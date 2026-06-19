import { describe, it, expect } from "bun:test"
import {
  isPluginToCompanion,
  isCompanionToPlugin,
  IPC_VERSION,
  IPC_MAX_MESSAGE_BYTES,
} from "../../shared/protocol"
import { makeLineParser, encode, splitLines } from "../../shared/codec"
import type { PluginToCompanion, CompanionToPlugin, IpcState } from "../../shared/protocol"

const baseState: IpcState = {
  role: "host",
  handle: "bob",
  code: "mp-bob-abcd-efgh",
  port: 7332,
  hostHandle: "bob",
  peers: [{ handle: "carol", joinedAt: 1700000000000 }],
  leaving: "none",
  grace_s: null,
}

describe("isPluginToCompanion", () => {
  it("accepts init with a valid state", () => {
    expect(isPluginToCompanion({ type: "init", state: baseState })).toBe(true)
  })

  it("accepts init with idle role and null code", () => {
    expect(
      isPluginToCompanion({
        type: "init",
        state: { ...baseState, role: "idle", code: null, hostHandle: null, peers: [] },
      }),
    ).toBe(true)
  })

  it("accepts guests with no code and a hostHandle", () => {
    expect(
      isPluginToCompanion({
        type: "init",
        state: { ...baseState, role: "guest", code: null, hostHandle: "bob" },
      }),
    ).toBe(true)
  })

  it("accepts role_change with valid state", () => {
    expect(isPluginToCompanion({ type: "role_change", state: baseState })).toBe(true)
  })

  it("accepts peers_update", () => {
    expect(isPluginToCompanion({ type: "peers_update", peers: [{ handle: "alice", joinedAt: 1 }] })).toBe(
      true,
    )
  })

  it("accepts chat with mine boolean", () => {
    expect(
      isPluginToCompanion({
        type: "chat",
        from: "carol",
        text: "hi",
        ts: 1,
        mine: false,
      }),
    ).toBe(true)
  })

  it("rejects chat without mine", () => {
    expect(isPluginToCompanion({ type: "chat", from: "carol", text: "hi", ts: 1 })).toBe(false)
  })

  it("rejects chat with empty text", () => {
    expect(isPluginToCompanion({ type: "chat", from: "carol", text: "", ts: 1, mine: false })).toBe(false)
  })

  it("rejects chat with overlong text", () => {
    expect(
      isPluginToCompanion({
        type: "chat",
        from: "carol",
        text: "a".repeat(4001),
        ts: 1,
        mine: false,
      }),
    ).toBe(false)
  })

  it("accepts typing start/stop", () => {
    expect(isPluginToCompanion({ type: "typing", from: "carol", state: "start" })).toBe(true)
    expect(isPluginToCompanion({ type: "typing", from: "carol", state: "stop" })).toBe(true)
  })

  it("rejects typing with invalid state", () => {
    expect(isPluginToCompanion({ type: "typing", from: "carol", state: "maybe" })).toBe(false)
  })

  it("accepts host_leaving", () => {
    expect(isPluginToCompanion({ type: "host_leaving", grace_s: 10 })).toBe(true)
  })

  it("accepts leave_cancelled", () => {
    expect(isPluginToCompanion({ type: "leave_cancelled" })).toBe(true)
  })

  it("accepts session_ended", () => {
    expect(isPluginToCompanion({ type: "session_ended", reason: "no_peers" })).toBe(true)
  })

  it("accepts transfer_start", () => {
    expect(
      isPluginToCompanion({
        type: "transfer_start",
        new_code: "mp-carol-wxyz-1234",
        new_url: "ws://localhost:7332",
        new_handle: "carol",
      }),
    ).toBe(true)
  })

  it("rejects transfer_start with malformed code", () => {
    expect(
      isPluginToCompanion({
        type: "transfer_start",
        new_code: "not-a-code",
        new_url: "ws://localhost:7332",
        new_handle: "carol",
      }),
    ).toBe(false)
  })

  it("rejects transfer_start with non-ws URL", () => {
    expect(
      isPluginToCompanion({
        type: "transfer_start",
        new_code: "mp-carol-wxyz-1234",
        new_url: "http://localhost:7332",
        new_handle: "carol",
      }),
    ).toBe(false)
  })

  it("accepts toast", () => {
    expect(isPluginToCompanion({ type: "toast", message: "hi", variant: "info" })).toBe(true)
    expect(isPluginToCompanion({ type: "toast", message: "hi", variant: "success", title: "ok" })).toBe(true)
  })

  it("rejects toast with invalid variant", () => {
    expect(isPluginToCompanion({ type: "toast", message: "hi", variant: "huh" })).toBe(false)
  })

  it("accepts goodbye", () => {
    expect(isPluginToCompanion({ type: "goodbye", reason: "shutdown" })).toBe(true)
  })

  it("rejects unknown types", () => {
    expect(isPluginToCompanion({ type: "nope" })).toBe(false)
  })

  it("rejects init with invalid state", () => {
    expect(isPluginToCompanion({ type: "init", state: { role: "host" } })).toBe(false)
  })
})

describe("isCompanionToPlugin", () => {
  it("accepts hello with version and token", () => {
    expect(isCompanionToPlugin({ type: "hello", version: IPC_VERSION, token: "abc123" })).toBe(true)
  })

  it("rejects hello without token", () => {
    expect(isCompanionToPlugin({ type: "hello", version: IPC_VERSION })).toBe(false)
  })

  it("accepts chat with text", () => {
    expect(isCompanionToPlugin({ type: "chat", text: "hi" })).toBe(true)
  })

  it("rejects chat with empty text", () => {
    expect(isCompanionToPlugin({ type: "chat", text: "" })).toBe(false)
  })

  it("rejects chat with overlong text", () => {
    expect(isCompanionToPlugin({ type: "chat", text: "a".repeat(4001) })).toBe(false)
  })

  it("accepts typing start/stop", () => {
    expect(isCompanionToPlugin({ type: "typing", state: "start" })).toBe(true)
    expect(isCompanionToPlugin({ type: "typing", state: "stop" })).toBe(true)
  })

  it("rejects typing with invalid state", () => {
    expect(isCompanionToPlugin({ type: "typing", state: "maybe" })).toBe(false)
  })

  it("accepts command", () => {
    expect(isCompanionToPlugin({ type: "command", name: "join", args: ["mp-bob-abcd-efgh"] })).toBe(true)
  })

  it("rejects command with non-string arg", () => {
    expect(isCompanionToPlugin({ type: "command", name: "join", args: [123] })).toBe(false)
  })

  it("accepts leave/ping/goodbye", () => {
    expect(isCompanionToPlugin({ type: "leave" })).toBe(true)
    expect(isCompanionToPlugin({ type: "ping" })).toBe(true)
    expect(isCompanionToPlugin({ type: "goodbye" })).toBe(true)
  })

  it("rejects unknown types", () => {
    expect(isCompanionToPlugin({ type: "nope" })).toBe(false)
  })
})

describe("encode", () => {
  it("encodes a message with a trailing newline", () => {
    const msg: PluginToCompanion = { type: "leave_cancelled" }
    const out = encode(msg)
    expect(out.endsWith("\n")).toBe(true)
    expect(JSON.parse(out.trim())).toEqual({ type: "leave_cancelled" })
  })
})

describe("makeLineParser", () => {
  it("parses a single line into a message", () => {
    const received: (PluginToCompanion | CompanionToPlugin)[] = []
    const errors: Error[] = []
    const parse = makeLineParser("plugin")
    parse(
      '{"type":"leave_cancelled"}\n',
      (m) => received.push(m),
      (e) => errors.push(e),
    )
    expect(errors.length).toBe(0)
    expect(received.length).toBe(1)
    expect(received[0]).toEqual({ type: "leave_cancelled" })
  })

  it("rejects malformed JSON", () => {
    const received: (PluginToCompanion | CompanionToPlugin)[] = []
    const errors: Error[] = []
    const parse = makeLineParser("plugin")
    parse(
      "not json\n",
      (m) => received.push(m),
      (e) => errors.push(e),
    )
    expect(received.length).toBe(0)
    expect(errors.length).toBe(1)
  })

  it("rejects an empty line silently", () => {
    const received: (PluginToCompanion | CompanionToPlugin)[] = []
    const errors: Error[] = []
    const parse = makeLineParser("plugin")
    parse(
      "\n",
      (m) => received.push(m),
      (e) => errors.push(e),
    )
    expect(received.length).toBe(0)
    expect(errors.length).toBe(0)
  })

  it("rejects an overlong line", () => {
    const received: (PluginToCompanion | CompanionToPlugin)[] = []
    const errors: Error[] = []
    const parse = makeLineParser("plugin")
    parse(
      "a".repeat(IPC_MAX_MESSAGE_BYTES + 1) + "\n",
      (m) => received.push(m),
      (e) => errors.push(e),
    )
    expect(received.length).toBe(0)
    expect(errors.length).toBe(1)
    expect(errors[0]!.message).toMatch(/too large/)
  })

  it("rejects a message of the wrong source (parsing companion stream as plugin)", () => {
    const received: (PluginToCompanion | CompanionToPlugin)[] = []
    const errors: Error[] = []
    const parse = makeLineParser("companion")
    parse(
      '{"type":"leave_cancelled"}\n',
      (m) => received.push(m),
      (e) => errors.push(e),
    )
    // plugin messages should not be accepted by a companion-source parser
    expect(received.length).toBe(0)
    expect(errors.length).toBe(1)
  })

  it("rejects a message of the wrong source (parsing plugin stream as companion)", () => {
    const received: (PluginToCompanion | CompanionToPlugin)[] = []
    const errors: Error[] = []
    const parse = makeLineParser("plugin")
    parse(
      '{"type":"chat","text":"hi"}\n',
      (m) => received.push(m),
      (e) => errors.push(e),
    )
    expect(received.length).toBe(0)
    expect(errors.length).toBe(1)
  })

  it("accepts a companion message when parsing the companion stream", () => {
    const received: (PluginToCompanion | CompanionToPlugin)[] = []
    const errors: Error[] = []
    const parse = makeLineParser("companion")
    parse(
      '{"type":"chat","text":"hi"}\n',
      (m) => received.push(m),
      (e) => errors.push(e),
    )
    expect(errors.length).toBe(0)
    expect(received.length).toBe(1)
  })
})

describe("splitLines", () => {
  it("splits a complete chunk into lines", () => {
    const out = splitLines('{"type":"a"}\n{"type":"b"}\n')
    expect(out.lines).toEqual(['{"type":"a"}', '{"type":"b"}'])
    expect(out.rest).toBe("")
  })

  it("keeps the trailing partial line in rest", () => {
    const out = splitLines('{"type":"a"}\n{"typ')
    expect(out.lines).toEqual(['{"type":"a"}'])
    expect(out.rest).toBe('{"typ')
  })

  it("returns the chunk as rest when there is no newline", () => {
    const out = splitLines('{"type":"a"}')
    expect(out.lines).toEqual([])
    expect(out.rest).toBe('{"type":"a"}')
  })

  it("handles empty input", () => {
    const out = splitLines("")
    expect(out.lines).toEqual([])
    expect(out.rest).toBe("")
  })
})
