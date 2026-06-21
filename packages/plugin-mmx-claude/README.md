# `@hl-plugins/mmx-claude`

Claude Code adapter for the seven MiniMax multimodal tools. Pairs with
[`@hl-plugins/mmx`](../plugin-mmx/README.md) (the OpenCode plugin) — same
`mmx-cli` binary, same auth, two install records.

> Status: **Plan v1** — implementation below is tracked phase by phase. Update
> the checkboxes as each item lands. Once all boxes in a phase are checked,
> that phase is done and the next one can start.

## What this package is

A new sibling of `@hl-plugins/mmx` that ships the same seven tools to
**Claude Code** instead of OpenCode, by exposing them through a **Model
Context Protocol (MCP) server** that Claude Code launches at startup.

| Runtime | Package | Transport |
|---|---|---|
| OpenCode | `@hl-plugins/mmx` | `tool()` from `@opencode-ai/plugin`, runs as `.ts` |
| Claude Code | `@hl-plugins/mmx-claude` *(this package)* | MCP server, bundled `.js` |

The two packages share `mmx-cli` state and the MiniMax API key — only the
delivery mechanism differs.

## Phase index

- [Phase A — CLI contract + paths](#phase-a--cli-contract--paths)
- [Phase B — New package + MCP server](#phase-b--new-package--mcp-server)
- [Phase C — Install / uninstall / status + docs](#phase-c--install--uninstall--status--docs)

Each phase is independently shippable and demoable. Stopping after any
phase leaves the tree green; only the matching acceptance criteria need to
hold at that point.

---

## Phase A — CLI contract + paths

**Scope.** Extend the `hl-plugins` manifest type with the two new Claude
fields, add the Claude-side path helpers, ship zero install behavior yet.
Every later phase depends on these types and helpers.

### Acceptance criteria

- [ ] `packages/cli/src/lib/registry.ts` exports `claudeMcp?: string` and
      `claudeSkill?: string` on `PluginManifest.hlPlugins`
- [ ] `packages/cli/src/lib/paths.ts` exports:
      - [ ] `claudeConfigDir()` — returns the Claude Code config directory
            per platform (`~/.claude/` on macOS/Linux, `%APPDATA%\Claude\`
            on Windows)
      - [ ] `claudeConfigFile()` — returns the path to `~/.claude.json`
      - [ ] `hlPluginsDataDir()` — returns `~/.local/share/hl-plugins/`
            (XDG-style; platform-correct on Windows)
- [ ] Existing `hl-plugins list` still works and shows the existing
      `mmx` plugin unchanged
- [ ] `npm run typecheck` passes
- [ ] New unit tests under `packages/cli/test/lib/paths.test.ts` cover
      `claudeConfigDir`, `claudeConfigFile`, `hlPluginsDataDir` for
      macOS / Linux / Windows path conventions

### Files touched

```
M packages/cli/src/lib/registry.ts
M packages/cli/src/lib/paths.ts
A packages/cli/test/lib/paths.test.ts
```

### Demo

```bash
npm run typecheck
node packages/cli/bin/hl-plugins.js list
# expected: shows @hl-plugins/mmx, no mmx-claude yet
```

---

## Phase B — New package + MCP server

**Scope.** Create `packages/plugin-mmx-claude/` from scratch. The MCP server
source registers the seven mmx tools backed by `src/lib.ts`'s `runMmx`. The
package's `package.json` declares the full `hl-plugins` contract. A
`bun build` script bundles the server into `dist/mmx-mcp-server.js`.

### Acceptance criteria

#### Package scaffolding

- [ ] `packages/plugin-mmx-claude/package.json` exists with `private: true`,
      name `@hl-plugins/mmx-claude`, and a full `hl-plugins` contract:
      - [ ] `opencodePlugin` / `opencodeSkill` omitted (not an OpenCode plugin)
      - [ ] `claudeMcp: "./dist/mmx-mcp-server.js"`
      - [ ] `claudeSkill: "./claude/skill/mmx/SKILL.md"`
      - [ ] `requires` includes `mmx-cli` and `bun`
      - [ ] `auth` block carried over from `@hl-plugins/mmx`
- [ ] `packages/plugin-mmx-claude/tsconfig.json` extends the base config
- [ ] `packages/plugin-mmx-claude/bunfig.toml` is present
- [ ] Workspace `package.json` lists the new package under `workspaces`

#### Source files

- [ ] `src/lib.ts` exports `runMmx`, `resolveOutDir`, and the
      suspicious-path detector (~50 lines, `Bun.spawn`)
- [ ] `claude/mcp/mmx-mcp-server.ts` registers the seven tools via the
      `@modelcontextprotocol/sdk` Server class:
      - [ ] `mmx_image`
      - [ ] `mmx_speech`
      - [ ] `mmx_video`
      - [ ] `mmx_music`
      - [ ] `mmx_search`
      - [ ] `mmx_vision`
      - [ ] `mmx_quota`
- [ ] `claude/skill/mmx/SKILL.md` mirrors the OpenCode skill's content,
      edited for Claude Code context (no `@opencode-ai/plugin` references)

#### Build

- [ ] `bun run --filter @hl-plugins/mmx-claude build` produces
      `packages/plugin-mmx-claude/dist/mmx-mcp-server.js`
- [ ] `dist/` is listed in `.gitignore`
- [ ] `npm run typecheck` passes across the workspace

#### Tests

- [ ] `test/lib.test.ts` covers:
      - [ ] Suspicious-path rejection (HOME, ~/Desktop, /tmp, `.`, `..`)
      - [ ] `MMX_OUTPUT_DIR` env-var override wins over the default
      - [ ] Default `~/Desktop/mmx-output/` resolution
- [ ] `test/mcp-smoke.test.ts` spawns the bundle over stdio, sends a
      JSON-RPC `tools/list` request, and asserts all seven tool names
      appear in the response

### Files touched

```
A packages/plugin-mmx-claude/package.json
A packages/plugin-mmx-claude/tsconfig.json
A packages/plugin-mmx-claude/bunfig.toml
A packages/plugin-mmx-claude/src/lib.ts
A packages/plugin-mmx-claude/claude/mcp/mmx-mcp-server.ts
A packages/plugin-mmx-claude/claude/skill/mmx/SKILL.md
A packages/plugin-mmx-claude/test/lib.test.ts
A packages/plugin-mmx-claude/test/mcp-smoke.test.ts
M package.json                                   # add @modelcontextprotocol/sdk devDep
M packages/plugin-mmx-claude/.gitignore        # OR root .gitignore (dist)
```

### Demo

```bash
bun run --filter @hl-plugins/mmx-claude build
node packages/plugin-mmx-claude/test/mcp-smoke.test.ts
# expected: stdout lists mmx_image, mmx_speech, mmx_video, mmx_music,
#           mmx_search, mmx_vision, mmx_quota
```

---

## Phase C — Install / uninstall / status + docs

**Scope.** Wire the new contract fields into the install flow. Add
`addMcpServer` / `removeMcpServer` helpers. Update status to report
Claude-side state. Add the install hint for Claude Code systems. Update
`README.md`, `docs/architecture.md`, and `docs/adding-a-plugin.md`.

### Acceptance criteria

#### Helpers

- [ ] `packages/cli/src/lib/config.ts` exports `addMcpServer(name, spec)`
      and `removeMcpServer(name)` — defensive `~/.claude.json` parsing
      with a clear error if the file is unrecognizable
- [ ] `packages/cli/src/commands/install.ts` extended:
      - [ ] Copies the `claudeMcp` bundle to
            `~/.local/share/hl-plugins/<plugin>/<file>` and updates the
            bundle's on-disk path in the MCP spec before merging
      - [ ] Copies the `claudeSkill` markdown to
            `~/.claude/skills/<plugin>/SKILL.md`
      - [ ] Calls `addMcpServer` to merge the spec into `~/.claude.json`
      - [ ] All three steps are idempotent (same merge semantics as the
            OpenCode path)
- [ ] `packages/cli/src/commands/uninstall.ts` extended:
      - [ ] Removes the bundle from `~/.local/share/hl-plugins/<plugin>/`
      - [ ] Removes the skill from `~/.claude/skills/<plugin>/`
      - [ ] Calls `removeMcpServer` to drop the entry from `~/.claude.json`
- [ ] `packages/cli/src/commands/status.ts` extended to report all five
      Claude-side install points per plugin as present/missing
- [ ] Install hint: when `hl-plugins install mmx` runs on a system with
      `~/.claude/` present but no `~/.opencode/`, prints a hint about
      `mmx-claude` and proceeds with the OpenCode install

#### Documentation

- [ ] `README.md` — split the plugin table row into two
      (OpenCode + Claude Code), add a "Choosing the right package"
      one-liner
- [ ] `docs/architecture.md` — document `claudeMcp` + `claudeSkill` in
      the contract section; extend the install-flow diagram with a
      Claude Code branch
- [ ] `docs/adding-a-plugin.md` — note the four contract fields
      (`opencodePlugin`, `opencodeSkill`, `claudeMcp`, `claudeSkill`) and
      that a plugin can declare any subset; add a Claude Code example

#### End-to-end smoke

- [ ] `hl-plugins install mmx-claude` on a clean Claude Code system:
      - [ ] Auto-installs Bun if missing (via the `requires` entry)
      - [ ] Auto-installs `mmx-cli` if missing
      - [ ] Prompts for API key (or reads `MMX_API_KEY`)
      - [ ] Copies the MCP bundle to
            `~/.local/share/hl-plugins/mmx-claude/mmx-mcp-server.js`
      - [ ] Copies the skill MD to `~/.claude/skills/mmx-claude/SKILL.md`
      - [ ] Merges `mcpServers.mmx-claude` into `~/.claude.json`
      - [ ] Runs `mmx quota` as the post-install smoke test
- [ ] `hl-plugins uninstall mmx-claude` reverses every step above
- [ ] `hl-plugins status mmx-claude` reports all five install points
- [ ] `hl-plugins install mmx` on a system with `~/.claude/` but no
      `~/.opencode/` prints the hint and proceeds
- [ ] Re-running `hl-plugins install mmx-claude` is a no-op (idempotent)
- [ ] `npm run typecheck` + `npm run build` both green

### Files touched

```
M packages/cli/src/lib/config.ts
M packages/cli/src/commands/install.ts
M packages/cli/src/commands/uninstall.ts
M packages/cli/src/commands/status.ts
M README.md
M docs/architecture.md
M docs/adding-a-plugin.md
```

### Demo

```bash
node packages/cli/bin/hl-plugins.js install mmx-claude
# expected: Bun auto-installs (if missing) -> mmx-cli auto-installs (if
#           missing) -> API key prompt -> bundle copied -> skill copied
#           -> ~/.claude.json merged -> mmx quota smoke test -> green
#           checkmarks per step

node packages/cli/bin/hl-plugins.js status mmx-claude
# expected: five green checks (bundle, skill, mcpServers entry,
#           auth present, mmx quota responds)

node packages/cli/bin/hl-plugins.js uninstall mmx-claude
# expected: every install step reversed, exit 0
```

---

## Cross-phase checklist

These items are not tied to one phase; they belong to the whole feature
and should land before merge.

- [ ] `packages/plugin-mmx` source is **untouched** — zero edits, the
      OpenCode plugin stays as-is
- [ ] Both packages stay `private: true` until the install flow is
      battle-tested on real Claude Code installs
- [ ] `~/Desktop/mmx-output/` is the default output directory in both
      packages; `MMX_OUTPUT_DIR` overrides it in both
- [ ] Same suspicious-path rules apply in both packages (no writes to
      HOME, ~/Desktop, /tmp, or `.`)
- [ ] No secrets committed; `MMX_API_KEY` is read from env, never echoed
- [ ] All `.ts` strict-mode clean; `npm run typecheck` green across the
      workspace
- [ ] No npm publish from the agent — the human maintainer runs
      `npm run publish:cli`

## Out of scope (deferred)

- Slash commands (`/mmx-image ...`) — could ship in a v2 alongside the
  MCP server for explicit user-driven invocation
- Auto-update of the MCP bundle — `hl-plugins update` will need a
  Claude-side mirror; tracked separately
- Cross-agent plugin state sync — the two agents share `mmx-cli` state,
  nothing else
- Publishing either package to npm — both stay `private: true` until the
  install flow is battle-tested