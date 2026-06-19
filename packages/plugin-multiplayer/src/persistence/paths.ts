import { homedir } from "node:os"
import { join } from "node:path"

export function stateDir(): string {
  return join(homedir(), ".hl-plugins", "multiplayer")
}

export function statePath(): string {
  return join(stateDir(), "state.json")
}

export function handlePath(): string {
  return join(stateDir(), "handle")
}
