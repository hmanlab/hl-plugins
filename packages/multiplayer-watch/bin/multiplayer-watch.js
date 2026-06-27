#!/usr/bin/env node
// Manual fallback entry: `npx @hmanlab/multiplayer-watch`.
// The plugin prints this command in its toast when auto-spawn is unavailable.
//
// The watch process reads MP_COMPANION_SOCK and (MP_COMPANION_TOKEN or
// MP_COMPANION_TOKEN_FILE) from the environment, or falls back to the
// default paths under <HMANLAB_HOME>/multiplayer/.

import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const here = new URL(".", import.meta.url).pathname

// Mirror of the resolver in `packages/multiplayer-watch/src/shared-paths.ts`.
// Inlined here because this .js entry can't easily import the .ts source
// (it runs without a bundler / tsx in front of it).
function expandHome(p) {
  if (p === "~") return homedir()
  if (p.startsWith("~/")) return join(homedir(), p.slice(2))
  return p
}
function hmanlabHome() {
  const fromEnv = process.env["HMANLAB_HOME"]
  if (fromEnv && fromEnv.trim().length > 0) return resolve(expandHome(fromEnv))
  return join(homedir(), ".hmanlab")
}
function defaultStateDir() {
  return join(hmanlabHome(), "multiplayer")
}

const env = process.env
const sock = env["MP_COMPANION_SOCK"] ?? join(defaultStateDir(), "companion.sock")
let token = env["MP_COMPANION_TOKEN"] ?? ""
if (!token) {
  const tokenFile = env["MP_COMPANION_TOKEN_FILE"] ?? join(defaultStateDir(), "companion.token")
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
    `[multiplayer-watch] no token found. Set MP_COMPANION_TOKEN or write to <HMANLAB_HOME>/multiplayer/companion.token\n`,
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
