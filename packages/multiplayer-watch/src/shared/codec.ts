// Line-delimited JSON codec for the plugin ↔ companion UDS protocol.
//
// Each message is one JSON object terminated by a single newline (`\n`).
// Each side reads from the OTHER side's stream:
//   - The plugin reads from the companion → expects `CompanionToPlugin`
//   - The companion reads from the plugin  → expects `PluginToCompanion`
//
// Whitespace-only lines are skipped. Lines that fail to parse or
// validate are reported via `onError`.
//
// NOTE: This is a copy of `packages/plugin-multiplayer/shared/codec.ts`.
// The companion is published as a separate npm package and must be
// self-contained — it cannot import from the plugin at runtime.
// Keep this file in sync with the plugin's copy.

import { IPC_MAX_MESSAGE_BYTES, isPluginToCompanion, isCompanionToPlugin } from "./protocol.ts"
import type { PluginToCompanion, CompanionToPlugin } from "./protocol.ts"

// `from` describes the source of the stream this parser is reading from.
export type StreamFrom = "plugin" | "companion"

export type LineParser = (
  line: string,
  onMessage: (msg: PluginToCompanion | CompanionToPlugin) => void,
  onError?: (err: Error) => void,
) => void

export function makeLineParser(from: StreamFrom): LineParser {
  return (raw, onMessage, onError) => {
    const line = raw.trim()
    if (line.length === 0) return
    if (line.length > IPC_MAX_MESSAGE_BYTES) {
      onError?.(new Error(`message too large (${line.length} > ${IPC_MAX_MESSAGE_BYTES})`))
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (e) {
      onError?.(e as Error)
      return
    }
    if (from === "plugin" && isPluginToCompanion(parsed)) {
      onMessage(parsed)
      return
    }
    if (from === "companion" && isCompanionToPlugin(parsed)) {
      onMessage(parsed)
      return
    }
    onError?.(new Error(`invalid ${from} message: ${line.slice(0, 80)}`))
  }
}

export function encode(msg: PluginToCompanion | CompanionToPlugin): string {
  return JSON.stringify(msg) + "\n"
}

// Splits a chunk of buffered data into complete lines and a remainder.
// Newline is the delimiter. Empty trailing newline is allowed.
export function splitLines(chunk: string): { lines: string[]; rest: string } {
  const parts = chunk.split("\n")
  const rest = parts.pop() ?? ""
  return { lines: parts, rest }
}
