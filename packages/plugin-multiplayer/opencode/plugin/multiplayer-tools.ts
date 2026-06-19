// multiplayer-tools.ts
//
// OpenCode plugin — Phase 01: minimal two-plugin handshake.
//
// What this does:
//   - Plugin load is a no-op. No port binding, no toasts, no async work.
//     The plugin just registers four tools and waits for the user.
//   - `mp_host` — user explicitly starts a host. Binds `MP_PORT` (default
//     7332; deliberately one digit off from the Kilo Code VS Code
//     extension which uses 7331), mints an invite code, prints it as a
//     toast. Errors clearly if the port is busy.
//   - `mp_join <code>` — user explicitly joins a host running on the
//     same machine. Dials `ws://localhost:<port>`, authenticates with
//     the code, exchanges a `hello` message.
//   - `mp_leave` — stops the host's signaling server or closes the
//     guest's connection, returning the plugin to `idle`.
//   - `mp_status` — shows the current role, invite code (host only),
//     and peer handle.
//
// Why explicit (not auto-elect):
//   - Port 7331 collides with the Kilo Code VS Code extension on many
//     machines. Auto-binding at opencode startup made the plugin
//     crash-or-hang on those machines.
//   - Other processes may also use the default port range. Binding
//     lazily and only when the user opts in keeps the plugin
//     install-and-forget safe.
//   - The plugin's startup work is now zero — no measurable overhead.
//
// Out of scope for Phase 01 (deferred to later phases):
//   - Real WebRTC. The WebSocket is used as both signaling and the data
//     channel. The handshake protocol is the same; swapping in WebRTC is
//     a transport change, not a protocol change.
//   - Companion pane, chat, intents, host handoff, heartbeat,
//     Cloudflare Tunnel, slash commands, multi-guest.
//
// Plugins run in OpenCode's Bun runtime. Bun's built-in WebSocket API
// (`Bun.serve({ websocket })`, `new WebSocket()`) is used — no deps.

import { tool } from "@opencode-ai/plugin"
import type { PluginInput } from "@opencode-ai/plugin"

// ── Constants ─────────────────────────────────────────────────────────────

const DEFAULT_PORT = 7332 // one digit off from kilo-code's 7331
const HOST = "localhost"
const ALPHA = "abcdefghijklmnopqrstuvwxyz0123456789"

type Role = "idle" | "host" | "guest"

type WireMessage =
  | { type: "auth"; code: string }
  | { type: "auth_ok"; handle: string }
  | { type: "auth_fail"; reason: string }
  | { type: "hello"; handle: string }
  | { type: "bye" }

// ── Module state ──────────────────────────────────────────────────────────
//
// All plugin instances in this process share this state via module-scope
// `let`s. There is exactly one OpenCode process per terminal, so this is
// also one plugin instance per process.

let role: Role = "idle"
let port = DEFAULT_PORT
let hostServer: ReturnType<typeof Bun.serve> | null = null
let hostCode: string | null = null
let hostHandle: string | null = null
let guestWs: WebSocket | null = null
let peerHandle: string | null = null

// ── Helpers ───────────────────────────────────────────────────────────────

function resolvePort(): number {
  const raw = process.env["MP_PORT"]
  if (!raw) return DEFAULT_PORT
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 1 || n > 65535) return DEFAULT_PORT
  return n
}

function getHandle(): string {
  return (process.env["USER"] ?? process.env["USERNAME"] ?? "anon")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 16) || "anon"
}

function random4(): string {
  let out = ""
  for (let i = 0; i < 4; i++) {
    out += ALPHA[Math.floor(Math.random() * ALPHA.length)]
  }
  return out
}

function mintCode(handle: string): string {
  return `mp-${handle}-${random4()}-${random4()}`
}

const CODE_RE = /^mp-([a-z0-9-]{1,16})-([a-z0-9]{4})-([a-z0-9]{4})$/

function parseCode(code: string): { handle: string } | null {
  const m = code.toLowerCase().match(CODE_RE)
  if (!m) return null
  return { handle: m[1]! }
}

function isValidCode(code: string): boolean {
  return parseCode(code) !== null
}

function cleanup(): void {
  try {
    hostServer?.stop(true)
  } catch {
    // ignore
  }
  hostServer = null
  hostCode = null
  hostHandle = null
  try {
    if (guestWs && guestWs.readyState === WebSocket.OPEN) {
      try {
        guestWs.send(JSON.stringify({ type: "bye" } satisfies WireMessage))
      } catch {
        // ignore
      }
      guestWs.close()
    }
  } catch {
    // ignore
  }
  guestWs = null
  peerHandle = null
  role = "idle"
}

// ── TUI bridge ────────────────────────────────────────────────────────────

function makeToaster(client: PluginInput["client"]) {
  return async function toast(
    message: string,
    variant: "info" | "success" | "warning" | "error" = "info",
    title?: string,
  ): Promise<void> {
    try {
      await client.tui.showToast({
        body: { message, variant, title, duration: 4000 },
      })
    } catch {
      // Toast is best-effort. Don't let a toast failure crash the plugin.
    }
  }
}

function makeLogger(client: PluginInput["client"]) {
  return async function log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await client.app.log({
        body: { service: "multiplayer", level, message, extra: extra ?? {} },
      })
    } catch {
      // ignore
    }
  }
}

// ── Host role ─────────────────────────────────────────────────────────────

type HostSocketData = { state: "awaiting_auth" } | { state: "authenticated" }

async function startHost(
  handle: string,
  bindPort: number,
  toast: ReturnType<typeof makeToaster>,
  log: ReturnType<typeof makeLogger>,
): Promise<{ ok: true; code: string; url: string } | { ok: false; reason: string }> {
  if (role !== "idle") {
    return { ok: false, reason: `not_idle (currently ${role})` }
  }

  hostHandle = handle
  hostCode = mintCode(handle)
  const code = hostCode
  const url = `ws://${HOST}:${bindPort}`

  try {
    hostServer = Bun.serve<HostSocketData>({
      port: bindPort,
      hostname: HOST,
      fetch(req, srv) {
        const upgraded = srv.upgrade(req, {
          data: { state: "awaiting_auth" } satisfies HostSocketData,
        })
        if (upgraded) return
        return new Response("multiplayer: websocket only", { status: 400 })
      },
      websocket: {
        message(ws, raw) {
          handleHostMessage(ws, raw, toast, log)
        },
        close(ws) {
          handleHostClose(ws, toast, log)
        },
      },
    })
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    hostServer = null
    hostCode = null
    hostHandle = null
    if (err?.code === "EADDRINUSE") {
      await log("warn", "host start failed: port in use", { port: bindPort })
      return { ok: false, reason: `port_${bindPort}_busy` }
    }
    await log("error", "host start failed", { error: String(e) })
    return { ok: false, reason: `start_failed: ${(e as Error).message}` }
  }

  role = "host"
  port = bindPort
  await log("info", "host started", { handle, port: bindPort, code, url })
  await toast(`invite: ${code}`, "success", "multiplayer")
  await toast(`hosting on ${url}`, "info", "multiplayer")
  return { ok: true, code, url }
}

async function handleHostMessage(
  ws: Bun.ServerWebSocket<HostSocketData>,
  raw: string | Buffer,
  toast: ReturnType<typeof makeToaster>,
  log: ReturnType<typeof makeLogger>,
): Promise<void> {
  const text = typeof raw === "string" ? raw : raw.toString("utf8")
  let msg: WireMessage
  try {
    msg = JSON.parse(text) as WireMessage
  } catch {
    ws.send(JSON.stringify({ type: "auth_fail", reason: "invalid_json" } satisfies WireMessage))
    ws.send(JSON.stringify({ type: "bye" } satisfies WireMessage))
    return
  }

  if (ws.data.state === "awaiting_auth" && msg.type === "auth") {
    if (!isValidCode(msg.code)) {
      ws.send(JSON.stringify({ type: "auth_fail", reason: "invalid_code" } satisfies WireMessage))
      ws.send(JSON.stringify({ type: "bye" } satisfies WireMessage))
      await toast("guest sent an invalid code", "warning", "multiplayer")
      return
    }
    ws.data = { state: "authenticated" }
    ws.send(JSON.stringify({ type: "auth_ok", handle: hostHandle ?? "host" } satisfies WireMessage))
    ws.send(JSON.stringify({ type: "hello", handle: hostHandle ?? "host" } satisfies WireMessage))
    return
  }

  if (ws.data.state === "authenticated" && msg.type === "hello") {
    peerHandle = msg.handle
    await log("info", "peer connected", { guestHandle: msg.handle })
    await toast(`✓ peer connected (${msg.handle})`, "success", "multiplayer")
    return
  }

  if (msg.type === "bye") {
    return
  }

  await log("warn", "host: unexpected message", { msg, state: ws.data.state })
}

async function handleHostClose(
  ws: Bun.ServerWebSocket<HostSocketData>,
  toast: ReturnType<typeof makeToaster>,
  log: ReturnType<typeof makeLogger>,
): Promise<void> {
  if (ws.data.state === "authenticated") {
    peerHandle = null
    await log("info", "peer disconnected")
    await toast("peer disconnected", "warning", "multiplayer")
  }
}

// ── Guest role ────────────────────────────────────────────────────────────

async function guestJoin(
  code: string,
  handle: string,
  dialPort: number,
  toast: ReturnType<typeof makeToaster>,
  log: ReturnType<typeof makeLogger>,
): Promise<{ ok: true; peerHandle: string } | { ok: false; reason: string }> {
  if (role !== "idle") {
    return { ok: false, reason: `not_idle (currently ${role})` }
  }
  if (!isValidCode(code)) {
    return { ok: false, reason: "invalid_code" }
  }

  const wsUrl = `ws://${HOST}:${dialPort}`
  const ws = new WebSocket(wsUrl)

  return await new Promise((resolve) => {
    let resolved = false
    const finish = (result: { ok: true; peerHandle: string } | { ok: false; reason: string }) => {
      if (resolved) return
      resolved = true
      resolve(result)
    }

    const timeout = setTimeout(() => {
      try { ws.close() } catch { /* ignore */ }
      void toast(`join timed out (no host at ${wsUrl})`, "error", "multiplayer")
      void log("warn", "guest join timed out", { code, wsUrl })
      finish({ ok: false, reason: "timeout" })
    }, 5000)

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "auth", code: code.toLowerCase() } satisfies WireMessage))
    })

    ws.addEventListener("message", async (e) => {
      let msg: WireMessage
      try {
        msg = JSON.parse((e as MessageEvent).data as string) as WireMessage
      } catch {
        return
      }

      if (msg.type === "auth_fail") {
        clearTimeout(timeout)
        try { ws.close() } catch { /* ignore */ }
        await toast(`join failed: ${msg.reason}`, "error", "multiplayer")
        await log("info", "guest auth rejected", { reason: msg.reason })
        finish({ ok: false, reason: msg.reason })
        return
      }

      if (msg.type === "auth_ok") {
        // Wait for host's `hello` to follow.
        return
      }

      if (msg.type === "hello") {
        clearTimeout(timeout)
        peerHandle = msg.handle
        // Send our own hello so the host can toast "peer connected".
        ws.send(JSON.stringify({ type: "hello", handle } satisfies WireMessage))
        await log("info", "guest connected", { hostHandle: msg.handle })
        await toast(`✓ connected to ${msg.handle}`, "success", "multiplayer")
        guestWs = ws
        role = "guest"
        port = dialPort
        finish({ ok: true, peerHandle: msg.handle })
        return
      }

      if (msg.type === "bye") {
        return
      }
    })

    ws.addEventListener("close", async () => {
      if (resolved) return
      clearTimeout(timeout)
      await toast(`could not reach host at ${wsUrl}`, "error", "multiplayer")
      await log("error", "guest ws closed before completion", { wsUrl })
      finish({ ok: false, reason: "closed" })
    })

    ws.addEventListener("error", async () => {
      if (resolved) return
      clearTimeout(timeout)
      await toast(`could not reach host at ${wsUrl}`, "error", "multiplayer")
      await log("error", "guest ws error", { wsUrl })
      finish({ ok: false, reason: "error" })
    })
  })
}

function guestLeave(toast: ReturnType<typeof makeToaster>, log: ReturnType<typeof makeLogger>): void {
  if (guestWs) {
    try {
      guestWs.send(JSON.stringify({ type: "bye" } satisfies WireMessage))
    } catch {
      // ignore
    }
    try { guestWs.close() } catch { /* ignore */ }
    guestWs = null
    peerHandle = null
    void toast("left the session", "info", "multiplayer")
    void log("info", "guest left")
  }
}

function stopHost(toast: ReturnType<typeof makeToaster>, log: ReturnType<typeof makeLogger>): void {
  if (hostServer) {
    try {
      hostServer.stop(true)
    } catch {
      // ignore
    }
    hostServer = null
    hostCode = null
    hostHandle = null
    peerHandle = null
    void toast("session ended (host)", "info", "multiplayer")
    void log("info", "host stopped")
  }
}

// ── Plugin entry ──────────────────────────────────────────────────────────

export default async (input: PluginInput) => {
  const toast = makeToaster(input.client)
  const log = makeLogger(input.client)
  const handle = getHandle()
  const envPort = resolvePort()

  // Plugin load is a no-op. No port binding, no async work. The plugin
  // is ready to receive `mp_host` or `mp_join` tool calls immediately.
  await log("debug", "plugin loaded", { handle, port: envPort, role })

  return {
    dispose: async () => {
      cleanup()
    },
    tool: {
      mp_host: tool({
        description:
          "Start a multiplayer host: bind the local port (MP_PORT env var, default 7332) and mint an invite code. Other peers join with `mp_join <code>`. Fails with a clear reason if the port is busy. Only works when this plugin instance is in idle role.",
        args: {},
        async execute() {
          const result = await startHost(handle, envPort, toast, log)
          if (result.ok) {
            return `Hosting on ${result.url}\nInvite code: ${result.code}\nShare the code with your peer. They run: mp_join ${result.code}`
          }
          if (result.reason.startsWith("port_") && result.reason.endsWith("_busy")) {
            const busyPort = result.reason.replace(/^port_/, "").replace(/_busy$/, "")
            return `Port ${busyPort} is already in use. Try a different port by setting MP_PORT before launching opencode, e.g.\n  MP_PORT=${busyPort === "7332" ? "8332" : String(Number(busyPort) + 1)} opencode`
          }
          return `Could not start host: ${result.reason}`
        },
      }),

      mp_join: tool({
        description:
          "Join a multiplayer session using the host's invite code (e.g. `mp-bob-a3f9-x7k2`). Dials `ws://localhost:<MP_PORT>` (default 7332) on the host's machine. Only works when this plugin instance is in idle role. Returns success or a reason on failure.",
        args: {
          code: tool.schema
            .string()
            .describe(
              "The host's invite code, e.g. `mp-bob-a3f9-x7k2`. Case-insensitive.",
            ),
        },
        async execute(args) {
          const result = await guestJoin(args.code, handle, envPort, toast, log)
          if (result.ok) {
            return `Connected to ${result.peerHandle}.`
          }
          if (result.reason === "timeout") {
            return `No host responded at ws://localhost:${envPort}. Is the host's opencode running, and are both using the same MP_PORT?`
          }
          return `Join failed: ${result.reason}`
        },
      }),

      mp_leave: tool({
        description:
          "End the current multiplayer session. On the host, stops the signaling server. On a guest, closes the WebSocket connection. Returns to idle role.",
        args: {},
        async execute() {
          if (role === "host") {
            stopHost(toast, log)
            role = "idle"
            return "Session ended (host)."
          }
          if (role === "guest") {
            guestLeave(toast, log)
            role = "idle"
            return "Left the session."
          }
          return "Not in a session."
        },
      }),

      mp_status: tool({
        description:
          "Show the current multiplayer role (idle/host/guest), invite code (host only), port, and the connected peer's handle if any.",
        args: {},
        async execute() {
          if (role === "host") {
            const peer = peerHandle ? `, peer: ${peerHandle}` : ""
            return `role: host\nport: ${port}\ninvite: ${hostCode ?? "(none)"}\nurl: ws://${HOST}:${port}${peer}`
          }
          if (role === "guest") {
            const peer = peerHandle ? `, peer: ${peerHandle}` : ""
            const connected = guestWs?.readyState === WebSocket.OPEN ? "yes" : "no"
            return `role: guest\nport: ${port}\nconnected: ${connected}${peer}`
          }
          return `role: idle\nport: ${envPort} (will be used on mp_host or mp_join)`
        },
      }),
    },
  }
}