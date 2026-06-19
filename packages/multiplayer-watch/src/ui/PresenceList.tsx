import React from "react"
import { Box, Text } from "ink"
import type { IpcPeer, IpcRole } from "../protocol.ts"

export function PresenceList({
  peers,
  role,
  myHandle,
}: {
  peers: IpcPeer[]
  role: IpcRole
  myHandle: string
}) {
  const items: Array<{ handle: string; isMe: boolean; isHost: boolean }> = []
  if (role === "host") {
    items.push({ handle: myHandle, isMe: true, isHost: true })
    for (const p of peers) {
      if (p.handle !== myHandle) items.push({ handle: p.handle, isMe: false, isHost: false })
    }
  } else if (role === "guest") {
    items.push({ handle: myHandle, isMe: true, isHost: false })
  }
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column" minWidth={20}>
      <Text bold dimColor>
        presence
      </Text>
      {items.length === 0 ? (
        <Text dimColor>(none)</Text>
      ) : (
        items.map((p) => (
          <Text key={p.handle}>
            <Text color={p.isHost ? "yellow" : undefined}>{p.isHost ? "★ " : "  "}</Text>
            <Text color={p.isMe ? "cyan" : undefined}>{p.handle}</Text>
            {p.isMe ? <Text dimColor> (you)</Text> : null}
          </Text>
        ))
      )}
    </Box>
  )
}
