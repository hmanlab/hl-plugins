#!/usr/bin/env node
// Shim for the `hl-plugins` binary.
// Prefers the compiled dist/ entry (published + after `npm run build`).
// Falls back to running src/index.ts through tsx (dev, no build required).

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"
import { existsSync } from "node:fs"

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = resolve(here, "..")
const args = process.argv.slice(2)

// Locate the entry. dist/ wins; src/ is the dev fallback.
const distEntry = join(pkgDir, "dist", "index.js")
const srcEntry = join(pkgDir, "src", "index.ts")

if (existsSync(distEntry)) {
  const child = spawn(process.execPath, [distEntry, ...args], { stdio: "inherit" })
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    process.exit(code ?? 0)
  })
} else {
  // Dev path: find tsx in any ancestor node_modules.
  const candidates = [
    join(pkgDir, "node_modules", ".bin", "tsx"),
    join(pkgDir, "..", "..", "node_modules", ".bin", "tsx"),
  ]
  const tsxBin = candidates.find((p) => existsSync(p))
  if (!tsxBin) {
    console.error(
      "hl-plugins: tsx not found and dist/ is missing.\n" +
        "Run `npm install` at the monorepo root, or `npm run build` to compile.",
    )
    process.exit(1)
  }
  const child = spawn(resolve(tsxBin), [srcEntry, ...args], { stdio: "inherit" })
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    process.exit(code ?? 0)
  })
}
