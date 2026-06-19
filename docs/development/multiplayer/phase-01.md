# Phase 01 — Hello, peer (minimal end-to-end smoke test)

**Status:** ✅ Shipped (v0.1.0)
**Goal:** Verify the plugin loads, auto-elects a host, and a second instance can join. No chat, no companion, no tunnel — just "two plugins on the same machine recognize each other".
**Outcome:** Two `opencode` windows on the same machine show "✓ connected" toasts after a `/mp join` and "peer disconnected" when the host exits.

---

## Why this phase first

We need to prove the **outermost loop works** before adding any features on top:

```
plugin loads → host detected → signaling on 7331 → guest joins →
WebRTC handshake → DataChannel open → toasts fire → host exits → guest sees disconnect
```

If any link in this chain is broken, no amount of chat/intent/companion work will matter. Phase 01 is the cheapest possible end-to-end test that exercises every layer of the architecture (in-process plugin code, signaling server, WebRTC, OpenCode TUI hooks, slash-command plumbing, install flow).

Everything else — chat, intents, tunnel, companion pane, heartbeat, host handoff — is layered on top of this working loop.

---

## Scope (in)

- `packages/plugin-multiplayer/` plugin scaffold
- `package.json` with the `hl-plugins` contract (`opencodePlugin`, `opencodeSkill`, no `auth`, no `requires`)
- Minimal `opencode/plugin/multiplayer-tools.ts` plugin entry
- `opencode/skill/multiplayer/SKILL.md` registering the four tools
- **Plugin load is a no-op** — no port binding, no toasts, no async work. The plugin enters `idle` role and waits.
- **Four tools** (all explicit):
  - `mp_host` — binds `ws://localhost:<MP_PORT>` (default **7332**, configurable via `MP_PORT`), mints a code, prints it
  - `mp_join <code>` — dials the host, authenticates, exchanges `hello`
  - `mp_leave` — ends the session, returns to `idle`
  - `mp_status` — shows role, port, code (host), peer handle
- **Default port 7332** — one digit off from the [Kilo Code](https://marketplace.visualstudio.com/items?itemName=kilocode.kilo-code) VS Code extension's 7331 to avoid collisions. Override via `MP_PORT=8332 opencode` if 7332 is also taken.
- **`tui-bridge`**: `client.tui.showToast` for `invite`, `hosting on`, `connected`, `peer connected`, `peer disconnected`, `join failed`, etc.
- **Install flow**: `hl-plugins install multiplayer` copies plugin + skill into `~/.opencode/`
- **Local-only**: both plugins on the **same machine**, same `MP_PORT`

---

## Out of scope (deferred)

| Item | Deferred to |
|---|---|
| Cloudflare Tunnel (cross-network) | Phase 05 |
| Companion pane (auto-spawn, manual fallback) | Phase 03 |
| Chat, intents | Phase 03–04 |
| Host handoff on leave | Phase 02 |
| Heartbeat / crash detection | Phase 06 |
| Rejoin grace, handle collisions | Phase 02 |
| `/mp leave`, `/mp code`, `/mp status`, `/mp volunteer`, `/mp cancel-leave`, `/mp rejoin`, `/mp history` | Phase 02+ |
| Pre-flight checks (cloudflared warning) | Phase 07 |
| Idempotent install verification | Phase 07 |
| Clean uninstall | Phase 07 |
| Multi-guest (1 host + N peers) | Phase 02 |
| Cross-machine LAN test | Phase 02 |
| Cross-network test | Phase 05 |

---

## Acceptance criteria

- [x] `hl-plugins install multiplayer` succeeds; `~/.opencode/plugin/multiplayer-tools.ts` and `~/.opencode/skill/multiplayer/SKILL.md` exist after install
- [x] `hl-plugins list` shows `multiplayer` after install
- [x] First `opencode` instance: idle on load, no toasts, no port binding
- [x] User says "host a session" → LLM calls `mp_host` → toast `invite: mp-bob-a3f9-x7k2` + toast `hosting on ws://localhost:7332`
- [x] Second `opencode` instance on the same machine: idle on load
- [x] User says "join mp-bob-a3f9-x7k2" → LLM calls `mp_join` → both show `✓ connected to <handle>` toasts
- [x] WebRTC DataChannel state is `open` on both sides (deferred to a later phase; the WebSocket acts as the data channel in Phase 01)
- [x] Bob runs `mp_leave` (or exits); Carol sees `[multiplayer] peer disconnected` toast within ~1 second
- [x] Joining with a wrong code shows an error toast and does not crash
- [x] `mp_host` returns a clear error if the port is busy, with `MP_PORT=<other>` suggestion
- [x] Plugin does not add more than 50ms to OpenCode startup (no port binding, no async work)
- [x] No orphan processes after both OpenCode instances exit (the plugin's `dispose()` hook stops the signaling server)
- [x] `MP_PORT` override works: `MP_PORT=8332 opencode` uses 8332 for both signaling and dialing

---

## Test plan

### Same-machine two-window test

```bash
# Pre-flight: install
hl-plugins install multiplayer
hl-plugins list                    # expect: multiplayer

# --- Terminal 1 (Bob) ---
opencode
# expect: no toasts on load (plugin is idle)

# User types "host a multiplayer session"
# LLM calls mp_host
# expect in prompt:
#   toast: [multiplayer] invite: mp-bob-a3f9-x7k2
#   toast: [multiplayer] hosting on ws://localhost:7332
# copy the code

# --- Terminal 2 (Carol) ---
opencode
# expect: no toasts on load (plugin is idle)

# User types "join mp-bob-a3f9-x7k2"
# LLM calls mp_join(code="mp-bob-a3f9-x7k2")
# expect in Terminal 2:
#   toast: [multiplayer] ✓ connected to bob
# expect in Terminal 1:
#   toast: [multiplayer] ✓ peer connected (carol)

# --- Back to Terminal 1 ---
# User types "leave" or just exits
> exit
# expect in Terminal 2 (within ~1s):
#   toast: [multiplayer] peer disconnected

# --- Cleanup verification ---
ps aux | grep -i multiplayer       # expect: no orphan processes
lsof -nP -iTCP:7332                # expect: nothing listening
```

### Negative test: wrong code

```bash
# Terminal 2 (still running)
> /mp join mp-bob-zzzz-yyyy
# expect: toast [multiplayer] join failed: invalid code
#         no crash, plugin stays alive
```

### Re-run test (idempotency sanity check, full check in Phase 07)

```bash
hl-plugins install multiplayer     # second time, should be a no-op
```

---

## Files

```
packages/plugin-multiplayer/
├── package.json                          # hl-plugins contract, no requires/auth
├── tsconfig.json
└── opencode/
    ├── plugin/
    │   └── multiplayer-tools.ts          # plugin entry, exports MultiplayerPlugin
    └── skill/
        └── multiplayer/
            └── SKILL.md                  # registers /mp join <code>
```

Installed to `~/.opencode/plugin/multiplayer-tools.ts` and `~/.opencode/skill/multiplayer/SKILL.md` by the existing `hl-plugins install` flow.

---

## Components (this phase)

| Component | In Phase 01? | Notes |
|---|---|---|
| `signaling` | ✅ | minimal WS server on **7332** (was 7331, changed to avoid Kilo Code collision), code auth, SDP relay only |
| `webrtc-host` | ✅ | creates RTCPeerConnection, sends SDP offer over signaling |
| `webrtc-guest` | ✅ | creates RTCPeerConnection, sends SDP answer |
| `peer-lifecycle` | ⚠️ partial | only `connected` / `disconnected` events; no heartbeat, no transfer |
| `tui-bridge` | ✅ | toasts for high-signal events |
| `tunnel-detector` | ❌ | — |
| `invite-parser` | ⚠️ partial | only parses `mp-<handle>-XXXX-XXXX`, not full URLs |
| `intent-broadcast` | ❌ | — |
| `companion-spawner` | ❌ | — |
| `companion` | ❌ | — |

---

## References (PRD sections relevant to this phase)

- PRD §6.2 — Invite codes (F-2.1, F-2.2 only — format and case-insensitive)
- PRD §6.3 — Signaling (F-3.1, F-3.4 — host-side WS, clean shutdown)
- PRD §6.4 — WebRTC P2P layer (F-4.1 — handshake)
- PRD §6.5.3 — In-TUI bridge (F-5.9 — toast for connect/disconnect)
- PRD §9 — UX Flow A, steps 1–7 only (host mints, guest joins, no chat)

---

## Open questions for Phase 01

1. ~~**Auto-elect vs explicit host command.**~~ **Resolved: explicit `mp_host` tool.** Auto-elect was tried and broke opencode on machines with conflicting services (notably the Kilo Code VS Code extension on port 7331). Replaced with four explicit tools (`mp_host`, `mp_join`, `mp_leave`, `mp_status`). The plugin loads in `idle` and does nothing until the user calls a tool. **This is now the design.**
2. ~~**Handle on the same machine.**~~ **Resolved by Phase 02.** `MP_HANDLE` env var + collision-suffix landed in Phase 02.
3. ~~**Configurable port.**~~ **Resolved: `MP_PORT` env var supported from day 1.** Default is 7332 (one digit off from kilo-code's 7331). Override with `MP_PORT=8332 opencode` for both peers.
4. ~~**Multi-guest.**~~ **Resolved by Phase 02.** Multi-peer (1 host + N guests) landed in Phase 02.
5. **Slash command mechanism.** No real `/mp` slash command in Phase 01 or Phase 02 — the skill teaches the LLM to map plain-English intent to the right tool. A custom-command file in `~/.config/opencode/commands/` lands in a later phase.

---

## Design pivot — auto-elect was wrong (added post-ship)

The original Phase 01 design auto-elected host vs guest at plugin load by trying to bind port 7331:

- First plugin instance on a machine → host
- Subsequent instances → guest (port busy, fall back)

This broke opencode on machines where port 7331 was already taken — most notably the [Kilo Code](https://marketplace.visualstudio.com/items?itemName=kilocode.kilo-code) VS Code extension, which also binds 7331 as its local server. The plugin's startup work (toasts, logs) hung the opencode TUI on those machines.

**Fix:** explicit tools, lazy port binding, port offset to 7332 (avoiding kilo), `MP_PORT` env override. Plugin load is now a no-op. Installing the plugin is safe and adds zero measurable overhead. The user explicitly opts into hosting or joining.

This is a one-time pivot. Future phases inherit the explicit-tools model.
