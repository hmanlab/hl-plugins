# Phase 05 — Cloudflare Tunnel (cross-network)

**Status:** Planned
**Depends on:** [Phase 02](./phase-02.md) shipped (session model + signaling). Companion and intents are not required.
**Goal:** Bob and Carol can collaborate across different networks (different WiFi, different cities) using a Cloudflare quick tunnel. Plugin auto-detects the tunnel, waits up to 2 minutes for it to come up, and captures the public URL.
**Outcome:** Bob starts `opencode` without `cloudflared` running. The plugin waits and shows "Waiting for Cloudflare Tunnel (attempt 1/12)...". Bob starts `cloudflared tunnel --url http://localhost:7331` in another terminal. Within 10s, the plugin picks up the public URL and the host mints a new code. Carol on a different network runs `/mp join https://<url>.trycloudflare.com` and connects.

---

## Why this phase fifth

Phases 01–04 all assume Bob and Carol are on the same machine or the same LAN. The PRD's D-4 decision is to use Cloudflare Tunnel for cross-network because it's free, has unlimited bandwidth, and supports persistent URLs. Phase 05 layers that on top of the existing session model — no changes to the WebRTC layer, just a new "how the guest finds the host" path.

The tunnel is the highest-risk dependency in the whole project (third-party network tool, free tier, may break on some networks), so it lands late in the phase plan to keep the early phases small and shippable.

---

## Scope (in)

### Tunnel detection (PRD F-1.1)

Plugin auto-detects a running Cloudflare Tunnel by checking, in order:

1. **Common ports** — `7331`, `8080`, `3000` for a `cloudflared`-managed endpoint
2. **Config files** — `~/.cloudflared/` for a `config.yml` or `cert.pem`
3. **Process output** — if `cloudflared` is running in the same shell, parse its stdout/stderr for the `https://<random>.trycloudflare.com` URL

### Retry policy (PRD F-1.2)

- If no tunnel detected, plugin retries every 10s
- Total budget: 2 minutes (12 attempts)
- On each retry, the plugin emits a toast: `[multiplayer] Waiting for Cloudflare Tunnel (attempt N/12)...`

### Timeout (PRD F-1.3)

- After 2 minutes without a tunnel, plugin shows an error toast with a link to `docs/development/multiplayer/cloudflare-setup.md`
- Plugin does not crash; the user can still proceed with a LAN-only session

### URL capture (PRD F-1.4)

- Once detected, the plugin extracts `https://<random>.trycloudflare.com` from cloudflared output
- The host's printed code is augmented with the URL: `[multiplayer] invite: mp-bob-a3f9-x7k2 (https://abc-xyz.trycloudflare.com)`

### Invite URL form

- `/mp join <code>` — works as before (LAN)
- `/mp join https://<url>.trycloudflare.com` — guest connects to the host's tunnel, the signaling server on the host's side authenticates the code
- The URL form is the only cross-network entry point in this phase

### Pre-flight check (PRD NFR-I.2)

- During `hl-plugins install multiplayer`, detect `cloudflared` (`which cloudflared`)
- If missing, warn (do not fail): `[multiplayer] cloudflared not found — needed for cross-network sessions. See docs/development/multiplayer/cloudflare-setup.md`
- Install still succeeds; the plugin works in LAN-only mode without it

### Privacy (PRD NFR-P.3)

- The tunnel URL is not logged to disk, not included in toast history, and not transmitted through any channel other than the user's clipboard / typed command
- All chat/intent/presence data still flows over the WebRTC DataChannel; only signaling metadata (SDP, ICE) goes through the tunnel

### Cloudflare-setup doc

New doc: `docs/development/multiplayer/cloudflare-setup.md` with:
- One-line install (`brew install cloudflared` / `apt install cloudflared` / etc.)
- The `cloudflared tunnel --url http://localhost:7331` command
- When to use it, when not to
- Privacy notes (the URL is public — anyone with it can attempt to connect, but they still need the invite code)

---

## Out of scope (deferred)

| Item | Deferred to |
|---|---|
| Heartbeat / crash detection (still relying on TCP/WebSocket close detection) | Phase 06 |
| Hosted signaling (Cloudflare Worker) — no tunnel needed | v2 |
| TURN relay (for symmetric NAT — ~15% of networks) | v2 |
| ngrok / Tailscale alternative tunnels | v2+ |
| Persistent tunnel (named Cloudflare Tunnel instead of quick tunnel) | v2+ |

---

## Acceptance criteria

- [ ] `which cloudflared` returns nothing on a fresh machine → install warns but does not fail
- [ ] Bob starts `opencode` without `cloudflared` running → toast `[multiplayer] Waiting for Cloudflare Tunnel (attempt 1/12)...`
- [ ] Each retry increments the attempt counter in the toast
- [ ] Bob runs `cloudflared tunnel --url http://localhost:7331` in another terminal → plugin detects within 10s and captures the URL
- [ ] Host's printed code is augmented with the URL: `mp-bob-a3f9-x7k2 (https://abc-xyz.trycloudflare.com)`
- [ ] Carol on a different network runs `/mp join https://abc-xyz.trycloudflare.com` → connects within 10s
- [ ] If tunnel doesn't come up in 2 minutes → error toast with link to `cloudflare-setup.md`
- [ ] Plugin does not crash on tunnel timeout
- [ ] The tunnel URL is not written to any log file or state file
- [ ] LAN-only mode (no cloudflared) still works for two peers on the same WiFi

---

## Test plan

### Cross-network (two different WiFi networks)

```bash
# --- Bob's machine (Network A) ---
# Terminal 1
opencode
# expect: [multiplayer] Waiting for Cloudflare Tunnel (attempt 1/12)...

# --- Bob's machine (Network A) ---
# Terminal 2
cloudflared tunnel --url http://localhost:7331
# expect in Terminal 1 (within 10s):
#   [multiplayer] tunnel detected: https://abc-xyz.trycloudflare.com
#   [multiplayer] invite: mp-bob-a3f9-x7k2 (https://abc-xyz.trycloudflare.com)

# --- Carol's machine (Network B) ---
opencode
> /mp join https://abc-xyz.trycloudflare.com
# expect: [multiplayer] ✓ connected to bob
```

### Timeout

```bash
# Bob's machine:
opencode
# Do NOT start cloudflared.
# expect: attempts 1/12 → 2/12 → ... → 12/12 (over 2 minutes)
# expect: [multiplayer] cloudflared not detected after 2 minutes
#         [multiplayer] see https://.../cloudflare-setup.md
# expect: plugin still alive, /mp join <lan-code> still works for LAN peers
```

### Pre-flight

```bash
# On a machine with no cloudflared:
hl-plugins install multiplayer
# expect: [multiplayer] cloudflared not found — see cloudflare-setup.md
#         install completes successfully
```

### Privacy check

```bash
# After a session with a tunnel:
grep -r "trycloudflare" ~/.hl-plugins/multiplayer/   # expect: no matches
grep -r "trycloudflare" ~/.opencode/                  # expect: no matches (toast history not persisted)
```

---

## Files

```
packages/plugin-multiplayer/
├── package.json                          # adds cloudflared to pre-flight check
├── opencode/
│   ├── plugin/
│   │   ├── multiplayer-tools.ts          # adds tunnel-detector lifecycle
│   │   └── tunnel-detector.ts            # new — port checks, config parsing, process output capture
│   └── skill/
│       └── multiplayer/
│           └── SKILL.md                  # /mp join now accepts URLs
└── ...

# New: standalone doc
docs/development/multiplayer/cloudflare-setup.md
```

---

## Components (this phase)

| Component | Change from Phase 04 |
|---|---|
| `tunnel-detector` | New — full implementation: port check, config parse, cloudflared output capture, 10s retry, 2min timeout |
| `install` (CLI flow) | Adds `cloudflared` pre-flight check (warn, don't fail) |
| `invite-parser` | Adds URL form: `https://<subdomain>.trycloudflare.com` |
| `signaling` | Unchanged (still binds to `localhost:7331`); the tunnel is just external routing to it |
| `webrtc-host` / `webrtc-guest` | Unchanged |
| `peer-lifecycle` | Unchanged |
| `intent-broadcast` | Unchanged |
| `companion` | Unchanged |
| `companion-spawner` | Unchanged |

---

## References (PRD sections relevant to this phase)

- PRD §5 Story 6 — Bob uses Cloudflare Tunnel, but it isn't running yet
- PRD §6.1 — Tunnel integration (F-1.1 through F-1.4)
- PRD §6.2 — Invite codes (URL form)
- PRD §7 NFRs — NFR-I.2 (pre-flight check), NFR-P.2 (only signaling metadata through tunnel), NFR-P.3 (URL not logged)
- PRD §9 Flow C — Tunnel not running
- PRD §10 D-4, D-5 — Tunnel tool and discovery decisions
- PRD §14 Open risks — Cloudflare Tunnel free tier changes, WebRTC fails on symmetric NAT
- PRD §12 Out of scope — Hosted signaling (v2)
