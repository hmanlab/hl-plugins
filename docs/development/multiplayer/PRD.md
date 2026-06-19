# PRD: `@hl-plugins/multiplayer`

**Status:** Draft v1
**Owner:** hmanlab
**Target release:** v1.0.0
**Plugin scope:** OpenCode plugin in the `@hl-plugins/*` ecosystem

---

## Phase roadmap

The master PRD below describes the full v1.0.0 vision. The work has been split into 7 phases, ordered to ship the smallest testable slice first. Each phase file describes scope, acceptance criteria, test plan, files, and components in detail.

| # | Phase | Outcome |
|---|---|---|
| 01 | [Hello, peer](./phase-01.md) | Two `opencode` windows on the same machine show "✓ connected" toasts |
| 02 | [Sessions & host handoff](./phase-02.md) | `/mp leave` transfers the host role; old codes valid for 1 hour |
| 03 | [Companion pane + chat](./phase-03.md) | Auto-spawned Ink TUI with chat history and typing indicator |
| 04 | [Intents + conflict detection](./phase-04.md) | Intent broadcast warns when two peers touch the same file |
| 05 | [Cloudflare Tunnel](./phase-05.md) | Cross-network sessions via `cloudflared` |
| 06 | [Heartbeat & crash detection](./phase-06.md) | Crash detection triggers auto-transfer within 15s |
| 07 | [Polish, NFRs, publish](./phase-07.md) | v1.0.0 release — install, uninstall, docs, CI, npm publish |

**Why this order:** the outermost loop is proven first (Phase 01). Sessions, companion UI, intents, and reliability layers are added on top in increasing cost-of-rework order. Cloudflare Tunnel (Phase 05) is the highest-risk third-party dependency, so it lands late.

**Build order (recommended):** 01 → 02 → 03 → 04 → 05 → 06 → 07. Each phase must be shippable and demoable before the next begins.

---

## 1. Overview

`@hl-plugins/multiplayer` is an OpenCode plugin that lets multiple developers collaborate inside the same coding-agent session in real time. It auto-spawns a **companion TUI pane** (in a tmux split, iTerm2 split, or a detached terminal window) that renders presence, chat, and intent broadcast, with brief in-TUI toasts bridging events back to the main OpenCode prompt — so teammates can coordinate without leaving the terminal.

Built on top of the existing `@hmanlab/hl-plugins` installer CLI and shipped alongside `@hl-plugins/mmx`.

### Tagline

> **Multiplayer for OpenCode — chat with teammates in a companion pane while you code.**

---

## 2. Problem statement

OpenCode is single-user by design. Teams adopting it lose the lightweight coordination layer they had in pair-programming or live-share workflows. Today, devs fall back to:

- Slack threads alongside the agent (context-switch)
- Voice calls (no record, no async catch-up)
- Just hoping nobody steps on each other's toes (real conflicts at merge time)

We want OpenCode to feel like a shared room, not a solo terminal.

---

## 3. Goals & non-goals

### Goals (v1)

- Two or more OpenCode users can join the same session and see each other's presence, chat, and intent broadcasts
- The plugin coordinates **humans**, not code (git stays the source of truth for code)
- Host handoff is automatic — no orphaned sessions
- Fully self-hosted: zero infrastructure cost, no third-party data exposure
- Ships as one install command: `hl-plugins install multiplayer`
- **Companion pane auto-spawns** — tmux split / iTerm2 split / detached terminal window, with a manual `npx hl-plugins multiplayer-watch` fallback

### Non-goals (v1)

- Real-time same-file co-editing (use VS Code Live Share)
- Git worktree / branch / PR management (devs do this natively)
- File locks (intent broadcast is enough)
- Multi-session per user
- Mobile support
- Hosted signaling server (deferred until funding)

---

## 4. Personas

### Primary: Solo dev who pairs occasionally

> "I'm building a feature and want my coworker to watch what my agent does and chime in if it goes off the rails."

### Primary: Small team on a shared codebase

> "We're three devs, we use OpenCode, and we keep stepping on each other's PRs. We need a way to say 'I'm touching auth.ts' before kicking off a long refactor."

### Secondary: Open-source maintainer pair-programming with a contributor

> "I want to mentor someone through a tricky refactor, but we live in different timezones. Async chat + intent feed would be perfect."

---

## 5. User stories

### Story 1: Bob starts a session and shares the code

> As Bob (host), I want to start a multiplayer session and get a shareable invite code, so I can invite teammates without explaining setup steps.

**Acceptance:**
- Bob runs `opencode`; the plugin auto-starts a session
- The plugin prints the invite code (e.g., `mp-bob-a3f9-x7k2`) and a full URL
- Bob can copy-paste either into Slack

### Story 2: Carol joins Bob's session

> As Carol (guest), I want to join Bob's session by pasting the invite code, so I can start collaborating in under 30 seconds.

**Acceptance:**
- Plugin auto-spawns Carol's companion pane (tmux split / iTerm2 split / detached window) at OpenCode startup
- Carol runs `/mp join mp-bob-a3f9-x7k2` — either in her companion pane's input box or as a slash command in the OpenCode prompt
- Plugin resolves the code, establishes a P2P connection
- Carol sees Bob in her companion pane within 10 seconds

### Story 3: Bob leaves, Carol keeps going

> As Bob, I want to close my laptop and know the session won't die, so I can step away without disrupting Carol.

**Acceptance:**
- Bob closes OpenCode
- Plugin shows Carol a 10-second grace message
- After grace, Carol is auto-promoted to host
- A new invite code is generated
- Bob can later rejoin as a guest with his old code (within 1-hour grace)

### Story 4: Bob's machine crashes

> As Carol, I want the plugin to detect when Bob's host has crashed (not just closed gracefully) and auto-transfer, so I don't get stuck waiting forever.

**Acceptance:**
- Bob's machine crashes / loses network
- Plugin detects missing heartbeat after 15 seconds
- Transfer kicks in just like a graceful leave

### Story 5: Bob declares an intent

> As Bob, I want to tell Carol "I'm about to refactor auth.ts" before kicking off a long task, so she can pick a different file if she's planning to touch the same one.

**Acceptance:**
- Bob runs `/mp intent refactor src/middleware/auth.ts to use bcrypt` (in his companion pane or as a slash command)
- Carol sees it appear in her companion pane within 2 seconds
- If Carol also has an intent touching `auth.ts`, both see a warning in their companion pane and a toast in their OpenCode prompt

### Story 6: Bob uses Cloudflare Tunnel, but it isn't running yet

> As Bob, I want the plugin to wait for my tunnel to come up instead of failing immediately, so I don't have to time my OpenCode startup perfectly.

**Acceptance:**
- Bob starts OpenCode before `cloudflared`
- Plugin retries detection every 10 seconds for 2 minutes
- As soon as `cloudflared` is up, plugin proceeds
- After 2 minutes of no tunnel, plugin shows a clear error with setup instructions

---

## 6. Functional requirements

### 6.1 Tunnel integration

- **F-1.1** Plugin auto-detects a running Cloudflare Tunnel by:
  - Checking common ports (7331, 8080, 3000) for a `cloudflared`-managed endpoint
  - Looking for `~/.cloudflared/` config files
  - Parsing `cloudflared` output if it's running in the same shell
- **F-1.2** If no tunnel detected, plugin retries every 10s for up to 2 minutes
- **F-1.3** After 2 minutes without tunnel, plugin shows an error with a link to `docs/cloudflare-setup.md`
- **F-1.4** Once tunnel is detected, plugin captures the public URL automatically

### 6.2 Invite codes

- **F-2.1** Format: `mp-<handle>-<random4>-<random4>` (lowercase alphanumeric)
  - Example: `mp-bob-a3f9-x7k2`
- **F-2.2** Codes are case-insensitive on input
- **F-2.3** Plugin generates a unique handle on first run (defaults to OS username, editable)
- **F-2.4** Each session mints a fresh code on host change
- **F-2.5** Old codes remain valid for 1 hour after host change (graceful rejoin window)

### 6.3 Signaling (host-side)

- **F-3.1** Bob's plugin starts a WebSocket server on `localhost:7331`
- **F-3.2** Server requires an invite code to authenticate
- **F-3.3** Server exposes only enough metadata to establish WebRTC (no code/intent/chat data flows through signaling)
- **F-3.4** Signaling server terminates cleanly when OpenCode exits

### 6.4 WebRTC P2P layer

- **F-4.1** After signaling handshake, both peers establish a WebRTC DataChannel
- **F-4.2** All intent/chat/presence messages flow over the DataChannel
- **F-4.3** Connection auto-reconnects if either peer temporarily drops (≤30s)
- **F-4.4** On permanent disconnect (>30s), plugin shows "peer unreachable" state in the companion pane and emits a toast in the OpenCode prompt

### 6.5 Companion pane UI

OpenCode's plugin API does not expose a sidebar, panel, or chat-area component — only event hooks plus three TUI primitives: `tui.prompt.append`, `tui.command.execute`, and `tui.toast.show` (see [`opencode.ai/docs/plugins/`](https://opencode.ai/docs/plugins/)). For a real presence/chat/intent UI, the plugin therefore runs a **separate companion TUI process** in a sibling terminal region and bridges high-signal events back into OpenCode as toasts.

#### 6.5.1 Companion pane (the primary UI)

- **F-5.1** A companion TUI process renders the live multiplayer UI: presence list, intent feed, chat history, input box.
- **F-5.2** The companion is a separate Node + Ink (React-for-CLIs) process published as a standalone workspace package at `packages/multiplayer-watch/`. It communicates with the in-process plugin code over a Unix domain socket (or named pipe on Windows) — never via the OpenCode TUI's stdin/stdout.
- **F-5.3** Three command forms (see §6.7 for the full list):
  - `<message>` typed into the companion pane's input box — sends a chat message (no slash prefix needed in the companion)
  - `intent <text>` typed into the companion pane's input box — broadcasts an intent
  - `/mp <command>` typed into the OpenCode prompt — same commands, registered as a custom command for keyboard-only users
- **F-5.4** Updates render in real-time as messages arrive (no polling, push over the domain socket).
- **F-5.5** Typing indicator: "X is typing..." appears in the companion pane header when a peer is composing.

#### 6.5.2 Companion pane auto-spawn

The plugin picks the first available strategy from this list:

1. **tmux split** — if `$TMUX` is set and `tmux` is on `$PATH`, split the current pane horizontally and run the companion in the new pane.
2. **iTerm2 split** — macOS only, when the parent terminal is iTerm2 (detected via `ITERM_SESSION_ID` or `TERM_PROGRAM=iTerm.app`); use AppleScript to split the current session.
3. **Detached terminal window** — open a new window in the user's default terminal emulator: Terminal.app (macOS), Windows Terminal (Windows), or `gnome-terminal` / `konsole` / `xfce4-terminal` / `kitty` / `wezterm` / `alacritty` / `ghostty` (Linux, in that preference order; honor `$TERMINAL` if set).
4. **Manual fallback** — print a single line to the OpenCode stderr / first toast: `Run "npx @hl-plugins/multiplayer-watch" in another terminal` and continue. The plugin re-checks every 10s for up to 5 minutes for the watch process to attach, then proceeds without it (the companion is opt-in but not required for the session to function).

- **F-5.6** Spawn decision and execution happen **after** OpenCode's TUI is fully initialized, so they never block the prompt or startup (see NFR-PF.4).
- **F-5.7** Spawn failure is non-fatal: log a clear warning, fall through to the next strategy, and ultimately to manual mode. The plugin emits exactly one toast telling the user how to launch the companion manually.
- **F-5.8** The companion process is killed cleanly when OpenCode exits (host) or when the user runs `/mp leave` (guest). On crash, the companion re-spawns once automatically; after that it gives up and prints a recovery hint.

#### 6.5.3 In-TUI bridge (toasts only)

Because no sidebar/panel exists in the OpenCode plugin API, the main OpenCode TUI gets a small bridge:

- **F-5.9** A toast notification is shown (`tui.toast.show`) for high-signal events: peer joined, peer left, host leaving in N seconds, transfer completed, intent conflict detected, tunnel-error / disconnect, new invite code.
- **F-5.10** All other UI (chat history, presence list, intents, input) lives in the companion pane only. The OpenCode TUI is unchanged.

### 6.6 Intent broadcast

- **F-6.1** Any user can declare an intent: `intent <free-text>` in the companion pane, or `/mp intent <free-text>` in the OpenCode prompt
- **F-6.2** Intents appear in all peers' companion panes within 2 seconds
- **F-6.3** Plugin extracts file paths from intent text (basic regex) and warns if two intents touch the same file — warning shows in the companion pane and as a toast in the OpenCode prompt
- **F-6.4** Intents are ephemeral (in-memory only) — lost when host restarts

### 6.7 Commands

Every command is available in **two** places:

- **Companion pane input box** — type the bare verb (e.g. `join mp-bob-a3f9-x7k2`, `leave`, `status`). No slash prefix.
- **OpenCode prompt slash command** — type `/mp <verb> <args>`. Registered as a custom command file installed by the plugin so the user never leaves the keyboard.

The full command set:

- `join <code|url>` — join a session
- `leave` — gracefully exit session (host triggers transfer)
- `cancel-leave` — cancel a pending leave (host only, within grace period)
- `volunteer` — volunteer to be next host
- `code` — show current invite code (host only)
- `status` — show session state, peers, host
- `history` — show recent host transfers in this session
- `intent <text>` — broadcast an intent
- `<free text>` — in the companion pane, send a chat message (no `chat` prefix needed; the input box is chat-first)

All commands also accept the `/mp` prefix when entered in the OpenCode prompt (e.g. `/mp join mp-bob-a3f9-x7k2`). The companion pane strips the prefix if present and forwards to the same handler.

### 6.8 Auto-transfer

- **F-8.1** When host leaves gracefully:
  1. Host emits `host_leaving` with 10s grace
  2. Peers see "X is leaving, transfer in 10s..."
  3. Any peer can `/mp volunteer` to be next host
  4. After 10s, plugin picks successor:
     - Priority 1: any volunteer (longest-connected wins ties)
     - Priority 2: longest-connected peer
  5. Successor's plugin starts its own signaling server
  6. New invite code minted
  7. All peers reconnect to new host
- **F-8.2** When host crashes (no `host_leaving`):
  1. Peers detect 3 missed heartbeats (15s silence)
  2. Treat as graceful leave, run auto-transfer
- **F-8.3** New host's machine firewall blocks incoming:
  1. Peers fail to connect within 5s
  2. Auto-cascade to next successor
  3. If all successors fail, session ends with clear error

### 6.9 Heartbeat

- **F-9.1** Host emits heartbeat every 5 seconds
- **F-9.2** Peers track `lastHeartbeat` timestamp
- **F-9.3** If `now - lastHeartbeat > 15s`, host assumed dead, trigger transfer

---

## 7. Non-functional requirements

### Privacy

- **NFR-P.1** Zero code, file, or intent content flows through any third-party server
- **NFR-P.2** Only WebRTC connection metadata (SDP, ICE candidates) flows through the tunnel
- **NFR-P.3** Tunnel URL is not logged or transmitted anywhere
- **NFR-P.4** No telemetry, no analytics, no error reporting

### Performance

- **NFR-PF.1** Chat message delivery: < 500ms (LAN), < 2s (cross-network)
- **NFR-PF.2** Intent broadcast: < 2s end-to-end
- **NFR-PF.3** Companion pane updates render at ≥ 30fps (smooth in a separate terminal region; Ink diffing makes this cheap)
- **NFR-PF.4** Plugin adds ≤ 50ms latency to OpenCode startup; companion pane spawn happens asynchronously after OpenCode is fully initialized, never blocks the prompt

### Reliability

- **NFR-R.1** Plugin handles network blips gracefully (≤30s reconnect window)
- **NFR-R.2** Plugin handles Bob's machine crash without freezing Carol's UI
- **NFR-R.3** Plugin handles tunnel death (e.g., cloudflared restart) by re-detecting
- **NFR-R.4** If the companion pane process crashes, the plugin auto-respawns it once (F-5.8); after that, a recovery hint is shown and the user can relaunch via `npx @hl-plugins/multiplayer-watch`

### Compatibility

- **NFR-C.1** Works on macOS, Linux, Windows (WSL) — requires one of: `tmux` (any OS), iTerm2 (macOS), Terminal.app (macOS), Windows Terminal, `gnome-terminal`, `konsole`, `xfce4-terminal`, `kitty`, `wezterm`, `alacritty`, or `ghostty` for auto-spawn. Falls back to manual `npx @hl-plugins/multiplayer-watch` if none detected.
- **NFR-C.2** Requires Node 18+ and Bun runtime (OpenCode's runtime); the companion process itself only needs Node 18+ (Bun is inherited from the parent when possible)
- **NFR-C.3** Works with OpenCode v1.x

### Install / uninstall

- **NFR-I.1** Install via existing `hl-plugins install multiplayer` command
- **NFR-I.2** Pre-flight checks: detect `cloudflared` (warn if missing, don't fail)
- **NFR-I.3** Idempotent install (re-running is no-op)
- **NFR-I.4** Clean uninstall via `hl-plugins uninstall multiplayer` (no orphan files)

---

## 8. Architecture (high level)

```
┌─ Bob's machine ───────────────────────────────────────────────┐
│                                                               │
│  ┌─ OpenCode TUI ─────────────┐   ┌─ Companion pane ────────┐ │
│  │ prompt + agent transcript │   │ Ink TUI in tmux split / │ │
│  │ toasts: peer joined,      │   │ iTerm2 split / detached │ │
│  │ transfer in 10s, conflict │◄─►│ window                  │ │
│  └────────────┬───────────────┘   │ presence · chat ·       │ │
│               │                   │ intents · input box     │ │
│               │                   └────────────▲────────────┘ │
│               │                                │              │
│               ▼                                │ UDS / pipe   │
│  ┌─ @hl-plugins/multiplayer (in-proc) ─────────┴────────────┐ │
│  │  ├─ tunnel-detector (auto, retry)                        │ │
│  │  ├─ signaling (ws://localhost:7331)                      │ │
│  │  ├─ webrtc-host                                          │ │
│  │  ├─ peer-lifecycle (heartbeat)                           │ │
│  │  ├─ intent-broadcast                                     │ │
│  │  └─ companion-spawner ──► spawns / attaches companion    │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                               │
│  cloudflared tunnel ────────────────────────────────────────┼──► public URL
└───────────────────────────────────────────────────────────────┘
                                                                    │
                                                                    │ WebRTC handshake
                                                                    │
┌─ Carol's machine ───────────────────────────────────────────────┐│
│  ┌─ OpenCode TUI ─────────────┐   ┌─ Companion pane ────────┐   ││
│  │ prompt + toasts            │   │ Ink TUI, same shape     │   ││
│  └────────────┬───────────────┘   └────────────▲────────────┘   ││
│               │                                │                ││
│               ▼                                │ UDS / pipe     ││
│  ┌─ @hl-plugins/multiplayer (in-proc) ─────────┴────────────┐   ││
│  │  ├─ invite-parser                                        │   ││
│  │  ├─ webrtc-guest ◄───────────────────────────────────────┼───┼┘
│  │  ├─ peer-lifecycle                                      │   │
│  │  ├─ intent-broadcast                                    │   │
│  │  └─ companion-spawner                                   │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                   │
│  (no tunnel needed for guests)                                   │
└───────────────────────────────────────────────────────────────────┘
```

The **in-process plugin code** (everything except the companion) runs inside OpenCode's Bun runtime. The **companion pane** is a separate Node + Ink process launched by `companion-spawner` into a sibling terminal region. The two communicate over a Unix domain socket (or named pipe on Windows) — never via the OpenCode TUI's stdin/stdout. The OpenCode TUI itself only ever sees toast notifications via `tui.toast.show`.

### Component breakdown

| Component | Runs in | Responsibility |
|---|---|---|
| `tunnel-detector` | OpenCode (Bun) | Detect running cloudflared, retry if absent |
| `invite-parser` | OpenCode (Bun) | Parse `mp-<handle>-XXXX-XXXX` and full URLs |
| `signaling` | OpenCode (Bun) | Host-side: WebSocket server on localhost:7331 |
| `webrtc-host` | OpenCode (Bun) | Host-side: WebRTC SDP offer/answer, DataChannel management |
| `webrtc-guest` | OpenCode (Bun) | Guest-side: WebRTC handshake initiator |
| `peer-lifecycle` | OpenCode (Bun) | Presence, heartbeat, leave/crash detection, transfer |
| `intent-broadcast` | OpenCode (Bun) | Parse, broadcast, conflict warn |
| `tui-bridge` | OpenCode (Bun) | Emit `tui.toast.show` events from in-proc state to the OpenCode TUI |
| `companion-spawner` | OpenCode (Bun) | Pick the first viable spawn strategy (§6.5.2), launch the companion, attach to its UDS/pipe, re-spawn on crash |
| `companion` | Separate process (Node + Ink) | Render presence list, intent feed, chat history, input box; relay user input back over the UDS/pipe |

---

## 9. UX flows

### Flow A: Bob hosts, Carol joins, both chat

1. Bob runs `opencode`
2. After OpenCode's TUI is up, the plugin's `companion-spawner` splits Bob's tmux pane horizontally and launches the companion process
3. Companion detects the tunnel, mints the invite code, prints `mp-bob-a3f9-x7k2` in its header
4. Bob copies the code into Slack
5. Carol runs `opencode`; her companion pane auto-spawns the same way
6. Carol types `join mp-bob-a3f9-x7k2` into her companion pane's input box
7. Plugin resolves, connects via WebRTC, Carol's companion pane header updates to "✓ connected to bob"
8. Carol types `hi, ready when you are` in the companion pane
9. Bob's companion pane shows the message inline
10. Bob types `intent refactor auth.ts to use bcrypt` in his companion pane
11. Carol's companion pane shows the intent

### Flow B: Bob leaves, Carol takes over

1. Bob runs `exit` in his terminal
2. Bob's plugin emits `host_leaving` with 10s grace; Bob's companion pane closes cleanly
3. Carol's companion pane updates: "Bob is leaving. Auto-transfer in 10..." and OpenCode TUI shows a toast
4. After 10s, plugin picks Carol (longest-connected)
5. Carol's plugin starts her own signaling server
6. New code displayed in Carol's companion pane header: `mp-carol-b8e1-m4n9`
7. (If Bob reconnects later) He runs `opencode`, his companion pane re-spawns, and he types `rejoin mp-bob-a3f9-x7k2` to come back as guest

### Flow C: Tunnel not running

1. Bob runs `opencode` without `cloudflared` running
2. Plugin tries to detect tunnel — fails
3. Plugin retries every 10s, shows "Waiting for Cloudflare Tunnel (attempt N/12)..." as a toast in OpenCode and a banner in the companion pane
4. Bob runs `cloudflared tunnel --url http://localhost:7331` in another terminal
5. Plugin detects tunnel on next retry
6. Session starts normally

### Flow D: No supported terminal for auto-spawn (manual fallback)

1. Bob runs `opencode` from inside a terminal the plugin does not recognize (e.g. a minimal `linux` console or a proprietary terminal without an AppleScript bridge)
2. `companion-spawner` walks through tmux / iTerm2 / detached-window strategies — all fail
3. Plugin prints a single line to the OpenCode stderr and emits a toast: `Run "npx @hl-plugins/multiplayer-watch" in another terminal`
4. Bob opens a second terminal and runs the command
5. Watch process attaches via the UDS; companion pane appears in that terminal
6. Plugin continues normally — the session does not block on the companion

---

## 10. Decisions log

| # | Decision | Value | Rationale |
|---|---|---|---|
| D-1 | Topology | P2P via WebRTC | Privacy, no infra cost |
| D-2 | Hosting model | One user hosts per session | Simplest ownership model |
| D-3 | Host handoff | Auto-transfer, longest-connected wins | No babysitting |
| D-4 | Tunnel tool | Cloudflare Tunnel (`cloudflared`) | Free, unlimited bandwidth, persistent URLs |
| D-5 | Tunnel discovery | Auto-detect with 10s retry, 2min timeout | Best UX without being magical |
| D-6 | Invite code format | `mp-<handle>-<4>-<4>` | Memorable, scoped |
| D-7 | Sessions per user | Single (v1) | Simpler UX, multi-session = v2 |
| D-8 | Auth | Invite codes only | Sufficient for trusted teams |
| D-9 | Intent persistence | None (in-memory) | Simpler, ephemeral is fine |
| D-10 | Notifications | Companion pane (primary) + OpenCode toast (bridge) | No sound/desktop spam; in-TUI gets only high-signal toasts since no sidebar API exists |
| D-11 | Session naming | Optional field | Useful for orgs, not required |
| D-12 | Code sync | Out of scope (devs use git) | Not plugin's job |
| D-13 | File locks | Out of scope | Intent broadcast is enough |
| D-14 | Real-time co-edit | Out of scope (v1+) | Use VS Code Live Share |
| D-15 | Future hosted signaling | After funding | Zero-friction onboarding |
| D-16 | UI surface | Companion TUI pane in a sibling terminal region | OpenCode's plugin API exposes no sidebar/panel; a separate Node + Ink process gives the rich UI without violating the API. Auto-spawn strategy order: tmux split → iTerm2 split → detached terminal window → manual `npx @hl-plugins/multiplayer-watch` |

---

## 11. Success metrics

### Adoption (3 months post-launch)

- 500+ installs via `hl-plugins install multiplayer`
- 50+ GitHub stars on the plugin repo
- 10+ community PRs

### Engagement

- Avg session length > 30 minutes (signals real collaboration, not just testing)
- 70%+ of sessions have ≥ 2 peers (not just solo usage)
- Avg 5+ intents per session (coordination is actually happening)

### Reliability

- < 2% crash rate per session
- < 5% reported issues with auto-transfer edge cases
- < 1% reported issues with tunnel detection

### Privacy

- Zero incidents of code/intent data leaking through signaling
- Zero incidents of third-party data exposure

---

## 12. Out of scope (v1)

- Multi-session per user
- Real-time same-file co-editing
- Git worktree / branch / PR management
- File locks (soft or hard)
- Mobile / tablet support
- Hosted signaling server (deferred until funding)
- Cross-session chat history
- Voice / video channels
- OAuth / passkey auth
- TURN relay (only ~85% of networks work via STUN; remaining 15% need TURN = v2)
- Browser companion UI
- Per-user permissions / roles
- Anonymous read-only spectators
- Slack / Discord webhooks for off-OpenCode notifications

---

## 13. Future work (v2+)

- **v2.0:** Our Cloudflare Worker signaling (zero-friction onboarding, no tunnel needed)
- **v2.0:** TURN relay for symmetric NAT / corporate firewall users
- **v2.1:** Multi-session per user
- **v2.1:** Intent persistence across host restart
- **v2.2:** Browser companion UI
- **v3.0:** Real-time same-file co-edit (using Yjs CRDTs, syntax-aware)
- **v3.0:** Mobile support via browser companion
- **v3.0:** Voice channel (WebRTC audio)

---

## 14. Open risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Cloudflare Tunnel free tier changes | Low | High | Document alternative tunnels (ngrok, Tailscale) |
| WebRTC fails on some networks (symmetric NAT) | High (~15%) | Medium | Clear error message + TURN relay in v2 |
| OpenCode plugin API gains a sidebar/panel and the companion-pane approach becomes redundant | Low | Low | Track upstream; pivot the in-TUI bridge to use the new API as an alternative entry point while keeping the companion |
| Auto-transfer race conditions | Medium | High | Comprehensive test suite (8+ edge cases) |
| Bob's machine firewall blocks incoming | High (~15%) | High | Auto-cascade to next successor |
| Companion pane fails to auto-spawn on an unrecognized terminal | Medium | Low | Manual fallback: `npx @hl-plugins/multiplayer-watch` (F-5.6, Flow D). Session is not blocked on the companion |
| Companion process crashes mid-session | Low | Medium | Auto-respawn once (NFR-R.4); after that, recovery hint + manual relaunch |
| Handle collisions (two "bob"s) | Low | Low | Append random suffix on first run, editable |
| Plugin breaks on OpenCode API changes | Medium | High | Pin OpenCode version, monitor GH issues |

---

## 15. References

- OpenCode plugin docs: `https://opencode.ai/docs/plugins/`
- Cloudflare Tunnel quick tunnels: `https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/`
- WebRTC for peers: `https://webrtc.org/getting-started/peer-connections`
- Existing `hl-plugins` ecosystem: `github.com/hmanlab/hl-plugins`
- Existing `@hl-plugins/mmx` for reference architecture: `github.com/hmanlab/hl-plugins/packages/plugin-mmx`

---

## 16. Glossary

- **Host** — User currently running the signaling server; owns the session until they leave
- **Guest / Peer** — User who joined the host's session
- **Session** — A multiplayer collaboration room, identified by invite code
- **Intent** — A declaration of what a user is about to work on, broadcast to all peers
- **Tunnel** — A public URL exposed via `cloudflared` that lets guests reach the host's localhost
- **Signaling** — Tiny WebSocket server that helps two peers establish a WebRTC connection
- **WebRTC** — Browser-native P2P protocol for real-time data exchange
- **Transfer** — When the host leaves and a new host is auto-promoted
- **Successor** — The peer selected to become the new host after a transfer
- **Companion pane** — A separate Node + Ink TUI process launched by `companion-spawner` into a sibling terminal region (tmux split, iTerm2 split, or a detached terminal window). Renders presence, chat history, intents, and the input box. Communicates with the in-process plugin code over a Unix domain socket (or named pipe on Windows)
- **In-TUI bridge** — The small set of `tui.toast.show` notifications emitted from the in-process plugin to the OpenCode TUI; the only multiplayer signal visible in the main prompt

---

*End of PRD v1*