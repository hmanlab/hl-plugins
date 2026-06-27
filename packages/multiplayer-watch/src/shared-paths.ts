// Resolves the default socket and token file paths. These match the
// plugin's `companionSocketPath` / `companionTokenPath` so the manual
// fallback (`npx @hmanlab/multiplayer-watch`) works out of the box.
//
// Mirrors the resolver in `packages/plugin-multiplayer/src/persistence/paths.ts`.
// Kept local to this package (rather than shared) because the path
// logic is 5 lines and the two packages don't share code today.

import { homedir } from "node:os"
import { join, resolve } from "node:path"

function expandHome(p: string): string {
  if (p === "~") return homedir()
  if (p.startsWith("~/")) return join(homedir(), p.slice(2))
  return p
}

function hmanlabHome(): string {
  const fromEnv = process.env["HMANLAB_HOME"]
  if (fromEnv && fromEnv.trim().length > 0) return resolve(expandHome(fromEnv))
  return join(homedir(), ".hmanlab")
}

function stateDir(): string {
  return join(hmanlabHome(), "multiplayer")
}

export function companionSocketPath(): string {
  return join(stateDir(), "companion.sock")
}

export function companionTokenPath(): string {
  return join(stateDir(), "companion.token")
}