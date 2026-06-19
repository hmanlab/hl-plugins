---
name: multiplayer
description: Use when the user wants to start, join, or end a multiplayer session so two developers can collaborate in the same OpenCode session. Phase 01: connect and disconnect only — no chat, no companion, no tunnel. Front-load keywords: multiplayer, peer, pair, connect, join, session, host, guest, invite, code, mp-, share, collaborate, mp_host, mp_join, mp_leave, mp_status.
---

# multiplayer — multi-user sessions for OpenCode

The `multiplayer-tools` plugin lets two `opencode` instances recognize each other and stay connected while their agents work. **Phase 01** proves the connection loop end-to-end: host, guest, connect, disconnect. Chat, intents, the companion pane, host handoff, and the Cloudflare Tunnel land in later phases.

## Roles — explicit, never auto

The plugin does **no** work at load time. Installing the plugin is safe: it adds four tools and sits idle. The user must explicitly call a tool to enter a role.

| Role | Entered via | Bound resources |
|---|---|---|
| `idle` | (default after install) | none |
| `host` | `mp_host` | binds local port (see below), mints invite code |
| `guest` | `mp_join <code>` | opens outbound WebSocket to host |

Only one role is active at a time. Calling `mp_host` while idle transitions to host; calling `mp_join` while idle transitions to guest. Calling `mp_leave` returns to idle. Calling `mp_host` or `mp_join` while in the wrong role returns an error.

## Port: 7332 (one digit off from Kilo Code's 7331)

Default port is **`MP_PORT=7332`**. We deliberately avoid 7331 because the [Kilo Code](https://marketplace.visualstudio.com/items?itemName=kilocode.kilo-code) VS Code extension also binds 7331 — auto-binding 7331 at opencode startup would crash opencode on machines with Kilo Code installed.

Override the port for one session with `MP_PORT`:

```bash
MP_PORT=8332 opencode   # both peers must use the same MP_PORT
```

## Tools

| Tool | What it does |
|---|---|
| `mp_host` | Bind the local port (default 7332), mint an invite code, return the URL and code. Returns a clear error if the port is busy. |
| `mp_join` | Dial `ws://localhost:<MP_PORT>`, authenticate with the host's invite code, exchange `hello`. Returns success or a reason on failure. |
| `mp_leave` | End the session. On host, stops the signaling server. On guest, closes the WebSocket. |
| `mp_status` | Show the current role, port, invite code (host only), peer handle. |

## Slash command

OpenCode does not have a built-in `/mp` slash command in Phase 01. The user types intent in plain English and the LLM maps it to the right tool. Common phrasings:

| User says | Tool called |
|---|---|
| "host a multiplayer session" / "start a session" / "be the host" | `mp_host` |
| "join `mp-...`" / "connect to `mp-...`" / "join bob's session" | `mp_join(code=...)` |
| "leave" / "disconnect" / "end session" | `mp_leave` |
| "what's the multiplayer status?" / "am I hosting?" | `mp_status` |

A real `/mp` slash-command file lands in Phase 02.

## Flow

1. **Host** runs `opencode`. The plugin is idle — no toasts, no port binding.
2. The host types "host a session". The LLM calls `mp_host`. The plugin binds the port, mints a code, and toasts `invite: mp-bob-a3f9-x7k2` and `hosting on ws://localhost:7332`. The host copies the code.
3. **Guest** runs `opencode` (in another terminal, on the same machine, with the same `MP_PORT`). The plugin is idle.
4. The guest types "join mp-bob-a3f9-x7k2". The LLM calls `mp_join(code="mp-bob-a3f9-x7k2")`. Both sides toast `✓ connected to <handle>`.
5. **Host** exits (`exit`, Ctrl-C, close terminal). **Guest** toasts `peer disconnected` within ~1 second. Both return to idle.

## Common patterns

- **Start a session and share the code** — type "host a multiplayer session" in the host's opencode. Copy the code from the toast.
- **Join a peer's session** — paste the peer's code in chat, e.g. `join mp-bob-a3f9-x7k2`. The LLM calls `mp_join` with that code.
- **End the session** — type "leave" or "end session". The LLM calls `mp_leave`.
- **Check current state** — type "what's the multiplayer status?" or "am I hosting?". The LLM calls `mp_status`.
- **Resolve a port conflict** — if `mp_host` returns "Port 7332 is already in use", restart opencode with `MP_PORT=8332` (or any free port) and tell the peer to do the same.

## Failure modes to surface

- `Port <N> is already in use` — another process is on the default port. Suggest the user retry with `MP_PORT=<other>`.
- `No host responded at ws://localhost:<port>` — guest's `mp_join` timed out after 5 seconds. The host may not be running, or the two opencode instances have different `MP_PORT` values.
- `Join failed: invalid_code` — the code is malformed. Ask the user to double-check.
- `Could not start host: not_idle (currently host|guest)` — the user tried `mp_host` while already in a session. Use `mp_leave` first.

## When NOT to use these tools

- For real-time co-editing of the same file — that's VS Code Live Share, out of scope.
- For two machines on different networks — Cloudflare Tunnel lands in Phase 05. For now, both peers must be on the same machine.
- For three or more peers — multi-guest lands in Phase 02. Phase 01 supports one host + one guest only.

## Notes for the LLM

- The handle defaults to the OS username (`$USER`). Both peers on the same machine will share a handle — that's fine for Phase 01.
- Invite codes are case-insensitive on input but always printed lowercase.
- The host's signaling server terminates when the host's opencode exits (the plugin's `dispose()` hook stops it).
- Real WebRTC (with SDP/ICE) is deferred. The WebSocket is used as both signaling and data channel in Phase 01 — the protocol is the same, only the transport changes later.
- `MP_PORT` must match between host and guest. There's no negotiation.