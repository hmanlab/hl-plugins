# Phase 06 — Heartbeat & crash detection

**Status:** Planned
**Depends on:** [Phase 05](./phase-05.md) shipped (cross-network support is needed to fully exercise the crash-detection path)
**Goal:** Distinguish a graceful leave (`/mp leave`, `SIGINT`, terminal close) from a crash (process killed, network drops, machine powers off). Auto-transfer the host role to a successor when a crash is detected.
**Outcome:** Bob's machine loses network (or `kill -9`s the host process). Within 15 seconds, Carol's plugin detects the missing heartbeat and runs the same auto-transfer flow as a graceful leave — picks a successor, mints a new code, reconnects all peers.

---

## Why this phase sixth

Phases 01–05 can tell the difference between "host process is alive" and "host process exited cleanly" via TCP / WebSocket close detection. They cannot tell the difference between:

- "Bob closed his terminal politely" → graceful transfer (Phase 02 already handles this)
- "Bob's WiFi dropped mid-session" → must detect and transfer
- "Bob's machine kernel panicked" → must detect and transfer
- "Bob's signaling process was `kill -9`d" → must detect and transfer

A lightweight heartbeat over the existing WebRTC DataChannel closes the gap. It's a small, additive change on top of Phase 05's infrastructure, so it lands late in the phase plan.

---

## Scope (in)

### Heartbeat (PRD F-9.1, F-9.2, F-9.3)

- **Host emits** a heartbeat message every 5 seconds over the DataChannel
- **Peers track** `lastHeartbeat` timestamp locally
- If `now - lastHeartbeat > 15 seconds`, the host is assumed dead
- Heartbeat message is a tiny fixed-size payload (e.g. `{ "type": "heartbeat", "t": <ms> }`); uses ≤ 1% of DataChannel bandwidth

### Crash detection (PRD F-8.2)

When `lastHeartbeat` exceeds 15s on any peer:

1. The peer stops waiting and treats the host as crashed
2. Plugin emits `[multiplayer] host unreachable, auto-transfer in 5...` toast
3. After 5s grace, the same successor-selection logic from Phase 02 runs:
   - Priority 1: any volunteer (`/mp volunteer` was added in Phase 02)
   - Priority 2: longest-connected peer
4. New host mints a fresh code, all peers reconnect

### Reconnect grace (PRD F-4.3, NFR-R.1)

- WebRTC auto-reconnects if either peer temporarily drops (≤ 30s)
- During the 30s window, peers show "reconnecting..." in the companion header; no transfer is triggered
- After a successful reconnect, the heartbeat clock resets and the session continues normally

### Permanent disconnect (PRD F-4.4)

- After 30s of no connection, the peer is marked as permanently disconnected
- Companion shows "peer unreachable" banner
- OpenCode TUI shows a toast
- If the disconnected peer was the host, transfer triggers as above

### Tunnel death (PRD NFR-R.3)

- If `cloudflared` restarts (e.g. user kills and restarts it), the plugin re-detects the new URL
- Peers automatically reconnect when the new URL is established
- This works because the host's signaling server keeps running on `localhost:7331` — only the public URL changes; once captured, peers re-dial

### `peer-lifecycle` extension

New internal events:

- `host_heartbeat_lost` — fired by a peer when no heartbeat for 15s
- `peer_reconnecting` — fired by a peer during the 30s grace
- `peer_unreachable` — fired after 30s without a connection
- `host_tunnel_changed` — fired by the host when cloudflared provides a new URL

---

## Out of scope (deferred)

| Item | Deferred to |
|---|---|
| TURN relay (for the ~15% of networks with symmetric NAT where WebRTC fails) | v2 |
| Hosted signaling (Cloudflare Worker) — eliminates tunnel failure modes | v2 |
| Adaptive heartbeat (interval depends on network quality) | v2+ |
| Battery-aware heartbeat (longer interval on low battery) | v2+ |

---

## Acceptance criteria

### Crash detection

- [ ] Bob's host process is `kill -9`ed → Carol sees `[multiplayer] host unreachable, auto-transfer in 5...` within 15-20s
- [ ] Carol (or another peer) is auto-promoted to host, mints a new code, all peers reconnect
- [ ] New code appears in Carol's companion header

### Reconnect grace

- [ ] Brief network blip (≤ 10s) → peer shows "reconnecting..." then resumes normally
- [ ] No transfer is triggered for blips under 30s
- [ ] Heartbeat clock resets after successful reconnect

### Permanent disconnect

- [ ] Network blip > 30s → peer shows "peer unreachable" in companion + toast in OpenCode
- [ ] If the disconnected peer was the host, transfer triggers

### Tunnel death

- [ ] Bob restarts `cloudflared` → host re-detects new URL within 10s
- [ ] All peers automatically reconnect
- [ ] No code change (the session is the same; only the public URL changed)

### Heartbeat overhead

- [ ] Heartbeat messages use ≤ 1% of DataChannel bandwidth (verify via Wireshark or similar)

---

## Test plan

### Crash detection (process killed)

```bash
# Both connected.
# On Bob's machine:
pgrep -f "hl-plugins/multiplayer" | xargs kill -9

# expect in Carol's companion within 15-20s:
#   [multiplayer] host unreachable, auto-transfer in 5...
#   ... (5s) ...
#   [multiplayer] you are now host. invite: mp-carol-XXXX
```

### Crash detection (network drop)

```bash
# Both connected.
# On Bob's machine, simulate network loss on the loopback or WiFi interface:
sudo ifconfig en0 down  # macOS example

# expect in Carol's companion within 15-20s:
#   [multiplayer] host unreachable, auto-transfer in 5...
#   ... (transfer happens) ...
# bring en0 back up:
sudo ifconfig en0 up
```

### Brief blip (reconnect, no transfer)

```bash
# Both connected.
# On Bob's machine:
sudo ifconfig en0 down
sleep 5
sudo ifconfig en0 up

# expect in Carol's companion:
#   "reconnecting..." for 5s
#   then resume normally
#   NO transfer triggered
```

### Permanent disconnect

```bash
# Both connected.
# On Bob's machine:
sudo ifconfig en0 down
# wait 30s+

# expect in Carol's companion:
#   "peer unreachable" banner
#   toast: [multiplayer] peer unreachable
#   if Bob was host: transfer triggers after 5s grace
```

### Tunnel restart

```bash
# Cross-network session active.
# On Bob's machine, kill cloudflared and restart it:
pkill cloudflared
cloudflared tunnel --url http://localhost:7331
# expect: host re-detects new URL within 10s
# expect: peers reconnect
# expect: code does NOT change (it's the same session)
```

---

## Files

```
packages/plugin-multiplayer/
├── opencode/
│   └── plugin/
│       ├── peer-lifecycle.ts             # adds heartbeat tracking, crash detection
│       └── ...
└── companion/
    └── src/
        └── ui/
            └── Header.tsx                # adds "reconnecting...", "peer unreachable" states
```

---

## Components (this phase)

| Component | Change from Phase 05 |
|---|---|
| `peer-lifecycle` | Adds heartbeat tracking, `host_heartbeat_lost`, `peer_reconnecting`, `peer_unreachable` events, crash-detection timer |
| `signaling` | Adds 5s heartbeat emission (host) and tracking (guests) on the DataChannel |
| `webrtc-host` / `webrtc-guest` | Pass-through for heartbeat messages (no protocol change needed) |
| `tunnel-detector` | Adds re-detection on tunnel change |
| `companion` UI | Header gains "reconnecting..." and "peer unreachable" states |
| `tui-bridge` | Adds toasts for `host_heartbeat_lost`, `peer_unreachable`, `tunnel_changed` |
| `intent-broadcast` | Unchanged |
| `companion-spawner` | Unchanged |

---

## References (PRD sections relevant to this phase)

- PRD §3 Goals — "Host handoff is automatic — no orphaned sessions"
- PRD §5 Story 4 — Bob's machine crashes
- PRD §6.8 — Auto-transfer (F-8.2 — host crashes)
- PRD §6.9 — Heartbeat (F-9.1 through F-9.3)
- PRD §6.4 — WebRTC P2P (F-4.3 — reconnect grace, F-4.4 — permanent disconnect)
- PRD §7 NFRs — NFR-R.1 (network blips), NFR-R.2 (Bob's machine crash), NFR-R.3 (tunnel death)
- PRD §9 Flow B — Bob leaves, Carol takes over (uses the same auto-transfer path)
- PRD §14 Open risks — Auto-transfer race conditions
