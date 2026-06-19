import React from "react"
import { Box, Text } from "ink"
import type { IpcState } from "../protocol.ts"

export function Header({
  state,
  typingFrom,
  authFail,
}: {
  state: IpcState | null
  typingFrom: string | null
  authFail: string | null
}) {
  if (authFail) {
    return (
      <Box borderStyle="single" borderColor="red" paddingX={1} flexDirection="column">
        <Text color="red" bold>
          multiplayer — auth failed
        </Text>
        <Text dimColor>{authFail}</Text>
      </Box>
    )
  }
  if (!state) {
    return (
      <Box borderStyle="single" paddingX={1}>
        <Text dimColor>multiplayer — connecting…</Text>
      </Box>
    )
  }

  const roleLabel =
    state.role === "host"
      ? "hosting"
      : state.role === "guest"
        ? `guest of ${state.hostHandle ?? "?"}`
        : "idle"
  const codeLabel = state.role === "host" && state.code ? `· code ${state.code}` : ""

  let statusExtra = ""
  if (state.leaving === "pending" && state.grace_s !== null) {
    statusExtra = ` · leaving in ${state.grace_s}s`
  } else if (state.leaving === "transferring") {
    statusExtra = " · transferring…"
  }
  const typing = typingFrom ? ` · ${typingFrom} is typing…` : ""

  return (
    <Box borderStyle="single" borderColor="cyan" paddingX={1} flexDirection="column">
      <Box>
        <Text bold color="cyan">
          multiplayer{" "}
        </Text>
        <Text>[{state.handle}] </Text>
        <Text color="green">{roleLabel}</Text>
        <Text> {codeLabel}</Text>
        <Text color="yellow">{statusExtra}</Text>
        <Text color="magenta">{typing}</Text>
      </Box>
    </Box>
  )
}
