import React from "react"
import { Box, Text } from "ink"
import type { ChatLine } from "../state.ts"

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const hh = d.getHours().toString().padStart(2, "0")
  const mm = d.getMinutes().toString().padStart(2, "0")
  return `${hh}:${mm}`
}

export function ChatHistory({ lines, typingFrom }: { lines: ChatLine[]; typingFrom: string | null }) {
  const recent = lines.slice(-100)
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column" flexGrow={1}>
      <Text bold dimColor>
        chat
      </Text>
      {recent.length === 0 ? (
        <Text dimColor>(no messages yet — type to chat)</Text>
      ) : (
        recent.map((l) => (
          <Text key={l.id}>
            <Text dimColor>{fmtTime(l.ts)} </Text>
            <Text color={l.mine ? "cyan" : "green"}>{l.from}:</Text>
            <Text> {l.text}</Text>
          </Text>
        ))
      )}
      {typingFrom ? (
        <Text dimColor italic>
          {typingFrom} is typing…
        </Text>
      ) : null}
    </Box>
  )
}
