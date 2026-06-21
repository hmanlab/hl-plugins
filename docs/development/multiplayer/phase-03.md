# Phase 03 — Companion pane + chat

**Status:** Shipped (v0.3.0)
**Depends on:** [Phase 02](./phase-02.md) ✅ Shipped
**Goal:** Ship the companion TUI process (Node + Ink) with chat history. Auto-spawn into a tmux split / iTerm2 split / detached terminal window. Both peers send chat messages and see them in real-time, with a typing indicator.
**Outcome:** Bob runs `opencode` in tmux. His tmux pane splits automatically, the companion appears in the new pane, and shows Bob's handle. Carol joins, types `hi` in her companion, and Bob's companion shows `carol: hi` within 500ms. A "carol is typing..." banner appears in Bob's companion while Carol composes.

---

## Why this phase third

Phases 01 and 02 prove the connection and session model work. Phase 03 is the **first user-visible value** — the actual chat surface. Until now the only "collaboration" was a connect/disconnect toast.

Phase 03 also addresses the OpenCode API constraint: OpenCode's plugin API has no sidebar or panel, so chat/intent/presence all need to live somewhere. The companion TUI process in a sibling terminal region is the only terminal-native solution that doesn't require a browser or a hosted web UI.

The companion uses **Ink** (React for CLIs) because:
- The plugin's main process is already in OpenCode's Bun runtime (React-friendly)
- Ink's diffing makes 30fps trivial even on slow terminals
- Same React components can be reused in a v2 web UI

---

## Scope (in)

### Companion process (`packages/plugin-multiplayer/companion/`)

- Node + Ink TUI
- Renders three regions:
  - **Header / status bar** — current code (host only), session state, peer count
  - **Main panel** — presence list (left), chat history (right, scrollable)
  - **Input box** — bottom-anchored, single-line, chat-first
- Connects to the in-process plugin code over a **Unix domain socket** (or named pipe on Windows)
- JSON-line protocol over the socket
- Sends input back to the plugin; plugin routes it to the DataChannel

### Spawn strategies (PRD §6.5.2)

The plugin picks the first available strategy:

1. **tmux split** — if `$TMUX` is set and `tmux` is on `$PATH`, split the current pane horizontally and run the companion in the new pane
2. **iTerm2 split** — macOS only, when the parent terminal is iTerm2 (detected via `ITERM_SESSION_ID` or `TERM_PROGRAM=iTerm.app`); use AppleScript to split the current session
3. **Detached terminal window** — open a new window in the user's default terminal emulator: Terminal.app (macOS), Windows Terminal (Windows), or `gnome-terminal` / `konsole` / `xfce4-terminal` / `kitty` / `wezterm` / `alacritty` / `ghostty` (Linux, in that preference order; honor `$TERMINAL` if set)
4. **Manual fallback** — print a single line to the OpenCode stderr and emit a toast: `Run "npx @hmanlab/multiplayer-watch" in another terminal` and continue. The plugin re-checks every 10s for up to 5 minutes for the watch process to attach, then proceeds without it (the companion is opt-in but not required for the session to function)

### Chat

- `<free text>` in companion input → chat message
- `/mp <message>` in OpenCode prompt → same chat (dual entry)
- Typing indicator broadcast on input focus (throttled: emit on focus change, not on every keystroke)
- Chat history persisted in memory only (Phase 07 may add disk persistence)
- History cap: last 500 messages, scrollable

### Lifecycle

- **Spawned async** after OpenCode's TUI is fully initialized (F-5.6) — never blocks startup
- **Killed cleanly** when OpenCode exits (host) or when the user runs `/mp leave` (guest) — F-5.8
- **Auto-respawn once** on crash — NFR-R.4; after that, a recovery hint is shown and the user can relaunch via `npx @hmanlab/multiplayer-watch`

### In-TUI bridge (toasts only)

- High-signal events get a toast in the OpenCode prompt: peer joined, peer left, host leaving in N seconds, transfer completed, conflict detected, new invite code
- All other UI lives in the companion pane only

### NFRs

- **NFR-PF.3** Companion pane updates render at ≥ 30fps (Ink diffing makes this cheap)
- **NFR-PF.4** Plugin adds ≤ 50ms latency to OpenCode startup; companion spawn is async
- **NFR-R.4** Auto-respawn once on companion crash

---

## Out of scope (deferred)

| Item | Deferred to |
|---|---|
| Intent broadcast (the "I'm about to refactor X" feature) | Phase 04 |
| Cloudflare Tunnel (LAN-only this phase) | Phase 05 |
| Heartbeat / crash detection | Phase 06 |
| Chat history disk persistence | Phase 07 |
| `/mp history` command (recent host transfers) | Phase 07 |
| Manual `/mp` slash command for the full command set is already in Phase 02 — this phase only adds the **companion input box** entry point | — |

---

## Acceptance criteria

- [ ] Bob runs `opencode` inside tmux → pane splits horizontally, companion appears in the new pane within 3s
- [ ] Companion header shows Bob's handle and `hosting` status
- [ ] Carol runs `opencode` in another tmux pane on the same machine and `/mp join`s
- [ ] Carol's companion header updates to `✓ connected to bob` and presence list shows `[bob, carol]`
- [ ] Carol types `hi` in her companion input → Bob's companion shows `carol: hi` within 500ms (LAN)
- [ ] When Carol focuses her input, Bob's companion header shows "carol is typing..." within 200ms
- [ ] When Carol blurs the input, the typing indicator clears within 1s
- [ ] `/mp hello from Bob` typed in Bob's OpenCode prompt sends the same chat message as the companion input
- [ ] Plugin does not block OpenCode startup (companion spawn happens after TUI init)
- [ ] Companion process exits cleanly within 1s of OpenCode exit
- [ ] If companion is killed manually (`kill -9 <pid>`), plugin auto-respawns it once
- [ ] NFR-PF.4: measured OpenCode startup overhead ≤ 50ms
- [ ] On a terminal the plugin does not recognize, prints `Run "npx @hmanlab/multiplayer-watch" in another terminal` and the session continues without a companion
- [ ] Companion never draws to the OpenCode TUI's stdout

---

## Test plan

### Auto-spawn in tmux

```bash
tmux new -s mp-test
# inside tmux:
opencode
# expect: tmux pane splits horizontally, companion appears in new pane

# in another tmux pane (Ctrl-b %):
opencode
> /mp join mp-bob-XXXX
# both companions show two peers
```

### Chat roundtrip

```bash
# In Carol's companion input box:
hi from carol
# expect in Bob's companion within 500ms:
#   carol: hi from carol
```

### Typing indicator

```bash
# In Carol's companion: click into the input box (or just start typing)
# expect in Bob's companion header within 200ms:
#   carol is typing...
# type a few chars, then click out
# expect: typing indicator clears within 1s
```

### Dual entry (slash command ↔ companion)

```bash
# In Bob's OpenCode prompt:
> /mp hello from Bob
# expect in Carol's companion:
#   bob: hello from Bob
```

### Companion auto-respawn

```bash
# Find the companion process and kill -9 it
pgrep -f "hl-plugins/multiplayer" | xargs kill -9
# expect: companion re-spawns within 2s, state reconnected (no reconnect prompt)
```

### Manual fallback

```bash
# Run opencode from a terminal the plugin does not recognize
# (e.g. a minimal linux console)
opencode
# expect: toast [multiplayer] Run "npx @hmanlab/multiplayer-watch" in another terminal
# In another terminal:
npx @hmanlab/multiplayer-watch
# expect: companion appears in that terminal
```

---

## Files

```
packages/plugin-multiplayer/
├── package.json                          # adds `bin` field for npx multiplayer-watch
├── tsconfig.json
└── opencode/
    ├── plugin/
    │   └── multiplayer-tools.ts
    └── skill/
        └── multiplayer/
            └── SKILL.md

# New: companion process (standalone workspace)
packages/multiplayer-watch/
├── package.json                          # separate node module
├── tsconfig.json
├── src/
│   ├── index.ts                          # companion entry, sets up Ink
│   ├── ui/
│   │   ├── App.tsx                       # root React component
│   │   ├── Header.tsx                    # status bar
│   │   ├── PresenceList.tsx
│   │   ├── ChatHistory.tsx               # scrollable
│   │   └── InputBox.tsx                  # chat-first input
│   ├── transport/
│   │   └── uds.ts                        # Unix domain socket / named pipe client
│   └── protocol.ts                       # shared message types
└── bin/
    └── multiplayer-watch.js              # `npx @hmanlab/multiplayer-watch` entry

# New: shared protocol (used by both in-proc plugin and companion)
packages/plugin-multiplayer/shared/
└── protocol.ts                           # message types, version, etc.
```

---

## Components (this phase)

| Component | Change from Phase 02 |
|---|---|
| `tui-bridge` | Adds toasts for new companion events (typing, chat overflow) |
| `companion-spawner` | New — picks first viable spawn strategy, launches the companion, attaches to its UDS/pipe, re-spawns on crash |
| `companion` | New — separate Node + Ink process; renders the full UI |
| `signaling` / `webrtc-host` / `webrtc-guest` / `peer-lifecycle` | Unchanged |
| `intent-broadcast` | ❌ (Phase 04) |
| `tunnel-detector` | ❌ (Phase 05) |

---

## References (PRD sections relevant to this phase)

- PRD §3 Goals — "Companion pane auto-spawns"
- PRD §5 Story 2 — Carol joins Bob's session
- PRD §6.5 — Companion pane UI (full section: 6.5.1 pane, 6.5.2 spawn, 6.5.3 toast bridge)
- PRD §6.7 — Commands (companion input box entry point)
- PRD §7 NFRs — NFR-PF.3, NFR-PF.4, NFR-R.4, NFR-C.1, NFR-C.2
- PRD §9 Flow A — Bob hosts, Carol joins, both chat
- PRD §9 Flow D — Manual fallback
- PRD §10 D-10, D-16 — Notifications and UI surface decisions
- PRD §16 Glossary — Companion pane, In-TUI bridge
