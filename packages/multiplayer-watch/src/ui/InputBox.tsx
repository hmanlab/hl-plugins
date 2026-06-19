import React, { useState, useEffect, useRef } from "react"
import { Box, Text, useInput } from "ink"
import type { CompanionClient } from "../transport/uds.ts"

const KNOWN_COMMANDS = new Set([
  "join",
  "leave",
  "cancel-leave",
  "volunteer",
  "code",
  "status",
  "history",
  "intent",
])

function parseInput(
  raw: string,
): { kind: "chat"; text: string } | { kind: "command"; name: string; args: string[] } {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { kind: "chat", text: "" }
  if (trimmed.startsWith("/")) {
    const stripped = trimmed.replace(/^\/+/, "")
    const sp = stripped.indexOf(" ")
    if (sp < 0) {
      return { kind: "command", name: stripped, args: [] }
    }
    const name = stripped.slice(0, sp)
    const rest = stripped.slice(sp + 1).trim()
    return { kind: "command", name, args: rest.length > 0 ? rest.split(/\s+/) : [] }
  }
  return { kind: "chat", text: trimmed }
}

export function InputBox({
  client,
  enabled,
  onTypingStart,
  onTypingStop,
}: {
  client: CompanionClient | null
  enabled: boolean
  onTypingStart: () => void
  onTypingStop: () => void
}) {
  const [value, setValue] = useState("")
  const typingRef = useRef(false)

  useEffect(() => {
    return () => {
      if (typingRef.current) {
        typingRef.current = false
        client?.sendTyping("stop")
      }
    }
  }, [client])

  useInput(
    (input, key) => {
      if (!enabled || !client) return
      if (key.return) {
        const parsed = parseInput(value)
        if (parsed.kind === "chat" && parsed.text.length > 0) {
          client.sendChat(parsed.text)
        } else if (parsed.kind === "command" && parsed.name.length > 0) {
          if (KNOWN_COMMANDS.has(parsed.name)) {
            client.sendCommand(parsed.name, parsed.args)
          } else {
            client.sendCommand(parsed.name, parsed.args)
          }
        }
        if (typingRef.current) {
          typingRef.current = false
          client.sendTyping("stop")
          onTypingStop()
        }
        setValue("")
        return
      }
      if (key.backspace || key.delete) {
        if (value.length > 0) {
          setValue(value.slice(0, -1))
          if (!typingRef.current && value.length === 1) {
            // about to become empty
          }
        }
        return
      }
      if (input && !key.ctrl && !key.meta) {
        setValue(value + input)
        if (!typingRef.current) {
          typingRef.current = true
          client.sendTyping("start")
          onTypingStart()
        }
      }
    },
    { isActive: enabled },
  )

  return (
    <Box borderStyle="single" borderColor={enabled ? "cyan" : "gray"} paddingX={1}>
      <Text color="cyan">{"> "}</Text>
      <Text>{value}</Text>
      <Text inverse> </Text>
    </Box>
  )
}
