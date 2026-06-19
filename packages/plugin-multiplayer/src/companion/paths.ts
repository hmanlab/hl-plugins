// Companion UDS / token paths. The plugin uses these so the
// `npx @hl-plugins/multiplayer-watch` fallback (and the in-process
// spawner) can find the right per-user socket.

import { join } from "node:path"
import { stateDir } from "../persistence/paths.ts"

export function companionSocketPath(): string {
  return join(stateDir(), "companion.sock")
}

export function companionTokenPath(): string {
  return join(stateDir(), "companion.token")
}
