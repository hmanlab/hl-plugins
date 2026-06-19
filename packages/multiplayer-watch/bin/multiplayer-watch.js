#!/usr/bin/env node
// Manual fallback entry: `npx @hl-plugins/multiplayer-watch`.
// The plugin prints this command in its toast when auto-spawn is unavailable.
//
// The watch process reads MP_COMPANION_SOCK and (MP_COMPANION_TOKEN or
// MP_COMPANION_TOKEN_FILE) from the environment, or falls back to the
// default paths under ~/.hl-plugins/multiplayer/.

import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const here = new URL(".", import.meta.url).pathname

const env = process.env
const sock = env["MP_COMPANION_SOCK"] ?? join(homedir(), ".hl-plugins", "multiplayer", "companion.sock")
let token = env["MP_COMPANION_TOKEN"] ?? ""
if (!token) {
  const tokenFile =
    env["MP_COMPANION_TOKEN_FILE"] ?? join(homedir(), ".hl-plugins", "multiplayer", "companion.token")
  if (existsSync(tokenFile)) {
    try {
      token = readFileSync(tokenFile, "utf8").trim()
    } catch {
      /* ignore */
    }
  }
}

if (!token) {
  process.stderr.write(
    `[multiplayer-watch] no token found. Set MP_COMPANION_TOKEN or write to ~/.hl-plugins/multiplayer/companion.token\n`,
  )
  process.exit(2)
}

if (!existsSync(sock)) {
  process.stderr.write(`[multiplayer-watch] no socket at ${sock} — is opencode running?\n`)
  process.exit(2)
}

const tsxPath = require.resolve("tsx")
const indexPath = join(here, "..", "src", "index.tsx")
const child = spawn(process.execPath, ["--import", tsxPath, indexPath], {
  stdio: "inherit",
  env: { ...env, MP_COMPANION_SOCK: sock, MP_COMPANION_TOKEN: token },
})
child.on("exit", (code) => process.exit(code ?? 0))
process.on("SIGINT", () => child.kill("SIGINT"))
process.on("SIGTERM", () => child.kill("SIGTERM"))
