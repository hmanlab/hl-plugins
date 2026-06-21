// Entry point. Renders the App with Ink using the connection
// details from the environment (set by the plugin's spawner or by
// `npx @hmanlab/multiplayer-watch`).

import React from "react"
import { render } from "ink"
import { App } from "./ui/App.tsx"
import { loadTokenFromEnv } from "./state.ts"
import { companionSocketPath, companionTokenPath } from "./shared-paths.ts"

const env = loadTokenFromEnv()
const socketPath = env?.socketPath ?? process.env["MP_COMPANION_SOCK"] ?? companionSocketPath()
const token = env?.token ?? process.env["MP_COMPANION_TOKEN"] ?? readTokenFromDisk() ?? ""

if (!token) {
  process.stderr.write(
    `[multiplayer-companion] no auth token. Set MP_COMPANION_TOKEN or MP_COMPANION_TOKEN_FILE, or ensure ${companionTokenPath()} exists.\n`,
  )
  process.exit(2)
}

function readTokenFromDisk(): string | null {
  try {
    const { readFileSync } = require("node:fs") as typeof import("node:fs")
    return readFileSync(companionTokenPath(), "utf8").trim() || null
  } catch {
    return null
  }
}

const { unmount, waitUntilExit } = render(<App clientOptions={{ socketPath, token }} />)

waitUntilExit().then(() => {
  process.exit(0)
})

void unmount
