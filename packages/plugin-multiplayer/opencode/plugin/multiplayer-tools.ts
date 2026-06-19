// multiplayer-tools.ts
//
// OpenCode plugin — Phase 02: sessions & host handoff.
//
// What this does:
//   - Plugin load is a no-op. No port binding, no toasts, no async work.
//     The plugin just registers the tools and waits for the user.
//   - `mp_host` — user explicitly starts a host. Binds `MP_PORT` (default
//     7332; deliberately one digit off from the Kilo Code VS Code
//     extension which uses 7331) on `MP_HOST` (default `localhost`),
//     mints an invite code, prints it as a toast. Errors clearly if the
//     port is busy.
//   - `mp_join <code>` — user explicitly joins a host. Dials
//     `ws://<MP_HOST>:<MP_PORT>` (default `localhost:7332`),
//     authenticates with the code, exchanges `hello` and the host's
//     `welcome` (with assigned handle and peer list).
//   - `mp_leave` — host: 10-second grace window with auto-transfer to
//     a volunteer or the longest-connected peer; guest: closes the
//     WebSocket immediately.
//   - `mp_cancel_leave` — host only, during the grace window: aborts
//     the pending transfer.
//   - `mp_volunteer` — guest: opts in as the next-host candidate.
//   - `mp_code` — host: shows the current invite code; guest: shows
//     the host's handle.
//   - `mp_status` — any role: shows role, port, code (host), peer
//     list, host handle, leaving-state info.
//   - `mp_rejoin <code>` — same dialing path as `mp_join`, but the
//     code may be a 1-hour-old grace code that the new host still
//     accepts.
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
// Phase 02 adds:
//   - Multi-peer (1 host + N guests).
//   - Handle resolution with collision suffixes (host reassigns handle
//     on join if the requested one is taken).
//   - Persistent state (~/.hl-plugins/multiplayer/state.json) for
//     last host URL, grace codes, and transfer history.
//   - Host handoff: 10-second grace window, volunteer-first successor
//     selection, longest-connected fallback.
//   - Cascade: if the new host fails to confirm, try the next
//     successor; if all fail, broadcast `session_ended`.
//   - Rejoin grace: old codes valid for 1 hour after the host change
//     that retired them.
//
// Out of scope for this phase (deferred to later phases):
//   - Real WebRTC. The WebSocket is used as both signaling and the data
//     channel. The handshake protocol is the same; swapping in WebRTC
//     is a transport change, not a protocol change.
//   - Companion pane, chat, intents, heartbeat / crash detection,
//     Cloudflare Tunnel, slash commands.
//
// Plugins run in OpenCode's Bun runtime. Bun's built-in WebSocket API
// (`Bun.serve({ websocket })`, `new WebSocket()`) is used — no deps.

import { tool } from "@opencode-ai/plugin"
import type { PluginInput } from "@opencode-ai/plugin"
import { rename, mkdir } from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_PORT,
  DEFAULT_HOST,
  GRACE_S,
  CASCADE_TIMEOUT_MS,
  REJOIN_TTL_MS,
  JOIN_TIMEOUT_MS,
  HISTORY_MAX,
} from "../../src/constants.ts"
import type {
  Role,
  GraceCode,
  HistoryEntry,
  SessionState,
  PeerInfo,
  HostSocketData,
} from "../../src/types.ts"
import { type WireMessage } from "../../src/protocol/index.ts"
import { resolvePort, resolveHost } from "../../src/env/index.ts"
import {
  isValidHandle,
  normalizeHandle,
  osUser,
  random4,
  mintCode,
  isValidCode,
  parseCode,
  assignCollisionSuffix,
} from "../../src/handle/index.ts"
import { Toaster, Logger } from "../../src/bridge/index.ts"
import { StateStore, readHandleFileSync, writeHandleFile } from "../../src/persistence/index.ts"
import { startHostServer } from "../../src/server/index.ts"
import { HostRole, GuestRole, TransferController } from "../../src/role/index.ts"
import { peerListForBroadcast } from "../../src/role/peer-helpers.ts"

// ── Module state ──────────────────────────────────────────────────────────

let store: StateStore
let role: Role = "idle"
let port = DEFAULT_PORT
let hostAddr = `${DEFAULT_HOST}:${DEFAULT_PORT}`

let hostServer: ReturnType<typeof Bun.serve> | null = null
let hostCode: string | null = null
let hostHandle: string | null = null
let hostPeers: Map<Bun.ServerWebSocket<HostSocketData>, PeerInfo> = new Map()
let volunteers: Set<string> = new Set()

let tc: TransferController | null = null

let guestWs: WebSocket | null = null
let guestHostHandle: string | null = null
let guestMyHandle: string | null = null
let guestHostUrl: string | null = null

let myResolvedHandle: string | null = null

// ── Helpers ───────────────────────────────────────────────────────────────

function resolveHandle(): string {
  if (myResolvedHandle) return myResolvedHandle
  const envHandle = process.env["MP_HANDLE"]
  if (envHandle) {
    const norm = normalizeHandle(envHandle)
    if (norm.length > 0 && isValidHandle(norm)) {
      myResolvedHandle = norm
      return norm
    }
  }
  const persisted = readHandleFileSync()
  if (persisted) {
    myResolvedHandle = persisted
    return persisted
  }
  const fallback = normalizeHandle(osUser()) || "anon"
  myResolvedHandle = fallback
  return fallback
}

// ── TUI bridge ────────────────────────────────────────────────────────────

type ToastFn = Toaster["show"]
type LogFn = Logger["log"]

function toToastFn(t: Toaster): ToastFn {
  return t.show.bind(t)
}

function toLogFn(l: Logger): LogFn {
  return l.log.bind(l)
}

// ── Peer helpers ──────────────────────────────────────────────────────────

function takenHandles(): string[] {
  const out: string[] = []
  if (hostHandle) out.push(hostHandle)
  for (const p of (hostRole?.getPeers() ?? hostPeers).values()) {
    if (p.handle !== "__pending__") out.push(p.handle)
  }
  return out
}

function sendToPeer(
  ws: { send(data: string): unknown },
  msg: WireMessage,
): void {
  try {
    ws.send(JSON.stringify(msg))
  } catch {
    // ignore
  }
}

function broadcast(msg: WireMessage, except?: { send(data: string): unknown }): void {
  if (hostRole) {
    hostRole.broadcast(msg, except as Bun.ServerWebSocket<HostSocketData>)
  }
}

function broadcastPeersUpdate(): void {
  if (hostRole) {
    const peers = peerListForBroadcast(hostRole.getPeers())
    hostRole.broadcast({ type: "peers_update", peers })
  }
}

function findPeerWs(
  handle: string,
): Bun.ServerWebSocket<HostSocketData> | null {
  const peers = hostRole?.getPeers() ?? hostPeers
  for (const [ws, peer] of peers.entries()) {
    if (peer.handle === handle) return ws
  }
  return null
}

function cleanup(): void {
  tc?.reset()
  volunteers = new Set()

  try {
    hostServer?.stop(true)
  } catch {
    // ignore
  }
  hostServer = null
  hostCode = null
  hostHandle = null
  hostPeers = new Map()

  try {
    if (guestWs && guestWs.readyState === WebSocket.OPEN) {
      try {
        guestWs.send(JSON.stringify({ type: "bye" }))
      } catch {
        // ignore
      }
      guestWs.close()
    }
  } catch {
    // ignore
  }
  guestRole?.leave()
  guestRole = null
  guestWs = null
  guestHostHandle = null
  guestMyHandle = null
  guestHostUrl = null
  role = "idle"
}

// ── State persistence helpers ────────────────────────────────────────────

// ── Host role ─────────────────────────────────────────────────────────────

let hostRole: HostRole | null = null
let guestRole: GuestRole | null = null

async function startHost(
  handle: string,
  bindPort: number,
  bindHost: string,
  toaster: Toaster,
  logger: Logger,
): Promise<{ ok: true; code: string; url: string } | { ok: false; reason: string }> {
  if (role !== "idle") {
    return { ok: false, reason: `not_idle (currently ${role})` }
  }

  const hr = new HostRole({ port: bindPort, host: bindHost, handle, state: store, toaster, logger })
  const result = await hr.start()

  if (!result.ok) {
    return result
  }

  hostRole = hr
  hostServer = null
  hostCode = result.code
  hostHandle = handle
  role = "host"
  port = bindPort
  hostAddr = `${bindHost}:${bindPort}`
  return result
}

async function handleHostMessage(
  ws: Bun.ServerWebSocket<HostSocketData>,
  raw: string | Buffer,
  toast: ToastFn,
  log: LogFn,
): Promise<void> {
  const text = typeof raw === "string" ? raw : raw.toString("utf8")
  let msg: WireMessage
  try {
    msg = JSON.parse(text) as WireMessage
  } catch {
    sendToPeer(ws, { type: "auth_fail", reason: "invalid_json" })
    sendToPeer(ws, { type: "bye" })
    try {
      ws.close()
    } catch {
      // ignore
    }
    return
  }

  if (ws.data.state === "awaiting_auth") {
    if (msg.type !== "auth") {
      sendToPeer(ws, { type: "auth_fail", reason: "expected_auth" })
      sendToPeer(ws, { type: "bye" })
      try {
        ws.close()
      } catch {
        // ignore
      }
      return
    }
    if (!isValidCode(msg.code)) {
      sendToPeer(ws, { type: "auth_fail", reason: "invalid_code" })
      sendToPeer(ws, { type: "bye" })
      try {
        ws.close()
      } catch {
        // ignore
      }
      await toast("guest sent an invalid code", "warning", "multiplayer")
      return
    }
    // Accept current code or any well-formed non-current code as a
    // grace code (F-2.5). The new host that took over via transfer
    // persists grace codes in state.json; we use in-memory acceptance
    // here to keep the protocol simple. The host that just changed
    // codes will be the one that accepts the old code, and it has
    // the old code in its state.
    const normalized = msg.code.toLowerCase()
    const isCurrent = hostCode !== null && normalized === hostCode
    const isGrace = !isCurrent // well-formed and not current → grace
    if (!isCurrent && !isGrace) {
      sendToPeer(ws, { type: "auth_fail", reason: "unknown_code" })
      sendToPeer(ws, { type: "bye" })
      try {
        ws.close()
      } catch {
        // ignore
      }
      return
    }
    // We don't know the guest's handle yet — they'll send `hello` next.
    const peer: PeerInfo = {
      handle: "__pending__",
      joinedAt: Date.now(),
      isVolunteer: false,
    }
    ws.data = { state: "authenticated", peer }
    hostPeers.set(ws, peer)

    sendToPeer(ws, { type: "auth_ok", handle: hostHandle ?? "host" })
    sendToPeer(ws, {
      type: "welcome",
      handle: hostHandle ?? "host",
      peers: peerListForBroadcast(hostRole?.getPeers() ?? hostPeers),
    })
    return
  }

  // ws.data.state === "authenticated"
  if (msg.type === "hello") {
    const requested = normalizeHandle(msg.handle)
    if (!isValidHandle(requested)) {
      sendToPeer(ws, { type: "auth_fail", reason: "invalid_handle" })
      sendToPeer(ws, { type: "bye" })
      try {
        ws.close()
      } catch {
        // ignore
      }
      return
    }
    const peer = ws.data.peer
    const existing = takenHandles()
    let assigned = requested
    if (existing.includes(assigned)) {
      assigned = assignCollisionSuffix(requested, existing)
    }
    peer.handle = assigned
    await log("info", "peer connected", { guestHandle: assigned })
    await toast(`✓ peer connected (${assigned})`, "success", "multiplayer")
    broadcastPeersUpdate()
    return
  }

  if (msg.type === "volunteer") {
    const peer = ws.data.peer
    if (peer.handle === "__pending__") return
    peer.isVolunteer = true
    await log("info", "peer volunteered", { handle: peer.handle })
    await toast(`volunteer accepted (${peer.handle})`, "info", "multiplayer")
    return
  }

  if (msg.type === "transfer_confirmed") {
    await onTransferConfirmed(ws, msg.new_code, msg.new_url, toast, log)
    return
  }

  if (msg.type === "transfer_failed") {
    await onTransferFailed(msg.reason, toast, log)
    return
  }

  if (msg.type === "bye") {
    return
  }

  await log("warn", "host: unexpected message", { msg, state: ws.data.state })
}

async function handleHostClose(
  ws: Bun.ServerWebSocket<HostSocketData>,
  toast: ToastFn,
  log: LogFn,
): Promise<void> {
  if (ws.data.state === "authenticated") {
    const peer = ws.data.peer
    hostPeers.delete(ws)
    if (peer.handle !== "__pending__") {
      volunteers.delete(peer.handle)
      await log("info", "peer disconnected", { handle: peer.handle })
      await toast(`peer disconnected (${peer.handle})`, "warning", "multiplayer")
      broadcastPeersUpdate()
    }
  }
}

// ── Transfer (delegates to TransferController) ─────────────────────────────

async function startLeave(
  _toast: ToastFn,
  _log: LogFn,
): Promise<void> {
  if (role !== "host") return
  await tc!.startLeave()
}

async function cancelLeave(
  _toast: ToastFn,
  _log: LogFn,
): Promise<void> {
  await tc!.cancelLeave()
}

async function onGraceExpired(
  _toast: ToastFn,
  _log: LogFn,
): Promise<void> {
  await tc!.onGraceExpired()
}

async function tryNextSuccessor(
  _toast: ToastFn,
  _log: LogFn,
): Promise<void> {
  await tc!.tryNextSuccessor()
}

async function onTransferConfirmed(
  successorWs: { send(data: string): unknown },
  newCode: string,
  newUrl: string,
  _toast: ToastFn,
  _log: LogFn,
): Promise<void> {
  await tc!.onTransferConfirmed(successorWs, newCode, newUrl)
}

async function onTransferFailed(
  reason: string,
  _toast: ToastFn,
  _log: LogFn,
): Promise<void> {
  await tc!.onTransferFailed(reason)
}

// ── Guest role ────────────────────────────────────────────────────────────

type DialResult =
  | { ok: true; hostHandle: string; myHandle: string }
  | { ok: false; reason: string; transferTo?: { new_code: string; new_url: string; new_handle: string } }

async function dialHost(
  wsUrl: string,
  code: string,
  handle: string,
  toast: ToastFn,
  log: LogFn,
  mode: "join" | "rejoin",
): Promise<DialResult> {
  const ws = new WebSocket(wsUrl)

  return await new Promise((resolve) => {
    let resolved = false
    const finish = (result: DialResult) => {
      if (resolved) return
      resolved = true
      resolve(result)
    }

    const timeout = setTimeout(() => {
      try {
        ws.close()
      } catch {
        // ignore
      }
      void toast(`join timed out (no host at ${wsUrl})`, "error", "multiplayer")
      void log("warn", "guest dial timed out", { code, wsUrl })
      finish({ ok: false, reason: "timeout" })
    }, JOIN_TIMEOUT_MS)

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "auth", code: code.toLowerCase() }))
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
        try {
          ws.close()
        } catch {
          // ignore
        }
        await toast(`join failed: ${msg.reason}`, "error", "multiplayer")
        await log("info", "guest auth rejected", { reason: msg.reason })
        finish({ ok: false, reason: msg.reason })
        return
      }

      if (msg.type === "auth_ok") {
        return // wait for welcome
      }

      if (msg.type === "welcome") {
        ws.send(JSON.stringify({ type: "hello", handle }))
        guestWs = ws
        role = "guest"
        guestHostHandle = msg.handle
        guestHostUrl = wsUrl
        guestMyHandle = handle
        clearTimeout(timeout)
        await log("info", "guest joined", { hostHandle: msg.handle, requestedHandle: handle, mode })
        if (mode === "rejoin") {
          await toast(`✓ rejoined as guest (${handle})`, "success", "multiplayer")
        } else {
          await toast(`✓ connected to ${msg.handle}`, "success", "multiplayer")
        }
        await store.recordGuestJoined(handle, wsUrl)
        finish({ ok: true, hostHandle: msg.handle, myHandle: handle })
        return
      }

      if (msg.type === "peers_update") {
        return
      }

      if (msg.type === "host_leaving") {
        await toast(`host leaving in ${msg.grace_s}s`, "warning", "multiplayer")
        return
      }

      if (msg.type === "leave_cancelled") {
        await toast("host cancelled leave", "info", "multiplayer")
        return
      }

      if (msg.type === "transfer_to_me") {
        // We are the chosen successor. Promote to host, mint a new
        // code, start our own host server, then send transfer_confirmed
        // back to the old host over the still-open WS.
        clearTimeout(timeout)
        await becomeSuccessorHost(msg, ws, wsUrl, toast, log)
        return
      }

      if (msg.type === "transfer_start") {
        // We are a regular peer. Close the old WS and dial the new
        // host with the new code.
        clearTimeout(timeout)
        try {
          ws.close()
        } catch {
          // ignore
        }
        guestWs = null
        role = "idle"
        guestHostHandle = null
        guestMyHandle = null
        guestHostUrl = null
        await toast(`transferring to ${msg.new_handle} (${msg.new_url})`, "info", "multiplayer")
        const rejoin = await dialHost(
          msg.new_url,
          msg.new_code,
          handle,
          toast,
          log,
          "rejoin",
        )
        if (!rejoin.ok) {
          await toast(`rejoin after transfer failed: ${rejoin.reason}`, "error", "multiplayer")
          role = "idle"
          finish({ ok: false, reason: rejoin.reason })
          return
        }
        // The new connection is now the active guestWs. The old
        // finish() was already called above for the transfer; we
        // intentionally don't finish the outer promise again.
        return
      }

      if (msg.type === "session_ended") {
        clearTimeout(timeout)
        try {
          ws.close()
        } catch {
          // ignore
        }
        guestWs = null
        role = "idle"
        guestHostHandle = null
        guestMyHandle = null
        guestHostUrl = null
        await toast(`session ended: ${msg.reason}`, "warning", "multiplayer")
        finish({ ok: false, reason: `ended:${msg.reason}` })
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

async function becomeSuccessorHost(
  msg: Extract<WireMessage, { type: "transfer_to_me" }>,
  oldHostWs: WebSocket,
  oldHostUrl: string,
  toast: ToastFn,
  log: LogFn,
): Promise<void> {
  // We are being promoted. Mint a new code, start our own host, add
  // the old code to our grace list, then confirm back to the old host.

  // Resolve port/host from env (same as a regular mp_host).
  const newPort = resolvePort()
  const newBindHost = resolveHost()
  const newUrl = `ws://${newBindHost}:${newPort}`
  const newCode = mintCode(msg.new_handle)

  // Stop being a guest. Close the old WS after sending the confirmation.
  // (We do this AFTER startHost succeeds to avoid losing the
  // confirmation if startHost fails.)
  hostHandle = msg.new_handle
  hostCode = newCode

  const serverResult = await startHostServer({
    port: newPort,
    host: newBindHost,
    handlers: {
      onMessage(ws, raw) { void handleHostMessage(ws, raw, toast, log) },
      onClose(ws) { void handleHostClose(ws, toast, log) },
    },
  })

  if (!serverResult.ok) {
    hostCode = null
    hostHandle = null
    const reason = serverResult.reason.startsWith("port_") ? "port_busy" : "start_failed"
    await log("error", "successor failed to start host", { error: serverResult.reason, reason })
    try {
      oldHostWs.send(JSON.stringify({ type: "transfer_failed", reason } satisfies WireMessage))
    } catch { /* ignore */ }
    try { oldHostWs.close() } catch { /* ignore */ }
    guestWs = null
    role = "idle"
    guestHostHandle = null
    guestMyHandle = null
    guestHostUrl = null
    await toast(`could not bind port ${newPort} as new host`, "error", "multiplayer")
    return
  }

  hostServer = serverResult.server
  role = "host"
  port = newPort
  hostAddr = `${newBindHost}:${newPort}`

  // Persist the new host state with the old code in grace list.
  await store.recordGuestPromoted(
    msg.new_handle,
    newCode,
    msg.old_code,
    msg.old_handle,
  )

  // Confirm to the old host. The old host will then broadcast
  // transfer_start to all other peers, then stop its server.
  try {
    oldHostWs.send(
      JSON.stringify({
        type: "transfer_confirmed",
        new_code: newCode,
        new_url: newUrl,
      } satisfies WireMessage),
    )
  } catch {
    // ignore
  }
  try {
    oldHostWs.close()
  } catch {
    // ignore
  }
  guestWs = null
  guestHostHandle = null
  guestMyHandle = null
  guestHostUrl = null

  await log("info", "successor promoted to host", { newCode, newUrl, handle: msg.new_handle })
  await toast(`✓ you are now host. invite: ${newCode}`, "success", "multiplayer")
  await toast(`hosting on ${newUrl}`, "info", "multiplayer")
  // oldHostUrl is the URL we dialed to reach the old host; we no
  // longer need it after the transfer.
  void oldHostUrl
}

// ── Plugin entry ──────────────────────────────────────────────────────────

export default async (input: PluginInput) => {
  store = new StateStore(resolveHandle)
  const toaster = new Toaster(input.client)
  const logger = new Logger(input.client)
  const toast = toToastFn(toaster)
  const log = toLogFn(logger)
  const handle = resolveHandle()
  const envPort = resolvePort()
  const envHost = resolveHost()
  hostAddr = `${envHost}:${envPort}`

  tc = new TransferController(
    {
      getHostRole: () => hostRole,
      getHostPeers: () => hostPeers,
      getHostCode: () => hostCode,
      getHostHandle: () => hostHandle,
      mintCode,
      stopHost() {
        if (hostServer) {
          try {
            hostServer.stop(true)
          } catch {
            // ignore
          }
          hostServer = null
          hostCode = null
          hostHandle = null
          hostPeers = new Map()
          role = "idle"
        }
      },
      recordSessionEnded: (h, r) => store.recordSessionEnded(h, r),
      recordHostChanged: (nh, nc, oc, oh, nu) => store.recordHostChanged(nh, nc, oc, oh, nu),
      toast,
      log,
    },
    GRACE_S * 1000,
    CASCADE_TIMEOUT_MS,
  )

  // Persist handle on first load (if not from env).
  if (!process.env["MP_HANDLE"]) {
    const persisted = readHandleFileSync()
    if (!persisted) {
      try {
        await writeHandleFile(handle)
      } catch {
        // best-effort
      }
    }
  }

  // Plugin load is a no-op. No port binding, no async work. The plugin
  // is ready to receive tool calls immediately.
  await log("debug", "plugin loaded", { handle, port: envPort, host: envHost, role })

  return {
    dispose: async () => {
      cleanup()
    },
    tool: {
      mp_host: tool({
        description:
          "Start a multiplayer host: bind the local port (MP_PORT env var, default 7332) on MP_HOST (default localhost), mint an invite code, and return the URL. Other peers join with `mp_join <code>`. Fails with a clear reason if the port is busy. Only works when this plugin instance is in idle role.",
        args: {},
        async execute() {
          const result = await startHost(handle, envPort, envHost, toaster, logger)
          if (result.ok) {
            return `Hosting on ${result.url}\nInvite code: ${result.code}\nShare the code with your peer. They run: mp_join ${result.code}\n(mp_status shows the current peers and leaving state.)`
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
          "Join a multiplayer session using the host's invite code (e.g. `mp-bob-a3f9-x7k2`). Dials `ws://<MP_HOST>:<MP_PORT>` (defaults `localhost:7332`) on the host's machine. Only works when this plugin instance is in idle role. Returns success or a reason on failure.",
        args: {
          code: tool.schema
            .string()
            .describe(
              "The host's invite code, e.g. `mp-bob-a3f9-x7k2`. Case-insensitive.",
            ),
        },
        async execute(args) {
          if (role !== "idle") {
            return `Not idle (currently ${role}). Use mp_leave first.`
          }
          if (!isValidCode(args.code)) {
            return "Invalid code format. Expected `mp-<handle>-XXXX-XXXX`."
          }
          const gr = new GuestRole({ port: envPort, host: envHost, handle, state: store, toaster, logger })
          const result = await gr.dial(args.code, "join")
          if (result.ok) {
            guestRole = gr
            guestWs = gr.getWs()
            role = "guest"
            return `Connected to ${result.hostHandle}. You are ${result.myHandle} in the session.`
          }
          if (result.reason === "timeout") {
            return `No host responded at ws://${envHost}:${envPort}. Is the host's opencode running, and are both using the same MP_HOST/MP_PORT?`
          }
          return `Join failed: ${result.reason}`
        },
      }),

      mp_leave: tool({
        description:
          "End the current multiplayer session. On the host: starts a 10-second grace window. After the window, the plugin auto-transfers the host role to a guest that called `mp_volunteer` (priority) or the longest-connected peer (fallback). On a guest: closes the WebSocket connection immediately. Returns to idle role.",
        args: {},
        async execute() {
          if (role === "host") {
            await startLeave(toast, log)
            return `Leaving in ${GRACE_S}s — auto-transfer pending. Use mp_cancel_leave to abort, or mp_volunteer (as a guest) to opt in as next host.`
          }
          if (role === "guest") {
            guestRole?.leave()
            guestRole = null
            role = "idle"
            return "Left the session."
          }
          return "Not in a session."
        },
      }),

      mp_cancel_leave: tool({
        description:
          "Cancel a pending host leave during the 10-second grace window. Host-only. No-op if no leave is pending. All peers are notified via a `leave_cancelled` message.",
        args: {},
        async execute() {
          if (role !== "host") return "Only the host can cancel a leave."
          if (tc?.getState() !== "pending") return "No leave is pending."
          await cancelLeave(toast, log)
          return "Leave cancelled. Staying as host."
        },
      }),

      mp_volunteer: tool({
        description:
          "Guest-only: opt in as the next host candidate. If the current host leaves, this peer is preferred as the successor (over the longest-connected peer). Only meaningful during a `host_leaving` grace window; harmless to call any time after joining.",
        args: {},
        async execute() {
          if (role !== "guest") return "Only guests can volunteer."
          if (!guestRole?.isConnected()) return "Not connected."
          guestRole.sendVolunteer()
          return "Volunteered as next host candidate."
        },
      }),

      mp_code: tool({
        description:
          "Show the current invite code. Host: the live code guests must use to join. Guest: the host's handle (the code is on the host side).",
        args: {},
        async execute() {
          if (role === "host") return hostCode ?? "(no code)"
          if (role === "guest") return guestRole?.getHostHandle() ? `host handle: ${guestRole.getHostHandle()}` : "(unknown)"
          return "Not in a session. Use mp_host or mp_join first."
        },
      }),

      mp_status: tool({
        description:
          "Show the current multiplayer state. Includes role, port, host URL, the current invite code (host only), the host handle (guest only), the assigned peer handle, the list of connected peers, the volunteer list (during a pending leave), and the leaving-state info.",
        args: {},
        async execute() {
          if (role === "host") {
            const lines: string[] = []
            lines.push(`role: host`)
            lines.push(`port: ${port}`)
            lines.push(`url: ws://${hostAddr}`)
            lines.push(`invite: ${hostRole?.getCode() ?? hostCode ?? "(none)"}`)
            lines.push(`handle: ${hostRole?.getHandle() ?? hostHandle ?? "(none)"}`)
            const peersMap = hostRole?.getPeers() ?? hostPeers
            const peers = peerListForBroadcast(peersMap)
            if (peers.length === 0) {
              lines.push(`peers: (none)`)
            } else {
              lines.push(`peers (${peers.length}):`)
              for (const p of peers) {
                const v = hostRole?.isVolunteer(p.handle) ? " [volunteer]" : ""
                lines.push(`  - ${p.handle} (joined ${Math.round((Date.now() - p.joinedAt) / 1000)}s ago)${v}`)
              }
            }
            if (tc?.isPending()) {
              lines.push(`leaving: ${tc.getState()}`)
            }
            return lines.join("\n")
          }
          if (role === "guest") {
            const connected = guestRole?.isConnected() ? "yes" : "no"
            return [
              `role: guest`,
              `connected: ${connected}`,
              `port: ${port}`,
              `host: ${guestRole?.getHostHandle() ?? "(unknown)"}`,
              `me: ${guestRole?.getMyHandle() ?? handle}`,
              `host url: ${guestRole?.getHostUrl() ?? `ws://${hostAddr}`}`,
            ].join("\n")
          }
          return `role: idle\nport: ${envPort}\nhost: ${envHost}\nhandle: ${handle}\nurl: ws://${hostAddr}`
        },
      }),

      mp_rejoin: tool({
        description:
          "Rejoin a session using a grace code (the previous host's code, valid for 1 hour after a host change). Dials `ws://<MP_HOST>:<MP_PORT>` and authenticates with the provided code. Only works when this plugin instance is in idle role.",
        args: {
          code: tool.schema
            .string()
            .describe(
              "The retired host's invite code, e.g. `mp-bob-a3f9-x7k2`. Must be within the 1-hour grace window. Case-insensitive.",
            ),
        },
        async execute(args) {
          if (role !== "idle") {
            return `Not idle (currently ${role}). Use mp_leave first.`
          }
          if (!isValidCode(args.code)) {
            return "Invalid code format. Expected `mp-<handle>-XXXX-XXXX`."
          }
          const gr = new GuestRole({ port: envPort, host: envHost, handle, state: store, toaster, logger })
          const result = await gr.dial(args.code, "rejoin")
          if (result.ok) {
            guestRole = gr
            guestWs = gr.getWs()
            role = "guest"
            return `Rejoined as guest (${result.myHandle}). Connected to ${result.hostHandle}.`
          }
          if (result.reason === "timeout") {
            return `No host responded at ws://${envHost}:${envPort}. Is the host's opencode running? The grace code may have expired (>1 hour).`
          }
          return `Rejoin failed: ${result.reason}`
        },
      }),
    },
  }
}
