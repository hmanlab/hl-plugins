---
name: multiplayer
description: Use when the user wants to start, join, or end a multiplayer session so two or more developers can collaborate in the same OpenCode session. Phase 02: multi-peer (1 host + N guests), host handoff with 10s grace, volunteer-first successor selection, 1-hour rejoin grace for old codes. Front-load keywords: multiplayer, peer, pair, connect, join, session, host, guest, invite, code, mp-, share, collaborate, transfer, volunteer, handoff, mp_host, mp_join, mp_leave, mp_cancel_leave, mp_volunteer, mp_code, mp_status, mp_rejoin.
---

# multiplayer — multi-user sessions for OpenCode

The `multiplayer-tools` plugin lets two or more `opencode` instances recognize each other and stay connected while their agents work. **Phase 02** adds proper session semantics: when the host leaves, a guest is auto-promoted to host with a fresh code, and the old code stays valid for 1 hour for rejoin.

Chat, intents, the companion pane, heartbeat/crash detection, and the Cloudflare Tunnel land in later phases.

## Roles — explicit, never auto

The plugin does **no** work at load time. Installing the plugin is safe: it adds eight tools and sits idle. The user must explicitly call a tool to enter a role.

| Role | Entered via | Bound resources |
|---|---|---|
| `idle` | (default after install) | none |
| `host` | `mp_host` | binds local port, mints invite code |
| `guest` | `mp_join <code>` or `mp_rejoin <code>` | opens outbound WebSocket to host |

Only one role is active at a time. `mp_leave` returns to idle. Calling `mp_host` or `mp_join` while in the wrong role returns an error.

## Port: 7332 (one digit off from Kilo Code's 7331)

Default port is **`MP_PORT=7332`**. We deliberately avoid 7331 because the [Kilo Code](https://marketplace.visualstudio.com/items?itemName=kilocode.kilo-code) VS Code extension also binds 7331.

```bash
MP_PORT=8332 opencode   # both peers must use the same MP_PORT
```

## Host address (LAN): `MP_HOST`

Default host is `localhost`. For two machines on the same WiFi, set `MP_HOST` to the host machine's LAN IP (or hostname) on the **guest's** side:

```bash
# Machine A (Bob, host)
MP_PORT=7332 opencode

# Machine B (Carol, guest)
MP_PORT=7332 MP_HOST=192.168.1.42 opencode
```

## Tools

| Tool | Role | What it does |
|---|---|---|
| `mp_host` | any → host | Bind port, mint invite code, return URL |
| `mp_join <code>` | any → guest | Dial host, auth, exchange hello |
| `mp_leave` | host or guest | Host: 10s grace + auto-transfer. Guest: close WS immediately. |
| `mp_cancel_leave` | host (during grace) | Abort a pending transfer |
| `mp_volunteer` | guest | Opt in as next-host candidate (preferred over longest-connected) |
| `mp_code` | any | Host: current invite code. Guest: host's handle. |
| `mp_status` | any | Role, port, code, peers list, host handle, leaving-state info |
| `mp_rejoin <code>` | any → guest | Rejoin with a grace code (valid 1 hour after the host change) |

`mp_history` (recent host transfers) is deferred to Phase 07 — the data is already persisted in `state.json`.

## Handle resolution (`MP_HANDLE`)

Resolution order: `MP_HANDLE` env var → `~/.hl-plugins/multiplayer/handle` → `$USER`.

Validation: lowercase, `[a-z0-9-]{1,16}`.

**Collision suffix**: when two peers join with the same handle, the host assigns the second peer a unique suffix (e.g. `alice-7k2`) and tells them via the `welcome` message.

```bash
MP_HANDLE=alice opencode   # your invite code will be mp-alice-...
```

## Slash command

OpenCode does not have a built-in `/mp` slash command yet. The user types intent in plain English and the LLM maps it to the right tool. Common phrasings:

| User says | Tool called |
|---|---|
| "host a multiplayer session" / "start a session" | `mp_host` |
| "join `mp-...`" / "connect to `mp-...`" | `mp_join(code=...)` |
| "leave" / "end session" / "I'm done" | `mp_leave` |
| "cancel the leave" / "actually stay" | `mp_cancel_leave` |
| "I'll be next host" / "volunteer" | `mp_volunteer` |
| "what's the invite code?" | `mp_code` |
| "what's the multiplayer status?" | `mp_status` |
| "rejoin `mp-...`" / "come back as guest" | `mp_rejoin(code=...)` |

## Host handoff flow

1. **Host** runs `mp_leave`. All peers see `host leaving in 10s`.
2. Any peer can run `mp_volunteer` to opt in as next host.
3. After 10s, the host picks the successor:
   - Priority 1: any volunteer (longest-connected wins ties)
   - Priority 2: longest-connected peer
4. The host sends `transfer_to_me` to the successor.
5. The successor stops being a guest, starts a new host server, mints a fresh code, and sends `transfer_confirmed` back.
6. The old host broadcasts `transfer_start` to all other peers and stops.
7. Other peers close their old WebSocket and dial the new host with the new code.
8. If the new host's port is blocked, the plugin auto-cascades to the next successor. If all fail, `session_ended` is broadcast and all peers return to idle.

The new host's code is in `mp_code` after the transfer. The old host's code stays valid for 1 hour — the old host can run `mp_rejoin <old-code>` to come back as a guest.

## Rejoin grace

When a host change happens, the old code is added to the new host's grace list for 1 hour. The new host accepts both the current code and any well-formed grace code in its list.

- `mp_rejoin` with a code < 1 hour old: accepted, guest joins
- `mp_rejoin` with a code > 1 hour old (or not in the grace list): rejected with an error toast

## State file

Persistent state lives at `~/.hl-plugins/multiplayer/state.json` (atomic write — `.tmp` + rename). Contains:

- `myHandle` — your chosen handle
- `lastHostUrl` — the last host you joined
- `graceCodes` — `[{ code, handle, validUntil }]` codes the new host accepts
- `history` — recent events (host_started, host_changed, session_ended, guest_joined, guest_left)

The chosen handle is also persisted to `~/.hl-plugins/multiplayer/handle`.

## Failure modes to surface

- `Port <N> is already in use` — restart with `MP_PORT=<other>`
- `No host responded at ws://<host>:<port>` — host not running, or `MP_HOST`/`MP_PORT` mismatch
- `Join failed: invalid_code` — malformed code
- `rejoin failed: grace expired` — the 1-hour window has passed
- `session ended: no_reachable_successor` — the cascade exhausted; session is over

## When NOT to use these tools

- For real-time co-editing of the same file — use VS Code Live Share
- For two machines on different networks — Cloudflare Tunnel lands in Phase 05
- For more than ~5 peers — the protocol works but toasts get noisy

## Notes for the LLM

- The plugin load is a no-op. No toasts, no port binding, no async work.
- `MP_PORT` must match between host and guest. `MP_HOST` must point to the host machine on the guest's side.
- The host's signaling server terminates when the host's opencode exits (or `mp_leave` after the transfer).
- Real WebRTC is deferred. The WebSocket is used as both signaling and data channel.
- Grace codes expire 1 hour after the host change that retired them. After that, they are pruned from `state.json` and rejected by the host.
