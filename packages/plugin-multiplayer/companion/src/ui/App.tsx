import React from "react"
import { Box, Text } from "ink"
import { useCompanion } from "../state.ts"
import { Header } from "./Header.tsx"
import { PresenceList } from "./PresenceList.tsx"
import { ChatHistory } from "./ChatHistory.tsx"
import { InputBox } from "./InputBox.tsx"
import type { CompanionClientOptions } from "../transport/uds.ts"

export function App({ clientOptions }: { clientOptions: CompanionClientOptions }) {
  const { state, client } = useCompanion({ clientOptions })

  const enabled = state.connected && state.authenticated && state.state !== null && state.authFail === null

  return (
    <Box flexDirection="column" height="100%">
      <Header state={state.state} typingFrom={state.typingFrom} authFail={state.authFail} />
      <Box flexDirection="row" flexGrow={1} marginTop={1}>
        <PresenceList
          peers={state.state?.peers ?? []}
          role={state.state?.role ?? "idle"}
          myHandle={state.state?.handle ?? "?"}
        />
        <Box flexDirection="column" flexGrow={1} marginLeft={1}>
          <ChatHistory lines={state.chat} typingFrom={state.typingFrom} />
          {state.transferPending ? (
            <Box borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1} flexDirection="column">
              <Text color="yellow">host changed: now {state.transferPending.new_handle}</Text>
              <Text>code: {state.transferPending.new_code}</Text>
              <Text>url: {state.transferPending.new_url}</Text>
            </Box>
          ) : null}
          {state.sessionEnded ? (
            <Box borderStyle="round" borderColor="red" paddingX={1} marginTop={1} flexDirection="column">
              <Text color="red">session ended: {state.sessionEnded}</Text>
            </Box>
          ) : null}
        </Box>
      </Box>
      <Box marginTop={1}>
        <InputBox client={client} enabled={enabled} onTypingStart={() => {}} onTypingStop={() => {}} />
      </Box>
    </Box>
  )
}
