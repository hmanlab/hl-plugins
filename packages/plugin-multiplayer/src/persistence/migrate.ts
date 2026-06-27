// One-time migration from the legacy `~/.hl-plugins/multiplayer/` (or
// `%LOCALAPPDATA%\hl-plugins\multiplayer\` on Windows) layout to the new
// `<HMANLAB_HOME>/multiplayer/` home. Runs at the very top of plugin
// boot, before any fs reads of the handle file or socket path.
//
// Mirrors the install-bundle migration in
// `packages/cli/src/commands/install.ts:migrateLegacyBundles()` —
// same shape (rename, warn on foreign, clean up), but tuned for
// this plugin's data (4 small text files + a Unix socket).
//
// Idempotent: a second call is a no-op because the legacy dir is gone
// (or the dest is already populated).

import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const SOCKET_NAME = "companion.sock"

/** The four files this plugin owns. Anything else in the legacy
 *  state dir triggers a warning and is left in place. */
const KNOWN_FILES: ReadonlySet<string> = new Set([
  "handle",
  "state.json",
  "companion.sock",
  "companion.token",
])

export type MigrationResult = {
  moved: string[]
  warnings: string[]
  skipped: string[]
  cleanedLegacy: boolean
}

/**
 * Returns the legacy state dir for the current platform, or null if
 * the platform is unsupported.
 */
function legacyStateDir(): string | null {
  if (process.platform === "win32") {
    const local = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local")
    return join(local, "hl-plugins", "multiplayer")
  }
  return join(homedir(), ".hl-plugins", "multiplayer")
}

/**
 * Move plugin state files from the legacy `~/.hl-plugins/multiplayer/`
 * directory to the new `<HMANLAB_HOME>/multiplayer/` home. Pure fs ops,
 * no UI — the caller (index.ts) formats and prints the result.
 *
 * - If `legacy` is null or doesn't exist → no-op.
 * - For each file: rename to `<dest>/<file>` if dest is empty, else
 *   warn and leave the legacy copy in place.
 * - The Unix socket (`companion.sock`) is **not** moved — sockets
 *   are bound to the filesystem they were created on. Unlink the
 *   legacy copy; the plugin will create a fresh one on `<dest>` at
 *   boot.
 * - If the legacy dir is empty after the move, remove it.
 * - Foreign files in the legacy dir (not one of the four known
 *   state files) get a warning, not a deletion.
 */
export function migrateLegacyMultiplayerState(
  dest: string,
  legacy: string | null = legacyStateDir(),
): MigrationResult {
  const moved: string[] = []
  const warnings: string[] = []
  const skipped: string[] = []
  if (!legacy || !existsSync(legacy)) {
    return { moved, warnings, skipped, cleanedLegacy: false }
  }
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(legacy)) {
    const src = join(legacy, entry)
    const stat = statSync(src)
    if (!stat.isFile()) {
      warnings.push(`legacy state dir contains unexpected non-file entry ${src}; leaving it in place`)
      continue
    }
    if (!KNOWN_FILES.has(entry)) {
      warnings.push(`legacy state dir contains unexpected file ${src}; leaving it in place`)
      continue
    }
    if (entry === SOCKET_NAME) {
      // Sockets don't survive a move. Unlink silently — companion
      // will create a fresh one on `<dest>`.
      unlinkSync(src)
      skipped.push(src)
      continue
    }
    const dst = join(dest, entry)
    if (existsSync(dst)) {
      warnings.push(
        `legacy state file ${src} not migrated: ${dst} already exists. ` +
          `Remove the new copy manually if you want to use the legacy contents.`,
      )
      continue
    }
    renameSync(src, dst)
    moved.push(src)
  }
  let cleanedLegacy = false
  if (readdirSync(legacy).length === 0) {
    rmdirSync(legacy)
    cleanedLegacy = true
  }
  return { moved, warnings, skipped, cleanedLegacy }
}