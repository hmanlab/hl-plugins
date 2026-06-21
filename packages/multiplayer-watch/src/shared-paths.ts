// Resolves the default socket and token file paths. These match the
// plugin's `companionSocketPath` / `companionTokenPath` so the manual
// fallback (`npx @hmanlab/multiplayer-watch`) works out of the box.

import { homedir } from "node:os"
import { join } from "node:path"

export function companionSocketPath(): string {
  return join(homedir(), ".hl-plugins", "multiplayer", "companion.sock")
}

export function companionTokenPath(): string {
  return join(homedir(), ".hl-plugins", "multiplayer", "companion.token")
}
