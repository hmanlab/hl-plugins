import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { expandHome } from "./expand-home.ts"

/**
 * Resolves the hmanlab root on disk. Mirrors
 * `packages/plugin-memo/src/config.ts:hmanlabHome()` and the CLI's
 * `packages/cli/src/lib/paths.ts:hmanlabHome()` so all three layers
 * (plugin runtime data, install artifacts, this state dir) share one
 * env-var knob (`HMANLAB_HOME`).
 *
 *   1. `$HMANLAB_HOME` if set and non-empty (whitespace falls through).
 *   2. Leading `~` is expanded to `$HOME`.
 *   3. The result is made absolute against the cwd.
 *   4. Default: `$HOME/.hmanlab`.
 */
function hmanlabHome(): string {
  const fromEnv = process.env["HMANLAB_HOME"]
  if (fromEnv && fromEnv.trim().length > 0) return resolve(expandHome(fromEnv))
  return join(homedir(), ".hmanlab")
}

/** Where this plugin's state files live. */
export function stateDir(): string {
  return join(hmanlabHome(), "multiplayer")
}

export function statePath(): string {
  return join(stateDir(), "state.json")
}

export function handlePath(): string {
  return join(stateDir(), "handle")
}