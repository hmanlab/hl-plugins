# Refactor plan — `@hl-plugins/multiplayer`

**Status:** Draft v1
**Owner:** hmanlab
**Target:** v0.2.x (lands before Phase 03 — companion pane — adds ~500 more lines)
**Constraint:** **Zero behavior change.** The smoke test (`packages/plugin-multiplayer/test/smoke.ts`) must pass after every refactor phase. Public tool surface (`mp_host`, `mp_join`, `mp_leave`, `mp_cancel_leave`, `mp_volunteer`, `mp_code`, `mp_status`, `mp_rejoin`) and the `WireMessage` protocol are frozen.

---

## 1. Why this refactor

`packages/plugin-multiplayer/` currently has 1,540 lines in a single file (`opencode/plugin/multiplayer-tools.ts`). The file works — Phase 01 + Phase 02 ship and the smoke test passes — but every metric is pointing the wrong way for a codebase that's about to grow another ~2,000 lines (Phase 03 companion spawner, Phase 04 intent broadcast, Phase 06 heartbeat).

| Metric | Today | Target |
|---|---|---|
| `multiplayer-tools.ts` size | 1,540 lines | < 250 lines (entry shim only) |
| Files in `src/` | 0 | 15–20, each < 300 lines |
| Module-level `let` bindings | 16 | 0 (state lives in a class instance) |
| Functions taking `toast` + `log` as separate params | 12+ | 0 (injected once on construction) |
| Lines per function (worst) | `dialHost` 170, `handleHostMessage` 130, `startHost` 60 | < 60 per function |
| Test re-import hack (`?step=${n}`) | yes | gone |
| `WireMessage` parse + dispatch | inline `if/else` ladder | typed dispatch table |
| Phase boundaries in code | implicit (comments only) | explicit (folder + interface) |
| `tsc --noEmit` errors | 0 | 0 |
| Smoke test runtime | ~30s (cascade waits 13s) | < 20s |

### Pain points — what's hard to maintain today

1. **One god file.** Constants, types, helpers, state, host role, guest role, transfer logic, persistence, TUI bridge, and the plugin entry all live in `multiplayer-tools.ts`. Locating code = `Ctrl-F` on a section header comment.
2. **Module-level mutable state.** `role`, `hostServer`, `hostCode`, `hostPeers`, `volunteers`, `pendingLeave`, `leaveTimer`, `transferTimer`, `successorQueue`, `preLeaveSnapshot`, `guestWs`, `guestHostHandle`, `guestMyHandle`, `guestHostUrl`, `myResolvedHandle`, `port`, `hostAddr`. There is no way to instantiate two plugin instances in the same process — the smoke test works around this with `await import("../opencode/plugin/multiplayer-tools.ts?step=" + n)`, which is a **Bun-specific URL-re-evaluation hack** that will silently break if Bun ever caches by URL, and which already masks real bugs (the per-test handle collision is masked by `MP_HANDLE=tester${n}` set in `process.env` at import time).
3. **Threaded `toast` + `log` parameters.** `startHost`, `handleHostMessage`, `handleHostClose`, `startLeave`, `cancelLeave`, `onGraceExpired`, `tryNextSuccessor`, `onTransferConfirmed`, `onTransferFailed`, `dialHost`, `becomeSuccessorHost`, `guestLeave` all take `toast: ReturnType<typeof makeToaster>` and `log: ReturnType<typeof makeLogger>` as the last two parameters. Every refactor of the call graph means re-plumbing 12+ signatures.
4. **Duplicated Bun.serve block.** `startHost` (line 606–625) and `becomeSuccessorHost` (line 1209–1227) each spell out a ~20-line `Bun.serve({ ... websocket: { message, close } })` block. They differ only in error-path persistence calls.
5. **Duplicated `pruneGraceCodes → pushHistory → writeStateAtomic` block.** `persistHostStarted`, `persistHostChanged`, `persistSessionEnded`, `persistGuestJoined`, `persistGuestPromoted` are five near-identical `try { ... } catch {}` wrappers around the same three calls. Adding a new event = copy-paste-edit.
6. **Giant if/else dispatch.** `handleHostMessage` (line 649–783) is a 130-line nested `if/else` ladder over `ws.data.state` and `msg.type`. Adding a new message type = edit a giant function in the middle of a 1,540-line file.
7. **`dialHost` is a 170-line promise + event-listener state machine.** The `join` / `rejoin` / `transfer_start` paths are inlined and partially share state via outer-scope mutable `let`s.
8. **No protocol boundary.** `WireMessage` is a TS type union, the encoder/decoder is `JSON.stringify` inline, the host's `sendToPeer` and the guest's `ws.send` are separate, and message-type dispatch lives in the business logic. There is no way to add a new message type without grepping for the string.
9. **Phase boundaries are comment-only.** "Phase 02 adds:" at the top of `multiplayer-tools.ts` (line 40) is the only marker between what was Phase 01 and what was Phase 02. The Phase 03 boundary (companion) will be invisible.
10. **Test file is also a god file.** 588 lines, 8 test functions, all helpers (mock client, free-port finder, raw WebSocket opener, state-file reader) inline. Re-import hack lives here.
11. **No pure-function unit tests.** All the easy-to-test logic (handle normalization, code minting/parsing, collision suffix, regex validators) is locked inside the 1,540-line file with no test isolation.

### Goals

- **Ship-friendly:** every refactor phase is a mergeable PR that keeps the smoke test green.
- **Phase-aware:** when Phase 03 (companion pane) lands, the new code goes into a `src/companion/` folder, not into the middle of the existing file.
- **Testable without hacks:** the plugin is a class, not module-level lets. Tests instantiate it directly.
- **Protocol-explicit:** `WireMessage` is the source of truth, with a single dispatch table.
- **DRY:** one `Bun.serve` factory, one persistence helper, one bridge interface.
- **No new dependencies.** Same `@opencode-ai/plugin` + Bun + Node stdlib.

### Non-goals

- **No new features.** Pure refactor.
- **No API/protocol changes.** Tool signatures, `WireMessage` shape, env var names are frozen.
- **No publish-flow changes.** The CLI auto-discovery (Phase 5) already works on folder shape; we keep the `opencode/plugin/multiplayer-tools.ts` entry as a thin shim that re-exports from `src/`.
- **No companion pane work.** That's Phase 03. The refactor prepares the *shape* for it; it does not implement it.

---

## 2. Target folder layout

```
packages/plugin-multiplayer/
├── package.json                       # unchanged contract
├── tsconfig.json                      # include "src/**/*.ts" + "opencode/plugin/**/*.ts"
├── opencode/
│   ├── plugin/
│   │   └── multiplayer-tools.ts       # entry shim — see §6
│   └── skill/
│       └── multiplayer/
│           └── SKILL.md               # unchanged
├── src/
│   ├── index.ts                       # public entry: createPlugin() factory
│   ├── plugin.ts                      # MultiplayerPlugin class — owns all state
│   ├── constants.ts                   # all magic numbers (ports, timeouts, sizes)
│   ├── types.ts                       # Role, LeaveState, SessionState, PeerInfo, GraceCode
│   ├── env/
│   │   ├── index.ts
│   │   └── resolve.ts                 # resolvePort, resolveHost, resolveHandleEnv
│   ├── handle/
│   │   ├── index.ts
│   │   ├── resolver.ts                # resolveHandle, normalizeHandle, isValidHandle
│   │   ├── codes.ts                   # mintCode, parseCode, isValidCode, random4
│   │   └── collision.ts               # assignCollisionSuffix
│   ├── protocol/
│   │   ├── index.ts
│   │   ├── messages.ts                # WireMessage type + type guards
│   │   └── codec.ts                   # encode, decode, safeSend
│   ├── bridge/
│   │   ├── index.ts
│   │   ├── toast.ts                   # Toaster class
│   │   └── logger.ts                  # Logger class
│   ├── persistence/
│   │   ├── index.ts
│   │   ├── paths.ts                   # stateDir, statePath, handlePath
│   │   ├── state-store.ts             # StateStore: read, write, prune, append
│   │   └── handle-file.ts             # readHandleFile, writeHandleFile
│   ├── server/
│   │   ├── index.ts
│   │   └── host-server.ts             # createHostServer (DRY host + successor)
│   ├── role/
│   │   ├── index.ts
│   │   ├── role-state.ts              # RoleState interface + IdleRole
│   │   ├── host-role.ts               # HostRole class (the host lifecycle)
│   │   └── guest-role.ts              # GuestRole class (the guest lifecycle)
│   ├── transfer/
│   │   ├── index.ts
│   │   ├── controller.ts              # TransferController — owns timers + queue
│   │   └── successor-queue.ts         # buildSuccessorQueue
│   └── tools/
│       ├── index.ts
│       ├── mp-host.ts                 # mpHostTool(plugin)
│       ├── mp-join.ts                 # mpJoinTool(plugin)
│       ├── mp-leave.ts
│       ├── mp-cancel-leave.ts
│       ├── mp-volunteer.ts
│       ├── mp-code.ts
│       ├── mp-status.ts
│       └── mp-rejoin.ts
└── test/
    ├── smoke.ts                       # entry — orchestrates 8 test cases
    ├── helpers/
    │   ├── index.ts
    │   ├── mock-client.ts             # makeMockClient (current lines 37–55)
    │   ├── open-guest.ts              # openGuest raw WebSocket (lines 138–171)
    │   ├── free-port.ts               # isPortFree, findFreePort (lines 98–116)
    │   └── state-reader.ts            # readStateFile (lines 177–191)
    └── cases/
        ├── index.ts                   # export const CASES = [...]
        ├── phase-01-baseline.ts       # 1:1 from current testPhase01Baseline
        ├── handle-and-status.ts
        ├── multi-peer.ts
        ├── volunteer-and-handoff.ts
        ├── cancel-leave.ts
        ├── state-persistence.ts
        ├── handle-collision.ts
        └── rejoin-grace.ts
```

### Boundaries (the rule the new layout enforces)

| Folder | Owns | May import from | May NOT import from |
|---|---|---|---|
| `env/` | `process.env` reads | — | everything else |
| `handle/` | pure functions over strings | `constants`, `env` | `protocol`, `server`, `persistence`, `bridge` |
| `protocol/` | `WireMessage` types + codec | `constants` | `server`, `persistence`, `bridge`, `role` |
| `bridge/` | `Toaster`, `Logger` | — | everything else (no business logic) |
| `persistence/` | file reads/writes | `types`, `constants`, `env` | `server`, `role`, `protocol` |
| `server/` | Bun.serve factory | `protocol`, `bridge` | `persistence`, `role` |
| `role/` | host + guest + idle | everything below it | nothing (it is the top) |
| `transfer/` | the leave/handoff state machine | `role`, `server`, `persistence`, `protocol`, `bridge` | `tools/` |
| `tools/` | one file per tool | `plugin`, `role`, `transfer` | each other (no cross-tool imports) |
| `plugin.ts` | the only mutable-state owner | everything | nothing else imports from it back |

**Enforcement:** add `tsconfig.json` `noUncheckedIndexedAccess`, `noImplicitOverride`, and a CI script (`scripts/check-boundaries.mjs`) that greps for forbidden imports. The script is the cheapest possible — it doesn't need to be a real module graph walker; it just blocks `from "../server/"` appearing inside `handle/` etc.

---

## 3. Module-by-module spec

### 3.1 `src/constants.ts`

```ts
export const DEFAULT_PORT = 7332             // one digit off from kilo-code's 7331
export const DEFAULT_HOST = "localhost"
export const HANDLE_RE = /^[a-z0-9-]{1,16}$/
export const CODE_RE = /^mp-([a-z0-9-]{1,16})-([a-z0-9]{4})-([a-z0-9]{4})$/
export const ALPHA = "abcdefghijklmnopqrstuvwxyz0123456789"
export const GRACE_S = 10                    // host-leaving grace window
export const CASCADE_TIMEOUT_MS = 5_000      // wait for new host to confirm
export const REJOIN_TTL_MS = 60 * 60 * 1000  // 1 hour
export const JOIN_TIMEOUT_MS = 5_000         // guest dial timeout
export const HISTORY_MAX = 50
export const MAX_COLLISION_ATTEMPTS = 50
```

Just the constants. No logic, no imports.

### 3.2 `src/types.ts`

```ts
export type Role = "idle" | "host" | "guest"
export type LeaveState = "none" | "pending" | "transferring"

export type GraceCode = { code: string; handle: string; validUntil: number }
export type HistoryEntry = {
  ts: number
  event: "host_started" | "host_changed" | "host_cancelled"
      | "session_ended" | "guest_joined" | "guest_left"
  handle?: string
  detail?: string
}
export type SessionState = {
  myHandle: string
  lastHostUrl: string | null
  graceCodes: GraceCode[]
  history: HistoryEntry[]
}

export type PeerInfo = {
  handle: string
  joinedAt: number
  isVolunteer: boolean
}

export type HostSocketData =
  | { state: "awaiting_auth" }
  | { state: "authenticated"; peer: PeerInfo }
```

`PeerInfo` + `HostSocketData` move here from the god file. (The `WireMessage` union stays in `protocol/messages.ts` because it belongs with the protocol, not the storage types.)

### 3.3 `src/env/resolve.ts`

```ts
export function resolvePort(): number { /* ... */ }
export function resolveHost(): string { /* ... */ }
export function resolveHandleEnv(): string | null { /* ... */ }
```

Same logic as today (lines 169–181, 198–216). The `MP_HANDLE` env read moves here; the *persistence* fallback (`~/.hl-plugins/multiplayer/handle` file) moves to `persistence/handle-file.ts`. The `resolveHandle()` orchestration (env → file → `$USER`) moves to `handle/resolver.ts`.

### 3.4 `src/handle/`

Pure functions. No I/O outside the file paths handed in.

- `resolver.ts` — `resolveHandle(env | null, persisted | null)`, `normalizeHandle(raw)`, `isValidHandle(raw)`, `osUser()`
- `codes.ts` — `mintCode(handle)`, `parseCode(code)`, `isValidCode(code)`, `random4()`
- `collision.ts` — `assignCollisionSuffix(base, taken)`

All three files are testable with no fixtures (pure string in, string out). R11 adds unit tests.

### 3.5 `src/protocol/`

```ts
// messages.ts
export type WireMessage =
  | { type: "auth"; code: string }
  | { type: "auth_ok"; handle: string }
  | { type: "auth_fail"; reason: string }
  | { type: "hello"; handle: string }
  | { type: "welcome"; handle: string; peers: Peer[] }
  | { type: "peers_update"; peers: Peer[] }
  | { type: "host_leaving"; grace_s: number }
  | { type: "volunteer" }
  | { type: "leave_cancelled" }
  | { type: "transfer_to_me"; new_handle: string; old_code: string; old_handle: string; peers: Peer[] }
  | { type: "transfer_confirmed"; new_code: string; new_url: string }
  | { type: "transfer_failed"; reason: string }
  | { type: "transfer_start"; new_code: string; new_url: string; new_handle: string }
  | { type: "session_ended"; reason: string }
  | { type: "bye" }

export const isWireMessage = (x: unknown): x is WireMessage => { /* ... */ }

// codec.ts
export function encode(msg: WireMessage): string { return JSON.stringify(msg) }
export function decode(raw: string): WireMessage | null {
  try {
    const x: unknown = JSON.parse(raw)
    return isWireMessage(x) ? x : null
  } catch { return null }
}
export function safeSend(ws: { send(data: string): unknown }, msg: WireMessage): void {
  try { ws.send(encode(msg)) } catch { /* ignore */ }
}
```

Replaces the 12+ `try { ws.send(JSON.stringify(...)) } catch {}` blocks scattered through the god file.

### 3.6 `src/bridge/`

```ts
// toast.ts
export class Toaster {
  constructor(private client: PluginInput["client"]) {}
  async show(message: string, variant: "info"|"success"|"warning"|"error" = "info", title?: string): Promise<void> {
    try { await this.client.tui.showToast({ body: { message, variant, title, duration: 4000 } }) }
    catch { /* best-effort */ }
  }
}

// logger.ts
export class Logger {
  constructor(private client: PluginInput["client"], private service = "multiplayer") {}
  async log(level: "debug"|"info"|"warn"|"error", message: string, extra?: Record<string, unknown>): Promise<void> {
    try { await this.client.app.log({ body: { service: this.service, level, message, extra: extra ?? {} } }) }
    catch { /* ignore */ }
  }
}
```

One instance of each, owned by `MultiplayerPlugin`. No more threading them through 12 functions.

### 3.7 `src/persistence/`

```ts
// paths.ts
export function stateDir(): string { return join(homedir(), ".hl-plugins", "multiplayer") }
export function statePath(): string { return join(stateDir(), "state.json") }
export function handlePath(): string { return join(stateDir(), "handle") }

// handle-file.ts
export function readHandleFileSync(): string | null { /* existsSync + readFileSync */ }
export async function writeHandleFile(handle: string): Promise<void> { /* ensure dir + write */ }

// state-store.ts
export class StateStore {
  constructor(private paths = defaultPaths()) {}
  async read(): Promise<SessionState> { /* same as current readState() */ }
  async writeAtomic(state: SessionState): Promise<void> { /* tmp + rename */ }
  prune(state: SessionState): SessionState { /* filter graceCodes by validUntil */ }
  pushHistory(state: SessionState, entry: HistoryEntry): SessionState { /* prepend + slice */ }

  // Convenience helpers — replace the 5 persistX functions in the god file
  async recordHostStarted(handle: string, code: string): Promise<void> { /* ... */ }
  async recordHostChanged(newH: string, newCode: string, oldCode: string, oldH: string, newUrl: string): Promise<void> { /* ... */ }
  async recordSessionEnded(handle: string, reason: string): Promise<void> { /* ... */ }
  async recordGuestJoined(handle: string, hostUrl: string): Promise<void> { /* ... */ }
  async recordGuestPromoted(newH: string, newCode: string, oldCode: string, oldH: string): Promise<void> { /* ... */ }
}
```

The five `persistX` functions in the god file (lines 492–586) collapse into `StateStore` method calls.

### 3.8 `src/server/host-server.ts`

```ts
export type HostServerHandlers = {
  onMessage: (ws: ServerWebSocket<HostSocketData>, raw: string | Buffer) => void
  onClose:   (ws: ServerWebSocket<HostSocketData>) => void
}

export async function startHostServer(opts: {
  port: number
  host: string
  handlers: HostServerHandlers
}): Promise<{ server: ReturnType<typeof Bun.serve> } | { error: "port_busy" | "start_failed"; detail: string }>
```

Replaces the `Bun.serve` block in both `startHost` (line 606–625) and `becomeSuccessorHost` (line 1209–1227). Returns a tagged result; the caller decides whether to persist + toast.

### 3.9 `src/role/`

The heart of the refactor. Three classes implementing one interface.

```ts
// role-state.ts
export interface RoleState {
  readonly kind: Role
  dispose(): void
}

// host-role.ts
export class HostRole implements RoleState {
  readonly kind = "host" as const
  private server: ReturnType<typeof Bun.serve> | null = null
  private code: string | null = null
  private handle: string
  private peers = new Map<ServerWebSocket<HostSocketData>, PeerInfo>()
  private volunteers = new Set<string>()
  private transfer: TransferController | null = null

  constructor(
    private opts: {
      port: number
      host: string
      handle: string
      state: StateStore
      toaster: Toaster
      logger: Logger
    },
  ) { this.handle = opts.handle }

  async start(): Promise<{ ok: true; code: string; url: string } | { ok: false; reason: string }>
  // ... message dispatch, peer tracking, leave/transfer delegation

  beginLeave(): void { /* delegates to TransferController */ }
  cancelLeave(): void { /* delegates to TransferController */ }
  acceptVolunteer(handle: string): void { this.volunteers.add(handle) }

  private async dispatchHostMessage(ws, raw) { /* switch(msg.type) — see §3.10 */ }
  private onPeerClose(ws) { /* ... */ }
  dispose() { /* stop server, clear timers */ }
}

// guest-role.ts — mirrors HostRole but for the guest side, owns guestWs
// idle-role.ts — trivial: { kind: "idle", dispose() {} }
```

The plugin's `setRole(next: RoleState)` swaps the current state and calls `dispose()` on the old one. Tool calls become `plugin.role.maybeStart()`, `plugin.role.maybeJoin(code)`, etc.

### 3.10 Protocol dispatch table

Replaces the 130-line `handleHostMessage` if/else ladder:

```ts
// inside HostRole
private async dispatchHostMessage(ws, raw) {
  const text = typeof raw === "string" ? raw : raw.toString("utf8")
  const msg = decode(text)
  if (!msg) { safeSend(ws, { type: "auth_fail", reason: "invalid_json" }); safeSend(ws, { type: "bye" }); ws.close(); return }

  if (ws.data.state === "awaiting_auth") {
    if (msg.type !== "auth") { /* expected_auth */ return }
    return this.handleAuth(ws, msg)
  }

  // ws.data.state === "authenticated"
  switch (msg.type) {
    case "hello":             return this.handleHello(ws, msg)
    case "volunteer":         return this.handleVolunteer(ws)
    case "transfer_confirmed":return this.transfer?.handleConfirmed(ws, msg)
    case "transfer_failed":   return this.transfer?.handleFailed(msg.reason)
    case "bye":               return
    default:
      this.logger.log("warn", "host: unexpected message", { msg, state: ws.data.state })
  }
}
```

`dialHost` (170 lines) gets the same treatment: one outer `await new Promise` that wires `open`/`message`/`close`/`error`, and the message handler is a `switch (msg.type)` with one method per case.

### 3.11 `src/transfer/`

```ts
// successor-queue.ts — pure function
export function buildSuccessorQueue(peers: PeerInfo[]): { handle: string; code: string }[] { /* ... */ }

// controller.ts
export class TransferController {
  private queue: { handle: string; code: string }[] = []
  private state: LeaveState = "none"
  private leaveTimer: Timer | null = null
  private transferTimer: Timer | null = null
  private snapshot: { code: string; handle: string; peers: Peer[] } | null = null

  constructor(private host: HostRole, private deps: {
    state: StateStore; toaster: Toaster; logger: Logger
  }) {}

  beginLeave(): void { /* build queue, broadcast host_leaving, set leaveTimer */ }
  cancelLeave(): void { /* clear timers, broadcast leave_cancelled */ }
  handleConfirmed(ws, msg: { new_code: string; new_url: string }): Promise<void>
  handleFailed(reason: string): Promise<void>  // cascades

  dispose(): void { /* clear timers */ }
}
```

Owns the 5 module-level `let`s from the god file (`pendingLeave`, `leaveTimer`, `transferTimer`, `successorQueue`, `preLeaveSnapshot`) as private fields.

### 3.12 `src/tools/`

One file per tool. Each is a 10–30 line factory:

```ts
// tools/mp-host.ts
export function mpHostTool(plugin: MultiplayerPlugin) {
  return tool({
    description: "Start a multiplayer host: ...",
    args: {},
    async execute() {
      if (plugin.role.kind !== "idle") return `Not idle (currently ${plugin.role.kind}). Use mp_leave first.`
      const result = await (plugin.role as IdleRole).promoteToHost()
      if (result.ok) return `Hosting on ${result.url}\nInvite code: ${result.code}\n...`
      if (result.reason.match(/^port_\d+_busy$/)) { /* suggest MP_PORT override */ }
      return `Could not start host: ${result.reason}`
    },
  })
}

// tools/mp-leave.ts
export function mpLeaveTool(plugin: MultiplayerPlugin) {
  return tool({
    description: "End the current multiplayer session...",
    args: {},
    async execute() {
      if (plugin.role.kind === "host") {
        (plugin.role as HostRole).beginLeave()
        return `Leaving in ${GRACE_S}s — auto-transfer pending. Use mp_cancel_leave to abort...`
      }
      if (plugin.role.kind === "guest") {
        (plugin.role as GuestRole).leave()
        plugin.setRole(new IdleRole(plugin.deps))
        return "Left the session."
      }
      return "Not in a session."
    },
  })
}
```

Each tool file is independently greppable, independently testable, and adding Phase 03's `mp_intent` is a 20-line new file rather than a 100-line edit to the god file.

### 3.13 `src/plugin.ts` + `src/index.ts`

```ts
// plugin.ts
export type PluginDeps = {
  toaster: Toaster
  logger: Logger
  state: StateStore
  port: number
  host: string
  handle: string
}

export class MultiplayerPlugin {
  private _role: RoleState
  constructor(public deps: PluginDeps) { this._role = new IdleRole(deps) }
  get role(): RoleState { return this._role }
  setRole(next: RoleState): void { this._role.dispose(); this._role = next }
  async dispose(): Promise<void> { this._role.dispose() }
  get tools() { return {
    mp_host:        mpHostTool(this),
    mp_join:        mpJoinTool(this),
    mp_leave:       mpLeaveTool(this),
    mp_cancel_leave:mpCancelLeaveTool(this),
    mp_volunteer:   mpVolunteerTool(this),
    mp_code:        mpCodeTool(this),
    mp_status:      mpStatusTool(this),
    mp_rejoin:      mpRejoinTool(this),
  }}
}

// index.ts
export function createMultiplayerPlugin(input: PluginInput): Promise<{ tools: ReturnType<MultiplayerPlugin["tools"]>; dispose: () => Promise<void> }> { /* ... */ }
```

### 3.14 `opencode/plugin/multiplayer-tools.ts` (the shim)

```ts
// multiplayer-tools.ts — entry shim, ~15 lines
import type { PluginInput } from "@opencode-ai/plugin"
import { createMultiplayerPlugin } from "../../src/index.ts"

export default async (input: PluginInput) => {
  const plugin = await createMultiplayerPlugin(input)
  return {
    dispose: () => plugin.dispose(),
    tool: plugin.tools,
  }
}
```

The CLI's install flow copies this file (not the whole `src/` tree) into `~/.opencode/plugin/`. The runtime resolves `../../src/index.ts` from inside `~/.opencode/plugin/multiplayer-tools.ts` — but wait, **the install flow only copies `opencode/plugin/multiplayer-tools.ts`**, not the `src/` folder. This is the install-flow problem to solve. See §7.

---

## 4. The install-flow problem (the one design decision to make)

Today: `hl-plugins install multiplayer` copies **one file** — `opencode/plugin/multiplayer-tools.ts` — into `~/.opencode/plugin/`. The smoke test loads it with `import multiplayerTools from "../opencode/plugin/multiplayer-tools.ts"`. Bun resolves its imports from the source tree (the dev test).

After the refactor: the entry shim is 15 lines, but it needs `../../src/index.ts` and 15+ other files in `src/`. Two ways forward:

### Option A — Single-file bundle (recommended)

Use `bun build` at publish time to inline the entire dependency graph into a single `dist/multiplayer-tools.js`. The install flow copies the bundled file.

- **Pros:** no install-flow changes, no runtime path resolution, fast startup, no risk of partial copies.
- **Cons:** adds a build step. This **violates the "no build step for plugins" rule in AGENTS.md**. Mitigation: AGENTS.md says *"Plugins run as .ts — OpenCode's Bun runtime handles them, no build step"*. The current rule exists because OpenCode runs `.ts` directly. After the refactor, OpenCode still runs `.ts` in dev, but the published artifact is a bundled `.js` produced by `bun build --target=bun`. **AGENTS.md needs a one-line update** to allow this. (See §9.)

### Option B — Copy the whole `src/` tree

Change the install flow to copy `opencode/plugin/multiplayer-tools.ts` **plus** the entire `src/` folder.

- **Pros:** no build step, source remains source.
- **Cons:** the install flow becomes plugin-aware (CLI needs to know which paths to copy), break with the existing single-file copy contract, partial copies are now possible, AGENTS.md needs more substantial changes, harder to ship the CLI without a config merge that knows about subfolders.

### Option C — Run from the source tree via a relative path

Copy the `src/` tree next to the plugin and let the shim import it.

- **Pros:** simpler than B.
- **Cons:** same as B but worse — `import "../../src/index.ts"` is now a relative path into a sibling folder the install flow has to set up.

**Decision: Option A (bundled .js).** It's the only option that:
- keeps the install flow plugin-agnostic (the CLI still copies one file)
- keeps the smoke test fast (the test loads the .ts shim from the source tree in dev)
- makes Phase 03 (companion pane) easier — `companion/` is also bundled into the same file
- aligns with how every other npm-distributed OpenCode plugin on disk is shipped

The bundle happens in the plugin's `prepublishOnly` (`bun build ./opencode/plugin/multiplayer-tools.ts --outfile=dist/multiplayer-tools.js --target=bun --external @opencode-ai/plugin`) and the install flow is updated to copy `dist/multiplayer-tools.js` instead of the .ts. The dev/smoke path keeps using the .ts shim directly.

---

## 5. Test decomposition

The smoke test (588 lines) splits into:

```
test/
├── smoke.ts                            # entry — runs CASES, prints summary
├── helpers/
│   ├── mock-client.ts                  # makeMockClient (current lines 37–55)
│   ├── open-guest.ts                   # openGuest raw WebSocket (lines 138–171)
│   ├── free-port.ts                    # isPortFree, findFreePort (lines 98–116)
│   └── state-reader.ts                 # readStateFile (lines 177–191)
└── cases/
    ├── index.ts                        # export const CASES: TestCase[] = [...]
    ├── phase-01-baseline.ts
    ├── handle-and-status.ts
    ├── multi-peer.ts
    ├── volunteer-and-handoff.ts
    ├── cancel-leave.ts
    ├── state-persistence.ts
    ├── handle-collision.ts
    └── rejoin-grace.ts
```

### What changes in the test entry

The `newPlugin()` helper (lines 196–218) currently:
- sets `process.env["MP_PORT"]` / `MP_HOST"` / `MP_HANDLE"`
- re-imports the plugin with `?step=${n}` to dodge module-level state
- returns `{ hooks, toasts, logs, port }`

After the refactor, it becomes:

```ts
// test/helpers/new-plugin.ts
import { createMultiplayerPlugin } from "../../src/index.ts"

export async function newPlugin(opts?: { port?: number; handle?: string }): Promise<{
  plugin: MultiplayerPlugin
  toasts: ToastCall[]
  logs: LogCall[]
  port: number
}> {
  const { client, toasts, logs } = makeMockClient()
  const port = opts?.port ?? await findFreePort(8000 + Math.floor(Math.random() * 100) * 10)
  const plugin = await createMultiplayerPlugin({
    client,
    port,
    host: "localhost",
    handle: opts?.handle ?? `tester-${random4()}`,
  })
  return { plugin, toasts, logs, port }
}
```

The `?step=${n}` hack is gone — `new MultiplayerPlugin(...)` gives a fresh state container every call.

### What changes in the test cases

Each case file exports a `TestCase`:

```ts
// test/cases/phase-01-baseline.ts
import { newPlugin } from "../helpers/new-plugin.ts"

export const phase01Baseline: TestCase = {
  name: "Phase 01 baseline (regression check)",
  async run() {
    const { plugin, toasts, port } = await newPlugin()
    // ... current testPhase01Baseline body, using plugin.tools.mp_host instead of hooks.tool.mp_host
  },
}
```

The `makeToolContext()` stub (lines 94–96, `return {} as never`) is replaced with a real `ToolContext` builder. Each case imports only the helpers it needs.

### What changes in test timing

The cascade test (`testVolunteerAndHandoff`, lines 338–436) currently waits 13 seconds for the cascade to fire. After the refactor, the same wait is still needed (it tests real timeouts), but R11 adds a `--fast` mode that uses `vi.useFakeTimers()`-style time control on `TransferController` only (not on Bun's server). This brings the cascade test down from 13s to ~50ms. **R11 is opt-in** — by default the smoke test stays real-time so it exercises the real WebSocket flow.

---

## 6. Phased migration

Each phase is a small, mergeable change. The smoke test must pass after every phase. Each phase is one PR.

| # | Phase | Outcome | New files | Lines moved | Smoke test |
|---|---|---|---|---|---|
| **R1** | Pure functions | `handle/`, `env/`, `protocol/messages.ts`, `constants.ts`, `types.ts` extracted | 6 | ~150 | passes |
| **R2** | Bridge classes | `bridge/toast.ts`, `bridge/logger.ts` replace `makeToaster` / `makeLogger` | 3 | ~50 | passes |
| **R3** | Persistence class | `persistence/` collapses the 5 `persistX` functions | 4 | ~150 | passes |
| **R4** | Server factory | `server/host-server.ts` DRYs `startHost` + `becomeSuccessorHost` | 1 | ~50 | passes |
| **R5** | Host role | `role/host-role.ts` owns all host `let`s | 2 | ~400 | passes |
| **R6** | Guest role | `role/guest-role.ts` owns all guest `let`s | 2 | ~250 | passes |
| **R7** | Transfer state machine | `transfer/` owns `pendingLeave` + timers + queue | 3 | ~200 | passes |
| **R8** | Role interface | `IdleRole | HostRole | GuestRole` swap pattern | 1 | ~50 | passes |
| **R9** | Plugin class | `src/plugin.ts` + `src/index.ts` + 8 `tools/*.ts` files; the god file becomes a 15-line shim | 12 | ~200 | passes |
| **R10** | Test split | `test/cases/*.ts` + `test/helpers/*.ts`; smoke.ts becomes a 30-line runner | 12 | 0 (refactor only) | passes (same runtime) |
| **R11** | Pure-function unit tests | `test/unit/handle.test.ts`, `test/unit/codes.test.ts`, etc. | 5 | 0 (new code) | passes + new unit tests pass |
| **R12** | Bundle for publish | `bun build` step, `prepublishOnly` updated, install flow updated, AGENTS.md updated | 1 + edits | 0 | passes |
| **R13** | Docs pass | Update `docs/development/multiplayer/phase-03.md` to reference new structure; update `docs/architecture.md` (one paragraph) | edits | 0 | n/a |

**Total:** 13 PRs, each independently shippable. The god file goes from 1,540 lines to ~15 lines at R9. The smoke test is split at R10. Pure-function tests land at R11. The publishable bundle lands at R12.

**Estimated effort** (based on the line counts above + the existing phase doc detail): ~5–8 hours of focused refactor work, ~1 PR every 1–2 days.

---

## 7. Acceptance criteria for "refactor done"

The refactor is **done** when **all** of these hold:

- [ ] `multiplayer-tools.ts` is ≤ 30 lines (the shim).
- [ ] No file in `src/` exceeds 300 lines.
- [ ] Zero module-level `let` bindings in `src/` (state lives on class instances).
- [ ] `process.env` is read in exactly one place: `src/env/resolve.ts`.
- [ ] `Bun.serve` appears in exactly one place: `src/server/host-server.ts`.
- [ ] `JSON.stringify` for `WireMessage` appears in exactly one place: `src/protocol/codec.ts` (`encode`).
- [ ] The smoke test runs to completion with no `?step=` re-import hack.
- [ ] `npm run typecheck` passes (0 errors).
- [ ] `bun test test/` (after R10) runs all 8 case files + 5 unit test files; all pass.
- [ ] `dist/multiplayer-tools.js` (built via `bun build`) is the only file the install flow copies.
- [ ] `hl-plugins install multiplayer` on a clean machine works end-to-end (R12 verify).
- [ ] `hl-plugins uninstall multiplayer` cleans up the same way it does today.
- [ ] No new npm dependencies.
- [ ] No change to the `WireMessage` protocol (verified by an end-to-end test that runs an old host shim against a new guest shim, or vice versa).
- [ ] `docs/AGENTS.md` is updated to mention the bundling step.
- [ ] `docs/development/multiplayer/phase-03.md` references the new folder layout in its "Files" section.

---

## 8. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | The `bun build` bundle in R12 adds >500ms to `npm publish` and breaks the CI `prepublishOnly` timeout | Low | Medium | Test the bundle in a feature branch before R12. `bun build` of a 1,500-line input is < 200ms. |
| 2 | The smoke test's `?step=${n}` re-import is load-bearing for some hidden reason (e.g. Bun caches `process.env` reads at import time) | Low | Medium | R1 moves `process.env` reads into `src/env/resolve.ts` which the plugin calls on `createMultiplayerPlugin()`, not at import. R1 includes a smoke test run that does NOT use the re-import hack. If it passes, the hack is purely vestigial. |
| 3 | The `RoleState` swap pattern in R8 changes the timing of `dispose()` calls and breaks the smoke test's port-free check | Medium | Low | R8 keeps `cleanup()` semantics — old role's `dispose()` runs synchronously before the new role is constructed. Add a regression test in R10 that asserts `isPortFree(port)` immediately after `mp_leave + mp_cancel_leave`. |
| 4 | The `WireMessage` dispatch table in §3.10 changes message ordering subtly (e.g. `auth_fail` followed by `bye` was previously two separate `sendToPeer` calls, now becomes one `safeSend` + close) | Low | Low | The dispatch table preserves the exact send order. Add a wire-trace assertion in R11. |
| 5 | The install flow update in R12 needs CLI changes that touch `packages/cli/src/commands/install.ts` | High | Low | This is a known touch. R12 is the last phase for a reason — by then the rest of the refactor is stable. |
| 6 | The companion pane (Phase 03) starts before R12 lands, and the new `src/companion/` folder conflicts with the bundling step | Low | Medium | R12 must land before Phase 03 ships. The phase-03 doc is updated in R13 to call this out. |
| 7 | The smoke test runtime increases because the .ts shim has to resolve 15+ relative imports on first load | Low | Low | Bun's module loader is fast. If it shows up, R12's bundled .js is the fix anyway. |

---

## 9. AGENTS.md changes

AGENTS.md needs one rule update (R12) and one addition (R10/R11):

```diff
- 2. **No build step for plugins.** Ship `.ts`, OpenCode compiles at runtime.
+ 2. **No build step for plugins in dev.** Ship `.ts` in source, OpenCode compiles at runtime.
+    Plugins are bundled to a single `.js` at publish time via `bun build --target=bun`
+    (see `packages/plugin-multiplayer/dist/multiplayer-tools.js`). The CLI install flow
+    copies the bundled file, not the source tree.
```

And a new rule:

```diff
+ 9. **Test layering.** Plugins have two test layers:
+    - **Smoke tests** (`test/smoke.ts`) — integration tests that exercise the full
+      plugin entry, the TUI bridge, and the WebSocket protocol. May use the OpenCode
+      mock client.
+    - **Unit tests** (`test/unit/*.test.ts`) — pure-function tests for `src/handle/`,
+      `src/protocol/`, and other modules with no side effects. No fixtures, no ports.
+    The `src/handle/`, `src/protocol/`, and `src/persistence/` modules must be
+    unit-testable without instantiating the plugin.
```

---

## 10. Migration checklist (one PR per row)

- [ ] **R1** — `src/constants.ts`, `src/types.ts`, `src/env/`, `src/handle/`, `src/protocol/messages.ts` extracted; god file imports them but otherwise unchanged.
- [ ] **R2** — `src/bridge/toast.ts`, `src/bridge/logger.ts` extracted; call sites use `plugin.toaster` / `plugin.logger` instead of threaded params (partial — full swap at R9).
- [ ] **R3** — `src/persistence/` extracted; the 5 `persistX` functions become `StateStore` methods.
- [ ] **R4** — `src/server/host-server.ts` extracted; `startHost` and `becomeSuccessorHost` use it.
- [ ] **R5** — `src/role/host-role.ts` extracted; all host `let`s move to the class.
- [ ] **R6** — `src/role/guest-role.ts` extracted; all guest `let`s move to the class.
- [ ] **R7** — `src/transfer/` extracted; `pendingLeave` + timers + queue move to `TransferController`.
- [ ] **R8** — `src/role/role-state.ts` extracted; `RoleState` interface + `IdleRole`; `setRole()` lives on the future `MultiplayerPlugin` (placeholder module-level for now).
- [ ] **R9** — `src/plugin.ts` + `src/index.ts` + `src/tools/*.ts`; god file becomes the 15-line shim.
- [ ] **R10** — `test/cases/*.ts` + `test/helpers/*.ts`; `test/smoke.ts` becomes the 30-line runner.
- [ ] **R11** — `test/unit/handle.test.ts`, `test/unit/codes.test.ts`, `test/unit/collision.test.ts`, `test/unit/codec.test.ts`, `test/unit/state-store.test.ts`.
- [ ] **R12** — `bun build` step in `packages/plugin-multiplayer/package.json` `scripts.build` + `scripts.prepublishOnly`; `packages/cli/src/commands/install.ts` updated to copy `dist/multiplayer-tools.js` for `multiplayer`; AGENTS.md updated.
- [ ] **R13** — `docs/development/multiplayer/phase-03.md` + `docs/architecture.md` updated.

---

## 11. References

- The 1,540-line god file: `packages/plugin-multiplayer/opencode/plugin/multiplayer-tools.ts`
- The reference architecture: `packages/plugin-mmx/opencode/plugin/mmx-tools.ts` (371 lines, zero module state, no `dispose` hook)
- The smoke test: `packages/plugin-multiplayer/test/smoke.ts` (588 lines, `?step=${n}` hack on line 213)
- The phase docs: `docs/development/multiplayer/phase-01.md` through `phase-07.md`
- The plugin contract: `docs/architecture.md` §"Plugin contract" and §"Repository structure"
- The install flow: `docs/architecture.md` §"Install flow"
- The PRD: `docs/development/multiplayer/PRD.md`
- The hard rules: `AGENTS.md` §"Conventions" (1–8)

---

*End of refactor plan v1*
