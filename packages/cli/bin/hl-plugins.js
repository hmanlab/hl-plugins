#!/usr/bin/env node
// Shim that runs the TypeScript entry point via tsx.
// Lives in plain JS so `node` can invoke it without a build step.
// In published form, tsx becomes a runtime dep of the CLI package.

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"
import { existsSync } from "node:fs"

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(here, "..", "src", "index.ts")

const candidates = [
  join(here, "..", "..", "..", "node_modules", ".bin", "tsx"),
  join(here, "..", "node_modules", ".bin", "tsx"),
]
const tsxBin = candidates.find((p) => existsSync(p))

if (!tsxBin) {
  console.error(
    "hl-plugins: tsx not found.\n" +
      "Run `npm install` at the monorepo root, then retry.",
  )
  process.exit(1)
}

const child = spawn(resolve(tsxBin), [entry, ...process.argv.slice(2)], {
  stdio: "inherit",
})

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 0)
})
