import type { PluginInput } from "@opencode-ai/plugin"

export class Toaster {
  constructor(private client: PluginInput["client"]) {}

  async show(
    message: string,
    variant: "info" | "success" | "warning" | "error" = "info",
    title?: string,
  ): Promise<void> {
    try {
      await this.client.tui.showToast({
        body: { message, variant, title, duration: 4000 },
      })
    } catch {
      // best-effort
    }
  }
}
