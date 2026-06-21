import type { PluginInput } from "@opencode-ai/plugin"
import { createMultiplayerPlugin } from "../../src/index.ts"

export default async (input: PluginInput) => {
  return createMultiplayerPlugin(input)
}
