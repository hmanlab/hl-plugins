# Phase 02 — Sessions & host handoff

**Status:** Shipped (v0.2.0)
**Depends on:** [Phase 01](./phase-01.md) ✅ Shipped
**Goal:** A proper session model. The host can leave without ending the session — the longest-connected peer (or a volunteer) is auto-promoted to host and mints a fresh invite code. Old codes remain valid for 1 hour so the previous host can rejoin as a guest.
**Outcome:** Bob hosts. Carol and Dave join. Bob runs `mp_leave`. All peers see a 10-second grace countdown, then Carol (longest-connected) becomes host with a brand-new code. Bob can later run `opencode` again and `mp_rejoin <his-old-code>` to come back as guest within 1 hour.

---

## Why this phase second

Phase 01 proves the connection works but treats the host's session as immortal — when the host exits, the session dies. In real use, Bob will close his laptop, kill his terminal, or hand off to a teammate — and the session shouldn't die with him. Phase 02 introduces:

- A **session** as a first-class concept (not just a running signaling server)
- **Host handoff** so the session lives as long as at least one peer is connected
- **Rejoin grace** so the previous host can come back without ceremony
- **Multi-peer** support: Phase 01 was 1 host + 1 guest; Phase 02 is 1 host + N guests

Phase 02 inherits Phase 01's explicit-tools design (no auto-elect, port 7332, `MP_PORT` / `MP_HANDLE` env overrides, idle on load).

---

## Scope (in)

### Handle resolution (`MP_HANDLE`)

- Resolution order: `MP_HANDLE` env var → `~/.hl-plugins/multiplayer/handle` (persisted) → `$USER` / `$USERNAME`
- Validation: lowercase, `[a-z0-9-]{1,16}`
- **Collision suffix**: when joining a session where another peer already has your handle, the host assigns you a unique suffix (e.g. `alice-7k2`) and tells you via the `welcome` message. You persist it for the session.
- When **you** host, your handle is what you chose; no collision check.

### Invite codes (PRD F-2.1 → F-2.5)

- Format: `mp-<handle>-<random4>-<random4>` (lowercase alphanumeric)
- Case-insensitive on input
- **Fresh code on every host change** (F-2.4) — the new host mints a new code, all peers are told via `transfer_start`
- **1-hour rejoin grace** for old codes (F-2.5) — when a transfer happens, the old host's code is added to the new host's grace list. The new host accepts it for 1 hour.
- Stored in `~/.hl-plugins/multiplayer/state.json` with timestamp + expiry

### Tools (Phase 01 had 4, Phase 02 adds 4 more)

| Tool | Role | What it does |
|---|---|---|
| `mp_host` | any → host | (Phase 01) Bind `MP_PORT`, mint code, print it |
| `mp_join <code>` | any → guest | (Phase 01) Dial host, auth, exchange hello |
| `mp_leave` | host only | Emit `host_leaving` with 10s grace, collect volunteers, pick successor, transfer. New code minted. |
| `mp_cancel_leave` | host only (during grace) | Cancel a pending leave; emit `leave_cancelled` to all peers |
| `mp_volunteer` | guest | Mark this peer as the next-host candidate |
| `mp_code` | host | Show current invite code |
| `mp_status` | any | Show role, port, code (host), peers list, host handle, leaving-state info |
| `mp_rejoin <code>` | any → guest | Rejoin using a grace code (valid for 1 hour after the host change that retired it) |
| `mp_history` | any | Show recent host transfers in this session (Phase 07 polish, but listed here for completeness) |

(`mp_history` is the only one deferred to Phase 07 — the others all land in Phase 02.)

### Auto-transfer (PRD F-8.1, F-8.3)

When the host leaves gracefully:

1. Host emits `host_leaving { grace_s: 10 }` to all peers
2. All peers toast `[multiplayer] host leaving in 10s` and update `mp_status`
3. Any peer can `mp_volunteer` → added to the volunteers list
4. After 10s, host picks successor:
   - Priority 1: any volunteer (longest-connected wins ties)
   - Priority 2: longest-connected peer
5. Host tells the successor `transfer_to_me { new_code, new_url }`
6. Successor's plugin: stop being guest → start signaling → become host → mint code
7. Host broadcasts `transfer_start { new_code, new_url, new_handle }` to all other peers
8. All peers close their old WS, dial the new host with the new code
9. If the new host's port is blocked (firewall), peers fail to connect within 5s and the plugin auto-cascades to the next successor
10. If all successors fail, broadcast `session_ended { reason: "no_reachable_successor" }` and all peers return to idle

### Multi-peer support

- One host + N guests (no hard cap; in practice 2–5)
- All commands work with N > 1
- `mp_status` on the host shows all peers; on a guest, shows host + peer count
- Transfer logic picks from all volunteers / all connected peers

### Connection lifecycle

- Host's signaling server tears down cleanly on host exit (`mp_leave`, Ctrl-C, OpenCode exit)
- All open WebSocket connections close cleanly
- Re-joinable signaling state persists in `~/.hl-plugins/multiplayer/state.json` (atomic write — write to `.tmp`, rename)
- Recent transfer history kept in the same file for `mp_history`

---

## Out of scope (deferred)

| Item | Deferred to |
|---|---|
| Companion pane | Phase 03 |
| Chat, intent feed | Phase 03–04 |
| Heartbeat / crash detection (no `host_leaving` signal) | Phase 06 |
| Cloudflare Tunnel (LAN-only this phase) | Phase 05 |
| `mp_history` | Phase 07 (called out but not implemented; the data is persisted in state.json) |
| Real `/mp` slash command file in `~/.config/opencode/commands/` | later phase |

---

## Acceptance criteria

### LAN test (two machines)

- [ ] Bob hosts from machine A with `MP_PORT=7332`; the printed code works when Carol on machine B runs `mp_join` with the same `MP_PORT`
- [ ] `MP_HANDLE=alice opencode` on Bob's side: the code is `mp-alice-...`
- [ ] Two peers both choosing `alice` get distinct codes (one is `mp-alice`, the other is `mp-alice-XXXX` suffix)

### Host handoff

- [ ] Bob runs `mp_leave` → all peers see `[multiplayer] host leaving in 10s` toast
- [ ] Carol can run `mp_volunteer` during the grace; if she does and is the longest-connected, she wins
- [ ] If no one volunteers, longest-connected peer is auto-selected
- [ ] Carol sees the new code in her prompt within 11s of grace
- [ ] Carol can run `mp_code` to see her current code
- [ ] Bob can run `mp_rejoin <his-old-code>` within 1 hour → rejoins as guest
- [ ] `mp_rejoin` with a code > 1 hour old shows a clear error toast
- [ ] If two peers `mp_volunteer` simultaneously, the longest-connected wins (verifiable via `mp_status` before and after)
- [ ] `mp_cancel_leave` within the grace window aborts the transfer; all peers get `leave_cancelled`

### Cascade

- [ ] If the new host's port is blocked when they take over, peers fail to connect within 5s and the plugin auto-cascades to the next successor
- [ ] If all successors fail, the session ends with `[multiplayer] session ended: no reachable successor` toast on all peers

### Cleanup

- [ ] No orphan signaling processes after host exit (`lsof -nP -iTCP:$MP_PORT` is clean)
- [ ] All WebSocket connections close cleanly (no zombie state)
- [ ] `state.json` is updated atomically on host change (write to `.tmp`, rename) — no partial writes on crash
- [ ] `state.json` lives at `~/.hl-plugins/multiplayer/state.json`

### Multi-peer

- [ ] 3+ peers can join the same host; `mp_status` on the host lists all of them
- [ ] When the host leaves, the transfer logic considers all peers (volunteers first, then by `joined_at`)

---

## Test plan

### LAN test (two machines on the same WiFi)

```bash
# --- Machine A (Bob, host) ---
MP_HANDLE=bob MP_PORT=7332 opencode
# idle on load (no toasts)
# type "host a session" → mp_host
# expect: [multiplayer] invite: mp-bob-a3f9-x7k2

# --- Machine B (Carol, guest) ---
MP_HANDLE=carol MP_PORT=7332 opencode
# idle on load
# type "join mp-bob-a3f9-x7k2" → mp_join
# expect in both: [multiplayer] ✓ connected
# expect in both: mp_status shows host=bob, peer count = 1

# --- Machine A (Bob) ---
# type "leave" → mp_leave
# Machine B sees:
#   [multiplayer] host leaving in 10s
#   ... (10s) ...
#   [multiplayer] you are now host. invite: mp-carol-b8e1-m4n9

# --- Machine A (Bob, fresh) ---
MP_PORT=7332 opencode
# type "rejoin mp-bob-a3f9-x7k2" → mp_rejoin
# expect: [multiplayer] ✓ rejoined as guest (grace valid)

# --- Machine A, 1 hour later ---
# type "rejoin mp-bob-OLD-CODE"
# expect: [multiplayer] rejoin failed: grace expired
```

### Volunteer race

```bash
# 3 peers connected to Bob. Bob mp_leave.
# Within the 10s grace, both Carol and Dave run mp_volunteer.
# After 10s, the longest-connected wins (verifiable via mp_status).
```

### Cascade (port blocked)

```bash
# Carol is the only other peer. Bob mp_leave.
# Simulate Carol's port 7332 being blocked (e.g. firewall rule, or simply
# don't run `mp_leave` on Carol yet).
# expect: cascade attempt, then "session ended" since no further successors.
```

### Multi-peer

```bash
# Host mints code mp-bob-... and prints it.
# Three guests (Carol, Dave, Eve) all join.
# Bob's mp_status shows:
#   host: bob
#   peers: carol (12s), dave (8s), eve (3s)
# Bob mp_leave → within 10s, carol (longest-connected) becomes host.
```

---

## Files

```
packages/plugin-multiplayer/
├── package.json
├── tsconfig.json
└── opencode/
    ├── plugin/
    │   └── multiplayer-tools.ts          # adds 4 tools + state store + protocol
    └── skill/
        └── multiplayer/
            └── SKILL.md                  # adds new tools, MP_HANDLE

# New: persistent state directory (per-user)
~/.hl-plugins/multiplayer/
├── state.json                            # atomic write; contains:
│                                         #   - myHandle (string)
│                                         #   - lastHostUrl (string?)
│                                         #   - graceCodes: [{ code, handle, validUntil }]
│                                         #   - history: [{ ts, event, handle }]
└── handle                                # chosen handle (text file, 1 line)
```

---

## Components (this phase)

| Component | Change from Phase 01 |
|---|---|
| `signaling` | Multi-peer: Map of connected peers by handle; broadcasts `peers_update` on join/leave |
| `webrtc-host` / `webrtc-guest` | Unchanged (still WebSocket-as-data-channel) |
| `peer-lifecycle` | Adds `host_leaving`, `leave_cancelled`, `volunteer`, `transfer_start`, `transfer_to_me`, `session_ended` events |
| `tui-bridge` | Adds toasts for `host leaving in Ns`, `transfer complete`, `new code`, `rejoin failed`, `session ended`, `volunteer accepted` |
| `invite-parser` | Adds collision-suffix handling on the host side |
| `handle` (new) | `MP_HANDLE` / `~/.hl-plugins/multiplayer/handle` / `$USER` resolution with collision suffix |
| `session-store` (new) | Atomic `state.json` read/write for grace codes, last host URL, and history |
| `tunnel-detector` | ❌ (Phase 05) |
| `intent-broadcast` | ❌ (Phase 04) |
| `companion-spawner` / `companion` | ❌ (Phase 03) |

---

## References (PRD sections relevant to this phase)

- PRD §3 Goals — "Host handoff is automatic — no orphaned sessions"
- PRD §5 Stories 1, 2, 3 — Bob starts, Carol joins, Bob leaves / Carol takes over
- PRD §6.2 — Invite codes (F-2.1 through F-2.5)
- PRD §6.7 — Commands (full set this phase, except `mp_history` deferred to Phase 07)
- PRD §6.8 — Auto-transfer (F-8.1, F-8.3 — graceful leave + cascade)
- PRD §9 Flow B — Bob leaves, Carol takes over
- PRD §14 Open risks — Auto-transfer race conditions, Bob's machine firewall blocks incoming