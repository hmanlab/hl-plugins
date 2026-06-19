#!/usr/bin/env -S node --no-warnings
// Entry point for the hl-plugins CLI.
// Dispatches subcommands. See docs/commands.md for the full reference.

import { help } from "./commands/help.js"
import { install } from "./commands/install.js"
import { uninstall } from "./commands/uninstall.js"
import { list } from "./commands/list.js"
import { status } from "./commands/status.js"
import { update } from "./commands/update.js"
import { ui } from "./lib/ui.js"

type Command = {
  name: string
  summary: string
  run: (args: string[]) => Promise<number>
}

const commands: Command[] = [
  { name: "install", summary: "Install one or more plugins", run: install },
  { name: "uninstall", summary: "Remove one or more plugins", run: uninstall },
  { name: "list", summary: "Show known plugins and their install state", run: list },
  { name: "status", summary: "Per-plugin diagnostic report", run: status },
  { name: "update", summary: "Re-copy plugin files and bump dependencies", run: update },
  { name: "help", summary: "Show this help text", run: help },
]

function resolveCommand(raw: string | undefined): Command | null {
  if (!raw) return null
  return commands.find((c) => c.name === raw) ?? null
}

async function main(): Promise<void> {
  const [, , sub, ...rest] = process.argv
  const cmd = resolveCommand(sub)

  if (!cmd) {
    if (sub && sub !== "help") {
      ui.error(`unknown command: ${sub}`)
    }
    process.exit(await help(rest))
  }

  try {
    process.exit(await cmd.run(rest))
  } catch (err) {
    ui.error((err as Error).message)
    if (process.env["HL_PLUGINS_DEBUG"]) {
      console.error((err as Error).stack)
    }
    process.exit(1)
  }
}

main()
