import type { HostSocketData } from "../types.ts"

export type HostServerHandlers = {
  onMessage: (ws: Bun.ServerWebSocket<HostSocketData>, raw: string | Buffer) => void
  onClose: (ws: Bun.ServerWebSocket<HostSocketData>) => void
}

export async function startHostServer(opts: {
  port: number
  host: string
  handlers: HostServerHandlers
}): Promise<{ ok: true; server: ReturnType<typeof Bun.serve> } | { ok: false; reason: string }> {
  try {
    const server = Bun.serve<HostSocketData>({
      port: opts.port,
      hostname: opts.host,
      fetch(req, srv) {
        const upgraded = srv.upgrade(req, {
          data: { state: "awaiting_auth" },
        })
        if (upgraded) return
        return new Response("multiplayer: websocket only", { status: 400 })
      },
      websocket: {
        message(ws, raw) {
          opts.handlers.onMessage(ws, raw)
        },
        close(ws) {
          opts.handlers.onClose(ws)
        },
      },
    })
    return { ok: true, server }
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err?.code === "EADDRINUSE") {
      return { ok: false, reason: `port_${opts.port}_busy` }
    }
    return { ok: false, reason: `start_failed: ${(e as Error).message}` }
  }
}