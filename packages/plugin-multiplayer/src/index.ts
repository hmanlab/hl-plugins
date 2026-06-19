import type { PluginInput } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { MultiplayerPlugin } from "./plugin.ts"
import { Toaster, Logger } from "./bridge/index.ts"
import { StateStore, readHandleFileSync, writeHandleFile } from "./persistence/index.ts"
import { resolvePort, resolveHost } from "./env/index.ts"
import { IdleRole, TransferController } from "./role/index.ts"
import { isValidHandle, normalizeHandle, osUser, mintCode } from "./handle/index.ts"
import { GRACE_S, CASCADE_TIMEOUT_MS } from "./constants.ts"

export async function createMultiplayerPlugin(input: PluginInput) {
  const toaster = new Toaster(input.client)
  const logger = new Logger(input.client)
  const store = new StateStore(() => {
    const envHandle = process.env["MP_HANDLE"]
    if (envHandle) {
      const norm = normalizeHandle(envHandle)
      if (norm.length > 0 && isValidHandle(norm)) return norm
    }
    const persisted = readHandleFileSync()
    if (persisted) return persisted
    return normalizeHandle(osUser()) || "anon"
  })

  const plugin = new MultiplayerPlugin(toaster, logger, store)

  const toast = toaster.show.bind(toaster)
  const log = logger.log.bind(logger)
  const handle = plugin.resolveHandle()
  const envPort = resolvePort()
  const envHost = resolveHost()
  plugin.hostAddr = `${envHost}:${envPort}`

  const idleDeps = { handle, port: envPort, hostAddr: plugin.hostAddr, store, toaster, logger }
  plugin.roleState = new IdleRole(idleDeps)

  plugin.tc = new TransferController(
    {
      getHostRole: () => plugin.hostRole,
      getHostPeers: () => plugin.hostPeers,
      getHostCode: () => plugin.hostCode,
      getHostHandle: () => plugin.hostHandle,
      mintCode,
      stopHost() {
        if (plugin.hostRole) {
          plugin.hostRole.stop()
          plugin.hostRole = null
        }
        if (plugin.hostServer) {
          try {
            plugin.hostServer.stop(true)
          } catch {
            // ignore
          }
          plugin.hostServer = null
        }
        plugin.hostCode = null
        plugin.hostHandle = null
        plugin.hostPeers = new Map()
        plugin.volunteers = new Set()
        plugin.roleState = new IdleRole(idleDeps)
        plugin.role = "idle"
      },
      recordSessionEnded: (h, r) => store.recordSessionEnded(h, r),
      recordHostChanged: (nh, nc, oc, oh, nu) => store.recordHostChanged(nh, nc, oc, oh, nu),
      toast,
      log,
    },
    GRACE_S * 1000,
    CASCADE_TIMEOUT_MS,
  )

  if (!process.env["MP_HANDLE"]) {
    const persisted = readHandleFileSync()
    if (!persisted) {
      try {
        await writeHandleFile(plugin.resolveHandle())
      } catch {
        // best-effort
      }
    }
  }

  await logger.log("debug", "plugin loaded", {
    handle,
    port: envPort,
    host: envHost,
    role: plugin.roleState.kind,
  })

  return {
    dispose: () => plugin.dispose(),
    tool: {
      mp_host: tool({
        description:
          "Start a multiplayer host: bind the local port (MP_PORT env var, default 7332) on MP_HOST (default localhost), mint an invite code, and return the URL. Other peers join with `mp_join <code>`. Fails with a clear reason if the port is busy. Only works when this plugin instance is in idle role.",
        args: {},
        async execute() {
          return plugin.mpHost()
        },
      }),

      mp_join: tool({
        description:
          "Join a multiplayer session using the host's invite code (e.g. `mp-bob-a3f9-x7k2`). Dials `ws://<MP_HOST>:<MP_PORT>` (defaults `localhost:7332`) on the host's machine. Only works when this plugin instance is in idle role. Returns success or a reason on failure.",
        args: {
          code: tool.schema
            .string()
            .describe("The host's invite code, e.g. `mp-bob-a3f9-x7k2`. Case-insensitive."),
        },
        async execute(args) {
          return plugin.mpJoin(args.code)
        },
      }),

      mp_leave: tool({
        description:
          "End the current multiplayer session. On the host: starts a 10-second grace window. After the window, the plugin auto-transfers the host role to a guest that called `mp_volunteer` (priority) or the longest-connected peer (fallback). On a guest: closes the WebSocket connection immediately. Returns to idle role.",
        args: {},
        async execute() {
          return plugin.mpLeave()
        },
      }),

      mp_cancel_leave: tool({
        description:
          "Cancel a pending host leave during the 10-second grace window. Host-only. No-op if no leave is pending. All peers are notified via a `leave_cancelled` message.",
        args: {},
        async execute() {
          return plugin.mpCancelLeave()
        },
      }),

      mp_volunteer: tool({
        description:
          "Guest-only: opt in as the next host candidate. If the current host leaves, this peer is preferred as the successor (over the longest-connected peer). Only meaningful during a `host_leaving` grace window; harmless to call any time after joining.",
        args: {},
        async execute() {
          return plugin.mpVolunteer()
        },
      }),

      mp_code: tool({
        description:
          "Show the current invite code. Host: the live code guests must use to join. Guest: the host's handle (the code is on the host side).",
        args: {},
        async execute() {
          return plugin.mpCode()
        },
      }),

      mp_status: tool({
        description:
          "Show the current multiplayer state. Includes role, port, host URL, the current invite code (host only), the host handle (guest only), the assigned peer handle, the list of connected peers, the volunteer list (during a pending leave), and the leaving-state info.",
        args: {},
        async execute() {
          return plugin.mpStatus()
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
          return plugin.mpRejoin(args.code)
        },
      }),
    },
  }
}
