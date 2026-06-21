# Phase 07 — Polish, NFRs, publish (v1.0.0)

**Status:** Planned
**Depends on:** All previous phases shipped
**Goal:** Ship the v1.0.0 release. Pre-flight checks, idempotent install, clean uninstall, full docs, CI passes, npm publish. All PRD NFRs met.
**Outcome:** A user can `npm install -g @hmanlab/hl-plugins` (or `npx -y @hmanlab/hl-plugins`), then `hl-plugins install multiplayer`, and use every feature from Phases 01–06 with confidence. Every PRD NFR is met. `hl-plugins uninstall multiplayer` removes everything cleanly. CI green. v1.0.0 published.

---

## Why this phase last

Phases 01–06 build the feature. Phase 07 is the **release engineering** layer — the things that make the difference between "a working plugin on the dev's machine" and "a publishable npm package that anyone can install". Concretely:

- **Pre-flight** — detect missing dependencies (`cloudflared`) before the user hits them
- **Idempotency** — `install` and `uninstall` are safe to re-run
- **Docs** — `architecture.md`, `cloudflare-setup.md`, `companion-fallback.md`, README
- **CI** — typecheck, build, lint, publish workflow
- **Final commands** — `/mp history` to round out the command set

This is the boring-but-essential phase that makes the plugin feel like a real product, not a weekend project.

---

## Scope (in)

### Install / uninstall (PRD NFR-I.1 through NFR-I.4)

- **Pre-flight checks**:
  - Detect `cloudflared` (warn if missing, don't fail — NFR-I.2)
  - Detect Bun runtime
  - Detect at least one supported terminal emulator (warn if none — companion pane will not auto-spawn)
- **Idempotent install** (NFR-I.3):
  - Re-running `hl-plugins install multiplayer` is a no-op
  - Existing config merges cleanly (no duplicate entries in `~/.opencode/config.json`)
  - Skill files are overwritten only if content has changed
- **Clean uninstall** (NFR-I.4):
  - `hl-plugins uninstall multiplayer` removes:
    - `~/.opencode/plugin/multiplayer-tools.ts`
    - `~/.opencode/skill/multiplayer/` (entire folder)
    - Companion process is killed if running
    - Socket / pipe files in `~/.hl-plugins/multiplayer/sockets/` are removed
  - `~/.hl-plugins/multiplayer/state.json` is preserved (grace codes, recent history) — only removed on explicit `--purge`

### Commands finalization

- `/mp history` — show recent host transfers in this session (PRD §6.7)
- All commands from §6.7 are exercised and tested

### Companion recovery

- If companion process crashes, auto-respawn once (NFR-R.4) — already implemented in Phase 03, validated in Phase 07
- Recovery hint + manual `npx @hmanlab/multiplayer-watch` fallback (Flow D)

### Reliability (PRD NFR-R.1, NFR-R.2, NFR-R.3)

- Plugin handles network blips gracefully (≤ 30s reconnect window) — validated in Phase 06
- Plugin handles Bob's machine crash without freezing Carol's UI — validated in Phase 06
- Plugin handles tunnel death by re-detecting — validated in Phase 05/06

### Compatibility (PRD NFR-C.1, NFR-C.2, NFR-C.3)

- Test on macOS, Linux, Windows (WSL) — at least smoke-tested on each
- Document required terminal emulators and Node/Bun versions in the README
- Pin a tested OpenCode version range in `package.json`'s `peerDependencies`

### Docs

New / updated:

- `docs/development/multiplayer/architecture.md` — companion model, UDS transport, message protocol
- `docs/development/multiplayer/cloudflare-setup.md` — from Phase 05
- `docs/development/multiplayer/companion-fallback.md` — manual `npx @hmanlab/multiplayer-watch` flow
- `packages/plugin-multiplayer/README.md` — user-facing install + usage
- Update `docs/adding-a-plugin.md` if the contract changed

### CI

- `npm run typecheck` passes (TypeScript strict)
- `npm run build` passes
- Lint passes (whatever the existing project uses)
- Existing CI workflow in `.github/workflows/` builds and tests the plugin workspace

### Release

- Bump version to `1.0.0` in `packages/plugin-multiplayer/package.json` and any dependent packages
- Update top-level CHANGELOG (if one exists) with the v1.0.0 entry
- Tag `v1.0.0`
- Publish via the existing `npm run publish:cli` workflow (or extend the publish workflow to include the multiplayer workspace)
- Verify the post-publish install flow on a fresh machine

---

## Out of scope (deferred to v2+)

All items from the master PRD's §12 / §13:

- Multi-session per user (v2.1)
- Real-time same-file co-editing (v3.0)
- Git worktree / branch / PR management
- File locks
- Mobile / tablet support
- Hosted signaling server (v2.0)
- Cross-session chat history
- Voice / video channels
- OAuth / passkey auth
- TURN relay (v2.0)
- Browser companion UI (v2.2)
- Per-user permissions / roles
- Anonymous read-only spectators
- Slack / Discord webhooks
- Intent persistence across host restart (v2.1)
- Real-time co-edit with Yjs CRDTs (v3.0)
- Voice channel (v3.0)

---

## Acceptance criteria

### Install

- [ ] `hl-plugins install multiplayer` on a clean machine succeeds
- [ ] Re-running `hl-plugins install multiplayer` is a no-op (no duplicate config entries, no error)
- [ ] `hl-plugins list` shows `multiplayer` after install
- [ ] `hl-plugins status multiplayer` shows the install path, version, and config state

### Uninstall

- [ ] `hl-plugins uninstall multiplayer` removes all plugin files
- [ ] After uninstall, `~/.opencode/config.json` no longer references `multiplayer`
- [ ] No orphan processes (signaling server, companion)
- [ ] `~/.hl-plugins/multiplayer/state.json` is preserved
- [ ] `hl-plugins uninstall multiplayer --purge` removes state.json too

### Pre-flight

- [ ] On a machine with no `cloudflared`: install warns but succeeds
- [ ] On a machine with no supported terminal: install warns but succeeds
- [ ] On a machine with no Bun: install fails with a clear error

### Commands

- [ ] Every command in §6.7 works: `join`, `leave`, `cancel-leave`, `volunteer`, `code`, `status`, `history`, `rejoin`, `intent`, free-text chat
- [ ] All commands work both as slash command (`/mp ...`) and from the companion input box
- [ ] `/mp history` shows the last N host transfers in this session (default 10)

### Reliability (smoke test matrix)

- [ ] Same-machine smoke test (Phase 01) passes
- [ ] LAN test (Phase 02) passes
- [ ] Companion pane + chat test (Phase 03) passes
- [ ] Intent + conflict test (Phase 04) passes
- [ ] Cloudflare Tunnel test (Phase 05) passes
- [ ] Heartbeat / crash test (Phase 06) passes
- [ ] All NFRs from the master PRD §7 are met

### Compatibility

- [ ] At least one smoke test passes on macOS
- [ ] At least one smoke test passes on Linux
- [ ] At least one smoke test passes on Windows (WSL)

### Docs

- [ ] `packages/plugin-multiplayer/README.md` exists with install + usage
- [ ] `docs/development/multiplayer/architecture.md` exists and is current
- [ ] `docs/development/multiplayer/cloudflare-setup.md` exists (from Phase 05)
- [ ] `docs/development/multiplayer/companion-fallback.md` exists
- [ ] `docs/development/multiplayer/PRD.md` links to all phase files
- [ ] `docs/development/multiplayer/phase-01.md` ... `phase-07.md` all exist

### CI

- [ ] `npm run typecheck` passes
- [ ] `npm run build` passes
- [ ] CI workflow is green
- [ ] Publish workflow is green (or `npm run publish:cli` works locally)

### Release

- [ ] `packages/plugin-multiplayer/package.json` version is `1.0.0`
- [ ] v1.0.0 is tagged in git
- [ ] v1.0.0 is published to npm
- [ ] `npm install -g @hmanlab/hl-plugins && hl-plugins install multiplayer` works on a fresh machine

---

## Test plan

### Fresh-machine install

```bash
# On a clean machine (no ~/.opencode/, no ~/.hl-plugins/):
npm install -g @hmanlab/hl-plugins
hl-plugins install multiplayer
hl-plugins list                       # expect: multiplayer
hl-plugins status multiplayer         # expect: version 1.0.0, install path, OK

# Open two terminals, run opencode, do the Phase 01 test → all good
```

### Idempotency

```bash
hl-plugins install multiplayer        # second time
hl-plugins list                       # expect: multiplayer (no duplicate)
cat ~/.opencode/config.json | jq      # expect: no duplicate entries
```

### Uninstall

```bash
# Have a session running:
opencode
# ... peer joins ...
# Now:
hl-plugins uninstall multiplayer
ps aux | grep multiplayer             # expect: no processes
ls ~/.opencode/plugin/                # expect: no multiplayer-tools.ts
ls ~/.opencode/skill/                 # expect: no multiplayer/
ls ~/.hl-plugins/multiplayer/state.json  # expect: still exists
hl-plugins uninstall multiplayer --purge
ls ~/.hl-plugins/multiplayer/         # expect: empty or gone
```

### Pre-flight (no cloudflared)

```bash
# On a machine without cloudflared:
which cloudflared                     # expect: nothing
hl-plugins install multiplayer
# expect: warning about cloudflared, but install succeeds
```

### Cross-platform smoke

```bash
# macOS:
opencode && /mp join <code> && /mp leave  # Phase 01 + 02 in one go

# Linux (Ubuntu 22.04):
# (same commands, expect same behavior)

# Windows (WSL):
# (same commands, expect same behavior)
```

### Release

```bash
# Final checks:
npm run typecheck
npm run build
npm run publish:cli                   # or: npm publish --workspace packages/plugin-multiplayer
# Then on a fresh machine:
npm install -g @hmanlab/hl-plugins
hl-plugins install multiplayer
# ... smoke test ...
```

---

## Files

```
# No new plugin code; this phase is mostly config + docs + release.

docs/development/multiplayer/
├── PRD.md                             # updated to link to all phase files
├── phase-01.md ... phase-07.md        # all shipped
├── architecture.md                    # new — companion model, UDS transport
├── cloudflare-setup.md                # from Phase 05
└── companion-fallback.md              # new — manual watch flow

packages/plugin-multiplayer/
├── README.md                          # new — user-facing
├── package.json                       # version bumped to 1.0.0
└── ...

docs/
└── adding-a-plugin.md                 # updated if contract changed

.github/workflows/
└── publish.yml                        # verified to include multiplayer workspace
```

---

## Components (this phase)

| Component | Change from Phase 06 |
|---|---|
| `install` (CLI) | Adds pre-flight checks (cloudflared, Bun, terminal) and idempotency verification |
| `uninstall` (CLI) | New — removes plugin files, kills processes, preserves state.json unless `--purge` |
| `history` command | New — surfaces recent host transfers from `state.json` |
| All other components | Unchanged from Phase 06 — this is the stabilization phase |

---

## References (PRD sections relevant to this phase)

- PRD §3 Goals — every goal must be met by 1.0.0
- PRD §6.7 — Commands (`/mp history` is the only one not yet implemented)
- PRD §7 NFRs — every NFR must be met by 1.0.0 (Privacy, Performance, Reliability, Compatibility, Install)
- PRD §11 Success metrics — adoption, engagement, reliability, privacy
- PRD §12 Out of scope — every item remains out of scope
- PRD §15 References — final link audit
- Master `AGENTS.md` — release flow (`release: vX.Y.Z` commit, tag, push, `npm run publish:cli`)
