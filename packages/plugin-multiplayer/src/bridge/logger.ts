import type { PluginInput } from "@opencode-ai/plugin"

export class Logger {
  constructor(
    private client: PluginInput["client"],
    private service: string = "multiplayer",
  ) {}

  async log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.client.app.log({
        body: { service: this.service, level, message, extra: extra ?? {} },
      })
    } catch {
      // ignore
    }
  }
}