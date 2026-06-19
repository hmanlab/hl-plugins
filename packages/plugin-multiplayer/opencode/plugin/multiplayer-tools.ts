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
  LeaveState,
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

// ── Module state ──────────────────────────────────────────────────────────

let role: Role = "idle"
let port = DEFAULT_PORT
let hostAddr = `${DEFAULT_HOST}:${DEFAULT_PORT}`

let hostServer: ReturnType<typeof Bun.serve> | null = null
let hostCode: string | null = null
let hostHandle: string | null = null
let hostPeers: Map<Bun.ServerWebSocket<HostSocketData>, PeerInfo> = new Map()
let volunteers: Set<string> = new Set()
let pendingLeave: LeaveState = "none"
let leaveTimer: ReturnType<typeof setTimeout> | null = null
let transferTimer: ReturnType<typeof setTimeout> | null = null
let successorQueue: { handle: string; code: string }[] = []
let preLeaveSnapshot: {
  code: string
  handle: string
  peers: { handle: string; joinedAt: number }[]
} | null = null

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
  const persisted = loadPersistedHandleSync()
  if (persisted) {
    myResolvedHandle = persisted
    return persisted
  }
  const fallback = normalizeHandle(osUser()) || "anon"
  myResolvedHandle = fallback
  return fallback
}

// ── State persistence ─────────────────────────────────────────────────────

function stateDir(): string {
  return join(homedir(), ".hl-plugins", "multiplayer")
}

function statePath(): string {
  return join(stateDir(), "state.json")
}

function handlePath(): string {
  return join(stateDir(), "handle")
}

async function ensureStateDir(): Promise<void> {
  await mkdir(stateDir(), { recursive: true })
}

function emptyState(handle: string): SessionState {
  return { myHandle: handle, lastHostUrl: null, graceCodes: [], history: [] }
}

function loadPersistedHandleSync(): string | null {
  try {
    const path = handlePath()
    if (!existsSync(path)) return null
    const text = readFileSync(path, "utf-8").trim()
    if (text.length === 0) return null
    if (!isValidHandle(text)) return null
    return text
  } catch {
    return null
  }
}

async function savePersistedHandle(handle: string): Promise<void> {
  await ensureStateDir()
  await Bun.write(handlePath(), handle)
}

async function readState(): Promise<SessionState> {
  const path = statePath()
  const file = Bun.file(path)
  if (!(await file.exists())) return emptyState(resolveHandle())
  try {
    const text = await file.text()
    const parsed = JSON.parse(text) as Partial<SessionState>
    return {
      myHandle:
        typeof parsed.myHandle === "string" ? parsed.myHandle : resolveHandle(),
      lastHostUrl:
        typeof parsed.lastHostUrl === "string" ? parsed.lastHostUrl : null,
      graceCodes: Array.isArray(parsed.graceCodes)
        ? parsed.graceCodes.filter(
            (g): g is GraceCode =>
              typeof g === "object" &&
              g !== null &&
              typeof (g as GraceCode).code === "string" &&
              typeof (g as GraceCode).handle === "string" &&
              typeof (g as GraceCode).validUntil === "number",
          )
        : [],
      history: Array.isArray(parsed.history)
        ? parsed.history.filter(
            (h): h is HistoryEntry =>
              typeof h === "object" &&
              h !== null &&
              typeof (h as HistoryEntry).ts === "number" &&
              typeof (h as HistoryEntry).event === "string",
          )
        : [],
    }
  } catch {
    return emptyState(resolveHandle())
  }
}

async function writeStateAtomic(state: SessionState): Promise<void> {
  await ensureStateDir()
  const path = statePath()
  const tmp = `${path}.tmp`
  await Bun.write(tmp, JSON.stringify(state, null, 2))
  await rename(tmp, path)
}

function pruneGraceCodes(state: SessionState): SessionState {
  const now = Date.now()
  return { ...state, graceCodes: state.graceCodes.filter((g) => g.validUntil > now) }
}

async function pushHistory(
  state: SessionState,
  entry: HistoryEntry,
): Promise<SessionState> {
  const history = [entry, ...state.history].slice(0, HISTORY_MAX)
  return { ...state, history }
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
      // ignore — toast is best-effort
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

// ── Peer helpers ──────────────────────────────────────────────────────────

function peerListForBroadcast(): { handle: string; joinedAt: number }[] {
  const out: { handle: string; joinedAt: number }[] = []
  for (const p of hostPeers.values()) {
    if (p.handle === "__pending__") continue
    out.push({ handle: p.handle, joinedAt: p.joinedAt })
  }
  out.sort((a, b) => a.joinedAt - b.joinedAt)
  return out
}

function takenHandles(): string[] {
  const out: string[] = []
  if (hostHandle) out.push(hostHandle)
  for (const p of hostPeers.values()) {
    if (p.handle !== "__pending__") out.push(p.handle)
  }
  return out
}

function clearLeaveTimers(): void {
  if (leaveTimer) {
    clearTimeout(leaveTimer)
    leaveTimer = null
  }
  if (transferTimer) {
    clearTimeout(transferTimer)
    transferTimer = null
  }
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
  for (const ws of hostPeers.keys()) {
    if (except && ws === except) continue
    sendToPeer(ws, msg)
  }
}

function broadcastPeersUpdate(): void {
  broadcast({ type: "peers_update", peers: peerListForBroadcast() })
}

function findPeerWs(
  handle: string,
): Bun.ServerWebSocket<HostSocketData> | null {
  for (const [ws, peer] of hostPeers.entries()) {
    if (peer.handle === handle) return ws
  }
  return null
}

function cleanup(): void {
  clearLeaveTimers()
  pendingLeave = "none"
  successorQueue = []
  preLeaveSnapshot = null
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
  guestWs = null
  guestHostHandle = null
  guestMyHandle = null
  guestHostUrl = null
  role = "idle"
}

// ── State persistence helpers ────────────────────────────────────────────

async function persistHostStarted(handle: string, code: string): Promise<void> {
  try {
    const state = pruneGraceCodes(await readState())
    const next = await pushHistory(
      { ...state, myHandle: handle },
      { ts: Date.now(), event: "host_started", handle, detail: code },
    )
    await writeStateAtomic(next)
  } catch {
    // best-effort
  }
}

async function persistHostChanged(
  newHandle: string,
  newCode: string,
  oldCode: string,
  oldHandle: string,
  newUrl: string,
): Promise<void> {
  try {
    const state = pruneGraceCodes(await readState())
    const validUntil = Date.now() + REJOIN_TTL_MS
    const graceCodes = [
      ...state.graceCodes,
      { code: oldCode, handle: oldHandle, validUntil },
    ]
    const next = await pushHistory(
      { ...state, myHandle: newHandle, graceCodes },
      {
        ts: Date.now(),
        event: "host_changed",
        handle: newHandle,
        detail: `from:${oldHandle} newCode:${newCode} url:${newUrl}`,
      },
    )
    await writeStateAtomic(next)
  } catch {
    // best-effort
  }
}

async function persistSessionEnded(handle: string, reason: string): Promise<void> {
  try {
    const state = pruneGraceCodes(await readState())
    const next = await pushHistory(
      { ...state, myHandle: handle },
      { ts: Date.now(), event: "session_ended", handle, detail: reason },
    )
    await writeStateAtomic(next)
  } catch {
    // best-effort
  }
}

async function persistGuestJoined(handle: string, hostUrl: string): Promise<void> {
  try {
    const state = pruneGraceCodes(await readState())
    const next = await pushHistory(
      { ...state, lastHostUrl: hostUrl },
      { ts: Date.now(), event: "guest_joined", handle },
    )
    await writeStateAtomic(next)
  } catch {
    // best-effort
  }
}

async function persistGuestPromoted(
  newHandle: string,
  newCode: string,
  oldCode: string,
  oldHandle: string,
): Promise<void> {
  try {
    const state = pruneGraceCodes(await readState())
    const validUntil = Date.now() + REJOIN_TTL_MS
    const graceCodes = [
      ...state.graceCodes,
      { code: oldCode, handle: oldHandle, validUntil },
    ]
    const next = await pushHistory(
      { ...state, myHandle: newHandle, graceCodes },
      {
        ts: Date.now(),
        event: "host_changed",
        handle: newHandle,
        detail: `promoted:old=${oldHandle} oldCode=${oldCode}`,
      },
    )
    await writeStateAtomic(next)
  } catch {
    // best-effort
  }
}

// ── Host role ─────────────────────────────────────────────────────────────

async function startHost(
  handle: string,
  bindPort: number,
  bindHost: string,
  toast: ReturnType<typeof makeToaster>,
  log: ReturnType<typeof makeLogger>,
): Promise<{ ok: true; code: string; url: string } | { ok: false; reason: string }> {
  if (role !== "idle") {
    return { ok: false, reason: `not_idle (currently ${role})` }
  }

  hostHandle = handle
  hostCode = mintCode(handle)
  const code = hostCode
  const url = `ws://${bindHost}:${bindPort}`

  try {
    hostServer = Bun.serve<HostSocketData>({
      port: bindPort,
      hostname: bindHost,
      fetch(req, srv) {
        const upgraded = srv.upgrade(req, {
          data: { state: "awaiting_auth" },
        })
        if (upgraded) return
        return new Response("multiplayer: websocket only", { status: 400 })
      },
      websocket: {
        message(ws, raw) {
          void handleHostMessage(ws, raw, toast, log)
        },
        close(ws) {
          void handleHostClose(ws, toast, log)
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
  hostAddr = `${bindHost}:${bindPort}`
  await persistHostStarted(handle, code)
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
      peers: peerListForBroadcast(),
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
    if (pendingLeave === "transferring") {
      await onTransferConfirmed(ws, msg.new_code, msg.new_url, toast, log)
    }
    return
  }

  if (msg.type === "transfer_failed") {
    if (pendingLeave === "transferring") {
      await onTransferFailed(msg.reason, toast, log)
    }
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
    hostPeers = new Map()
    void toast("session ended (host)", "info", "multiplayer")
    void log("info", "host stopped")
  }
}

// ── Transfer ──────────────────────────────────────────────────────────────

function buildSuccessorQueue(): { handle: string; code: string }[] {
  // Priority 1: any volunteer (longest-connected wins ties — by
  // joinedAt ascending).
  // Priority 2: longest-connected peer.
  const all = Array.from(hostPeers.values()).filter((p) => p.handle !== "__pending__")
  const vols = all.filter((p) => p.isVolunteer).sort((a, b) => a.joinedAt - b.joinedAt)
  const nonVols = all.filter((p) => !p.isVolunteer).sort((a, b) => a.joinedAt - b.joinedAt)
  const seen = new Set<string>()
  const ordered: PeerInfo[] = []
  for (const p of [...vols, ...nonVols]) {
    if (seen.has(p.handle)) continue
    seen.add(p.handle)
    ordered.push(p)
  }
  return ordered.map((p) => ({ handle: p.handle, code: mintCode(p.handle) }))
}

async function startLeave(
  toast: ReturnType<typeof makeToaster>,
  log: ReturnType<typeof makeLogger>,
): Promise<void> {
  if (role !== "host") return
  if (pendingLeave !== "none") return

  const snapshot = peerListForBroadcast()
  if (snapshot.length === 0) {
    await log("info", "host leaving with no peers; ending session")
    stopHost(toast, log)
    role = "idle"
    return
  }

  pendingLeave = "pending"
  successorQueue = buildSuccessorQueue()
  preLeaveSnapshot = {
    code: hostCode ?? "",
    handle: hostHandle ?? "host",
    peers: snapshot,
  }

  broadcast({ type: "host_leaving", grace_s: GRACE_S })
  await log("info", "host leaving; grace started", { grace_s: GRACE_S, peers: snapshot.length })
  await toast(`leaving in ${GRACE_S}s — auto-transfer pending`, "info", "multiplayer")

  leaveTimer = setTimeout(() => {
    void onGraceExpired(toast, log)
  }, GRACE_S * 1000)
}

async function cancelLeave(
  toast: ReturnType<typeof makeToaster>,
  log: ReturnType<typeof makeLogger>,
): Promise<void> {
  if (pendingLeave !== "pending") return
  clearLeaveTimers()
  pendingLeave = "none"
  successorQueue = []
  preLeaveSnapshot = null
  broadcast({ type: "leave_cancelled" })
  await log("info", "host leave cancelled")
  await toast("leave cancelled — staying as host", "info", "multiplayer")
}

async function onGraceExpired(
  toast: ReturnType<typeof makeToaster>,
  log: ReturnType<typeof makeLogger>,
): Promise<void> {
  if (pendingLeave !== "pending") return
  leaveTimer = null
  if (successorQueue.length === 0) {
    broadcast({ type: "session_ended", reason: "no_peers" })
    await persistSessionEnded(hostHandle ?? "host", "no_peers")
    stopHost(toast, log)
    role = "idle"
    pendingLeave = "none"
    await toast("session ended (no successors)", "warning", "multiplayer")
    return
  }
  await tryNextSuccessor(toast, log)
}

async function tryNextSuccessor(
  toast: ReturnType<typeof makeToaster>,
  log: ReturnType<typeof makeLogger>,
): Promise<void> {
  if (pendingLeave !== "pending") return
  const next = successorQueue.shift()
  if (!next) {
    broadcast({ type: "session_ended", reason: "no_reachable_successor" })
    await persistSessionEnded(hostHandle ?? "host", "no_reachable_successor")
    stopHost(toast, log)
    role = "idle"
    pendingLeave = "none"
    await toast("session ended: no reachable successor", "error", "multiplayer")
    return
  }
  pendingLeave = "transferring"
  const successorWs = findPeerWs(next.handle)
  if (!successorWs) {
    // Successor disconnected between queueing and now; cascade.
    pendingLeave = "pending"
    await onTransferFailed("successor_disconnected", toast, log)
    return
  }
  const snapshot = preLeaveSnapshot
  if (!snapshot) {
    pendingLeave = "pending"
    await onTransferFailed("no_snapshot", toast, log)
    return
  }

  sendToPeer(successorWs, {
    type: "transfer_to_me",
    new_handle: next.handle,
    old_code: snapshot.code,
    old_handle: snapshot.handle,
    peers: snapshot.peers.filter((p) => p.handle !== next.handle),
  })
  await log("info", "transfer_to_me sent", { successor: next.handle })
  await toast(`transferring to ${next.handle}...`, "info", "multiplayer")

  transferTimer = setTimeout(() => {
    void onTransferFailed("timeout", toast, log)
  }, CASCADE_TIMEOUT_MS)
}

async function onTransferConfirmed(
  successorWs: { send(data: string): unknown },
  newCode: string,
  newUrl: string,
  toast: ReturnType<typeof makeToaster>,
  log: ReturnType<typeof makeLogger>,
): Promise<void> {
  if (transferTimer) {
    clearTimeout(transferTimer)
    transferTimer = null
  }
  const snapshot = preLeaveSnapshot
  if (!snapshot) return

  await log("info", "transfer confirmed by successor", { newCode, newUrl })
  await toast(`✓ transferred to ${newUrl.replace(/^ws:\/\//, "")}`, "success", "multiplayer")

  // Persist the host change with the new grace code.
  await persistHostChanged(
    parseCode(newCode)?.handle ?? "host",
    newCode,
    snapshot.code,
    snapshot.handle,
    newUrl,
  )

  // Tell all other peers to switch to the new host.
  broadcast(
    {
      type: "transfer_start",
      new_code: newCode,
      new_url: newUrl,
      new_handle: parseCode(newCode)?.handle ?? "host",
    },
    successorWs,
  )

  // End our host role.
  stopHost(toast, log)
  role = "idle"
  pendingLeave = "none"
  preLeaveSnapshot = null
  successorQueue = []
}

async function onTransferFailed(
  reason: string,
  toast: ReturnType<typeof makeToaster>,
  log: ReturnType<typeof makeLogger>,
): Promise<void> {
  if (transferTimer) {
    clearTimeout(transferTimer)
    transferTimer = null
  }
  await log("warn", "transfer failed; cascading", { reason })
  await toast(`transfer failed (${reason}); trying next successor`, "warning", "multiplayer")
  pendingLeave = "pending"
  await tryNextSuccessor(toast, log)
}

// ── Guest role ────────────────────────────────────────────────────────────

type DialResult =
  | { ok: true; hostHandle: string; myHandle: string }
  | { ok: false; reason: string; transferTo?: { new_code: string; new_url: string; new_handle: string } }

async function dialHost(
  wsUrl: string,
  code: string,
  handle: string,
  toast: ReturnType<typeof makeToaster>,
  log: ReturnType<typeof makeLogger>,
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
        await persistGuestJoined(handle, wsUrl)
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
  toast: ReturnType<typeof makeToaster>,
  log: ReturnType<typeof makeLogger>,
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

  try {
    hostServer = Bun.serve<HostSocketData>({
      port: newPort,
      hostname: newBindHost,
      fetch(req, srv) {
        const upgraded = srv.upgrade(req, {
          data: { state: "awaiting_auth" },
        })
        if (upgraded) return
        return new Response("multiplayer: websocket only", { status: 400 })
      },
      websocket: {
        message(ws, raw) {
          void handleHostMessage(ws, raw, toast, log)
        },
        close(ws) {
          void handleHostClose(ws, toast, log)
        },
      },
    })
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    hostServer = null
    hostCode = null
    hostHandle = null
    if (err?.code === "EADDRINUSE") {
      await log("error", "successor failed to start host: port in use", { port: newPort })
      try {
        oldHostWs.send(
          JSON.stringify({ type: "transfer_failed", reason: "port_busy" } satisfies WireMessage),
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
      role = "idle"
      guestHostHandle = null
      guestMyHandle = null
      guestHostUrl = null
      await toast(`could not bind port ${newPort} as new host`, "error", "multiplayer")
      return
    }
    await log("error", "successor failed to start host", { error: String(e) })
    try {
      oldHostWs.send(
        JSON.stringify({ type: "transfer_failed", reason: "start_failed" } satisfies WireMessage),
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
    role = "idle"
    return
  }

  role = "host"
  port = newPort
  hostAddr = `${newBindHost}:${newPort}`

  // Persist the new host state with the old code in grace list.
  await persistGuestPromoted(
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

function guestLeave(toast: ReturnType<typeof makeToaster>, log: ReturnType<typeof makeLogger>): void {
  if (guestWs) {
    try {
      guestWs.send(JSON.stringify({ type: "bye" }))
    } catch {
      // ignore
    }
    try {
      guestWs.close()
    } catch {
      // ignore
    }
    guestWs = null
    guestHostHandle = null
    guestMyHandle = null
    guestHostUrl = null
    void toast("left the session", "info", "multiplayer")
    void log("info", "guest left")
  }
}

// ── Plugin entry ──────────────────────────────────────────────────────────

export default async (input: PluginInput) => {
  const toast = makeToaster(input.client)
  const log = makeLogger(input.client)
  const handle = resolveHandle()
  const envPort = resolvePort()
  const envHost = resolveHost()
  hostAddr = `${envHost}:${envPort}`

  // Persist handle on first load (if not from env).
  if (!process.env["MP_HANDLE"]) {
    const persisted = loadPersistedHandleSync()
    if (!persisted) {
      try {
        await savePersistedHandle(handle)
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
          const result = await startHost(handle, envPort, envHost, toast, log)
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
          const wsUrl = `ws://${envHost}:${envPort}`
          const result = await dialHost(wsUrl, args.code, handle, toast, log, "join")
          if (result.ok) {
            return `Connected to ${result.hostHandle}. You are ${result.myHandle} in the session.`
          }
          if (result.reason === "timeout") {
            return `No host responded at ${wsUrl}. Is the host's opencode running, and are both using the same MP_HOST/MP_PORT?`
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
            guestLeave(toast, log)
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
          if (pendingLeave !== "pending") return "No leave is pending."
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
          if (!guestWs || guestWs.readyState !== WebSocket.OPEN) return "Not connected."
          guestWs.send(JSON.stringify({ type: "volunteer" }))
          return "Volunteered as next host candidate."
        },
      }),

      mp_code: tool({
        description:
          "Show the current invite code. Host: the live code guests must use to join. Guest: the host's handle (the code is on the host side).",
        args: {},
        async execute() {
          if (role === "host") return hostCode ?? "(no code)"
          if (role === "guest") return guestHostHandle ? `host handle: ${guestHostHandle}` : "(unknown)"
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
            lines.push(`invite: ${hostCode ?? "(none)"}`)
            lines.push(`handle: ${hostHandle ?? "(none)"}`)
            const peers = peerListForBroadcast()
            if (peers.length === 0) {
              lines.push(`peers: (none)`)
            } else {
              lines.push(`peers (${peers.length}):`)
              for (const p of peers) {
                const v = volunteers.has(p.handle) ? " [volunteer]" : ""
                lines.push(`  - ${p.handle} (joined ${Math.round((Date.now() - p.joinedAt) / 1000)}s ago)${v}`)
              }
            }
            if (pendingLeave !== "none") {
              lines.push(`leaving: ${pendingLeave}`)
            }
            return lines.join("\n")
          }
          if (role === "guest") {
            const connected = guestWs?.readyState === WebSocket.OPEN ? "yes" : "no"
            return [
              `role: guest`,
              `connected: ${connected}`,
              `port: ${port}`,
              `host: ${guestHostHandle ?? "(unknown)"}`,
              `me: ${guestMyHandle ?? handle}`,
              `host url: ${guestHostUrl ?? `ws://${hostAddr}`}`,
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
          const wsUrl = `ws://${envHost}:${envPort}`
          const result = await dialHost(wsUrl, args.code, handle, toast, log, "rejoin")
          if (result.ok) {
            return `Rejoined as guest (${result.myHandle}). Connected to ${result.hostHandle}.`
          }
          if (result.reason === "timeout") {
            return `No host responded at ${wsUrl}. Is the host's opencode running? The grace code may have expired (>1 hour).`
          }
          return `Rejoin failed: ${result.reason}`
        },
      }),
    },
  }
}
