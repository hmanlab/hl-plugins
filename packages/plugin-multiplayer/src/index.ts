import type { PluginInput } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { MultiplayerPlugin } from "./plugin.ts"
import { Toaster, Logger } from "./bridge/index.ts"
import { StateStore, readHandleFileSync, writeHandleFile } from "./persistence/index.ts"
import { resolvePort, resolveHost } from "./env/index.ts"
import { IdleRole, TransferController } from "./role/index.ts"
import { isValidHandle, normalizeHandle, osUser, mintCode } from "./handle/index.ts"
import { GRACE_S, CASCADE_TIMEOUT_MS } from "./constants.ts"
import { companionSocketPath } from "./companion/paths.ts"
import { detectStrategy, spawnStrategy } from "./companion/spawner.ts"

function companionExec(): string {
  // Allow override via env (e.g. for testing or custom installs)
  const override = process.env["MP_COMPANION_BIN"]
  if (override) return override
  // Default to npx which auto-installs the published @hmanlab/multiplayer-watch
  // package. The relative-path approach was fragile across install layouts.
  return "npx -y @hmanlab/multiplayer-watch"
}

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
    dispose: async () => {
      try {
        await plugin.stopCompanionServer()
      } catch {
        // best-effort
      }
      plugin.dispose()
    },
    // Exposed for tests / advanced consumers. Not part of the documented API.
    _plugin: plugin,
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

      mp_chat: tool({
        description:
          "Send a chat message to all peers in the session. The text is shown verbatim in each peer's companion pane (and as an OpenCode toast until the companion is running). Mirrors the companion's input box. Requires an active session (host or guest).",
        args: {
          text: tool.schema
            .string()
            .describe("The chat message to send. Plain text, no slash prefix. Max 4000 characters."),
        },
        async execute(args) {
          return plugin.mpChat(args.text)
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

      mp_watch: tool({
        description:
          "Launch the companion TUI pane in a new tab (tmux, iTerm2, Windows Terminal, or tab-capable Linux terminal). Falls back to npx auto-install.",
        args: {},
        async execute() {
          const server = await plugin.startCompanionServer()
          if (!server) {
            return "Companion server failed to start. Check OpenCode logs."
          }
          const strategy = detectStrategy({
            env: {
              TMUX: process.env["TMUX"],
              TERM_PROGRAM: process.env["TERM_PROGRAM"],
              ITERM_SESSION_ID: process.env["ITERM_SESSION_ID"],
              TERMINAL: process.env["TERMINAL"],
              PATH: process.env["PATH"],
              MP_NO_COMPANION: process.env["MP_NO_COMPANION"],
            },
          })
          if (strategy === "manual") {
            return `Run \`${companionExec()}\` in another terminal to open the companion.`
          }
          const result = spawnStrategy({
            strategy,
            binPath: companionExec(),
            socketPath: companionSocketPath(),
            token: server.getToken(),
            cwd: process.cwd(),
          })
          if (!result.ok) {
            if (result.reason === "npx_not_found") {
              return `npx is not on PATH. Install Node.js (which ships with npx) or run \`npm install -g @hmanlab/multiplayer-watch\` and try again.`
            }
            return `Spawn failed (${result.strategy}: ${result.reason}). Run:\n${result.command}`
          }
          return `Companion launched via ${result.strategy}.`
        },
      }),
    },
  }
}
