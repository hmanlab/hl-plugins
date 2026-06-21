# Phase 04 — Intents + conflict detection

**Status:** Planned
**Depends on:** [Phase 03](./phase-03.md) shipped (companion pane is the visual surface for the intent feed)
**Goal:** Users can broadcast intent declarations ("I'm about to refactor auth.ts"). The plugin detects when two intents touch the same file and warns both peers.
**Outcome:** Bob types `intent refactor src/middleware/auth.ts to use bcrypt` in his companion (or `/mp intent ...` in the OpenCode prompt). Carol sees the intent in her companion within 2 seconds. If Carol then types `intent add bcrypt password helpers in src/middleware/auth.ts`, both see a conflict warning toast and their intent feeds highlight the overlap.

---

## Why this phase fourth

Phase 03 established the chat surface. Phase 04 layers the **coordination primitive** on top: intents are the lightweight "I'm about to touch X" signal that prevents merge conflicts and stepping on toes. The PRD's primary persona — *"We're three devs, and we keep stepping on each other's PRs"* — is solved by intents, not by chat.

Conflict detection is a thin layer (regex + a small set comparison), so it can ship as a small additive phase.

---

## Scope (in)

### Intent command (PRD F-6.1)

Two entry points (same as chat):

- `intent <free-text>` in the companion pane's input box
- `/mp intent <free-text>` in the OpenCode prompt

### Broadcast (PRD F-6.2)

- Intents flow over the WebRTC DataChannel as `intent` messages
- Appear in all peers' companion panes within 2s (NFR-PF.2)
- Intent feed is a dedicated region in the companion (between presence list and chat history)
- Last 50 intents per peer retained in memory

### File-path extraction (PRD F-6.3)

- Regex matches:
  - Absolute paths: `/Users/x/code/auth.ts`, `/home/x/projects/auth.ts`
  - Home-relative: `~/code/auth.ts`
  - Repo-relative: `./auth.ts`, `../auth.ts`, `src/auth.ts`
  - Bare: `auth.ts` (matched only if it ends with a common code-file extension)
- Multiple paths per intent allowed
- If a path can't be parsed, the intent still broadcasts but isn't checked for conflicts

### Conflict detection

- On every intent broadcast, the plugin computes the set of file paths across all currently-active intents
- If any two intents share at least one file path:
  - Broadcast a `conflict` message to all peers
  - Both peers whose intents overlap see a toast: `[multiplayer] ⚠ conflict: <filepath> (<handle1> + <handle2>)`
  - Both intent entries in the companion feed are visually marked (red border / warning icon)
  - The conflict clears automatically when either intent is removed or replaced

### Ephemeral (PRD F-6.4)

- Intents are in-memory only on the host
- Cleared on host restart (all peers reconnect, intent feed is empty)
- No disk persistence in this phase (deferred to v2.1)

### Slash command set

This phase adds `intent` and `/mp intent` to the command set. All other commands from Phase 02 still work.

---

## Out of scope (deferred)

| Item | Deferred to |
|---|---|
| Cloudflare Tunnel (LAN-only this phase) | Phase 05 |
| Heartbeat / crash detection | Phase 06 |
| Intent persistence across host restart | v2.1 |
| Soft/hard file locks (PRD D-13 — explicitly out of scope) | — |
| Intent-aware LLM prompt injection ("warn me if my next edit touches a peer's intent") | v2+ |
| Resolving conflicts (mark one as superseded) | v2+ |

---

## Acceptance criteria

- [ ] Bob types `intent refactor src/middleware/auth.ts to use bcrypt` → Carol sees the intent in her companion within 2s
- [ ] Carol types `intent add bcrypt password helpers in src/middleware/auth.ts` → both see a conflict warning toast and the intent feed marks both entries
- [ ] Conflict toast: `[multiplayer] ⚠ conflict: src/middleware/auth.ts (bob + carol)`
- [ ] Bob replaces his intent with `intent add bcrypt helpers in src/utils/password.ts` → conflict clears on both sides
- [ ] Non-file intents (e.g. `intent take a break`) do not trigger false conflicts
- [ ] Multiple paths in one intent work: `intent refactor src/auth.ts and src/session.ts`
- [ ] All four path formats are detected: absolute, `~/...`, `./...` and `../...`, bare with code-file extension
- [ ] Intent feed shows last 50 per peer; older entries scroll off
- [ ] Intents cleared on host restart (verified by stopping/starting host's opencode)
- [ ] Intents do not flow through signaling (NFR-P.1) — only through the DataChannel

---

## Test plan

### Basic intent broadcast

```bash
# In Bob's companion:
> intent refactor src/middleware/auth.ts to use bcrypt

# In Carol's companion (within 2s):
#   bob: refactor src/middleware/auth.ts to use bcrypt
```

### Conflict detection

```bash
# In Carol's companion:
> intent add bcrypt helpers in src/middleware/auth.ts

# Both should show:
#   toast: [multiplayer] ⚠ conflict: src/middleware/auth.ts (bob + carol)
#   intent feed: bob's and carol's entries are visually marked
```

### Path-format coverage

```bash
# All four should be detected as touching src/auth.ts:
> intent edit /Users/dev/projects/foo/src/auth.ts        # absolute
> intent edit ~/projects/foo/src/auth.ts                  # home-relative
> intent edit ./src/auth.ts                               # dot-relative
> intent edit src/auth.ts                                 # bare
```

### Non-file intent (no false positive)

```bash
> intent take a 5-min break
# expect: no conflict warnings, even if other peers have non-file intents
```

### Intent clears on conflict resolution

```bash
# After the conflict above:
# Bob replaces his intent with:
> intent add tests in tests/auth.test.ts
# expect: conflict cleared, intent feed shows two non-conflicting intents
```

### Host restart

```bash
# Bob (host) runs /mp leave. Carol becomes host.
# Bob rejoins as guest.
# expect: intent feed on both sides is empty (no persistence)
```

---

## Files

```
packages/plugin-multiplayer/
├── opencode/
│   ├── plugin/
│   │   └── multiplayer-tools.ts          # adds intent command + conflict logic
│   └── skill/
│       └── multiplayer/
│           └── SKILL.md                  # registers /mp intent
└── companion/
    └── src/
        ├── ui/
        │   ├── IntentFeed.tsx            # new — dedicated region
        │   └── ...
        └── lib/
            └── paths.ts                  # new — file-path regex
```

---

## Components (this phase)

| Component | Change from Phase 03 |
|---|---|
| `intent-broadcast` | New — full implementation: parse, broadcast, conflict warn, in-memory store on host |
| `companion` UI | Adds `IntentFeed.tsx`, mounts between presence and chat; visual conflict markers |
| `tui-bridge` | Adds conflict toast |
| `paths.ts` (new) | File-path regex library (shared between in-proc plugin and companion) |
| All other components | Unchanged |

---

## References (PRD sections relevant to this phase)

- PRD §3 Goals — "teammates can coordinate while their agents work"
- PRD §4 Personas — "Small team on a shared codebase"
- PRD §5 Story 5 — Bob declares an intent
- PRD §6.6 — Intent broadcast (F-6.1 through F-6.4)
- PRD §6.7 — Commands (`intent <text>` and `/mp intent <text>`)
- PRD §7 NFRs — NFR-P.1 (privacy — no intent data through signaling), NFR-PF.2 (<2s broadcast)
- PRD §10 D-9 — Intent persistence: none
- PRD §10 D-13 — File locks: out of scope
