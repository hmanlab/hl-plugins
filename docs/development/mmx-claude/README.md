# `@hl-plugins/mmx-claude` — Claude Code support for the mmx plugin

**Status:** Plan v1 — awaiting approval
**Owner:** hmanlab
**Target release:** v0.4.0
**Plugin scope:** New package in the `@hl-plugins/*` ecosystem, targeting Claude Code

---

## 1. Background

`@hl-plugins/mmx` exposes seven tools (`mmx_image`, `mmx_speech`, `mmx_video`, `mmx_music`, `mmx_search`, `mmx_vision`, `mmx_quota`) that wrap the official MiniMax `mmx-cli`. Today it ships **only as an OpenCode plugin** — the source lives in `packages/plugin-mmx/opencode/plugin/mmx-tools.ts` and uses `tool()` from `@opencode-ai/plugin`, so it cannot load in Claude Code.

We want Claude Code users to get the same seven tools without rewriting them.

## 2. Goals & non-goals

### Goals

- A Claude Code user can run `hl-plugins install mmx-claude` and end up with the seven mmx tools available as MCP tools inside Claude Code.
- The LLM (Claude) can call those tools automatically based on conversation context — e.g., when the user says "make a logo for my README", Claude invents the prompt and calls `mmx_image`.
- The existing `@hl-plugins/mmx` (OpenCode) package is unchanged. Same `mmx-cli` binary, same `mmx auth login` state — just two install records for the two agents.
- Strict parity of behavior between the two packages: same suspicious-path rules, same default output directory (`~/Desktop/mmx-output/`), same env-var override (`MMX_OUTPUT_DIR`).

### Non-goals (v1)

- No auto-assign / claim-review for Claude Code issues (out of scope; the triage bot is OpenCode-agnostic already).
- No new `mmx-cli` features. The plugin is a wrapper, not a feature surface.
- No cross-agent state sync (the two agents share `mmx-cli` state, not plugin state).
- No publish to npm in v1 — both packages stay `private: true` until the install flow is battle-tested.

## 3. The "who writes the prompt" question

We considered two transports before settling on MCP.

| | Slash commands (`/mmx-image ...`) | MCP tools (auto-call) |
|---|---|---|
| Triggered by | **User** types the command | **The LLM** based on context |
| Prompt source | User types it after the command | LLM generates it from the conversation |
| Visibility | User sees the exact `mmx ...` argv | LLM picks the args; user sees the result |
| Install | Markdown files only | SDK + build + bundle + config merge |
| Runtime | Whatever runs `mmx` | Node or Bun (we pick Bun) |
| Chainable in one turn | Limited — Claude uses Bash each time | Native — LLM composes tool calls |

**Decision: MCP.** Rationale:

1. **Parity with OpenCode.** The OpenCode plugin works because the LLM picks the tools. Slash commands on Claude Code would mean typing `/mmx-image <prompt>` every time and never having the agent generate visuals proactively.
2. **Prompt generation is the value.** When the user says "make a logo for my README", the LLM reading the README and inventing a detailed prompt is the actual product. Slash commands force the user to do that work.
3. **The install complexity is bounded.** One SDK dep, one build step, one config merge — small enough that the parity win is worth it.
4. **Slash commands can come later.** Non-breaking — a future v2 can ship `/mmx-image` alongside the MCP server for users who want explicit control.

## 4. Architecture

### Two packages, one shared binary

```
packages/
├── plugin-mmx/                        UNCHANGED — OpenCode plugin
│   ├── opencode/plugin/mmx-tools.ts   (uses @opencode-ai/plugin)
│   └── opencode/skill/mmx/SKILL.md
│
└── plugin-mmx-claude/                 NEW — Claude Code MCP package
    ├── package.json                   (hl-plugins contract: claudeMcp + claudeSkill)
    ├── tsconfig.json
    ├── bunfig.toml
    ├── src/lib.ts                     runMmx + path helpers (~50 lines, Bun.spawn)
    ├── claude/
    │   ├── mcp/mmx-mcp-server.ts      MCP server source
    │   └── skill/mmx/SKILL.md         Claude skill (copy of OpenCode skill, edited)
    ├── dist/mmx-mcp-server.js         bun build --target=bun output (gitignored)
    └── test/{lib,mcp-smoke}.test.ts
```

### Why a separate package (not one package, two install paths)

We could have extended `@hl-plugins/mmx` to also declare `claudeMcp` in its contract. We chose not to because:

- **Different runtime.** The OpenCode plugin runs inside OpenCode's Bun runtime and doesn't need a bundle. The Claude MCP server must be bundled and runnable as a standalone process — different build artifact.
- **Different distribution shape.** The OpenCode plugin ships a `.ts` source file the user copies into `~/.opencode/plugin/`. The Claude package ships a bundled `.js` and modifies `~/.claude.json`. Different install paths.
- **Closer to single-responsibility.** Each package owns exactly one runtime's integration. New contributors can read `plugin-mmx-claude/src/lib.ts` without context from the OpenCode plugin.
- **Discoverability.** `hl-plugins list` shows two distinct entries with two distinct names. Users on Claude Code see `mmx-claude` and know exactly what it is.

Trade-off: both packages duplicate ~50 lines of `src/lib.ts` (runMmx, resolveOutDir, suspicious-path detection). That's acceptable for v1; if divergence creeps in, we can extract a third workspace package later.

### Runtime: Bun at the seam

The MCP server is bundled with `bun build --target=bun` and Claude Code launches it with the `bun` command. We chose Bun because:

- The OpenCode plugin already uses `Bun.spawn` and we want to keep `src/lib.ts` symmetric between the two packages — Bun is the lowest-friction way to do that.
- Bun's `Bun.spawn` is meaningfully faster than `node:child_process.execFile` for the seven short-lived mmx-cli invocations.
- Bun is a single binary download — Claude Code users get it via the `requires` auto-install entry (`curl -fsSL https://bun.sh/install | bash`).

The trade-off is that Claude Code users without Bun will see an auto-install step. We accept this.

### The contract field

The `hl-plugins` contract gains two optional fields:

| Field | Type | Purpose |
|---|---|---|
| `claudeMcp` | string (path relative to packageDir) | Bundled MCP server the CLI copies and registers in `~/.claude.json`'s `mcpServers` |
| `claudeSkill` | string (path relative to packageDir) | Markdown skill the CLI copies to `~/.claude/skills/<plugin>/SKILL.md` |

Both are independent of the existing `opencodePlugin` and `opencodeSkill` fields. A plugin can declare any subset of the four.

## 5. Affected files

### New

```
packages/plugin-mmx-claude/package.json
packages/plugin-mmx-claude/tsconfig.json
packages/plugin-mmx-claude/bunfig.toml
packages/plugin-mmx-claude/src/lib.ts
packages/plugin-mmx-claude/claude/mcp/mmx-mcp-server.ts
packages/plugin-mmx-claude/claude/skill/mmx/SKILL.md
packages/plugin-mmx-claude/test/lib.test.ts
packages/plugin-mmx-claude/test/mcp-smoke.test.ts
docs/development/mmx-claude/README.md        (this file)
```

### Edited

```
packages/cli/src/lib/registry.ts             Add claudeMcp? + claudeSkill? to PluginManifest.contract
packages/cli/src/lib/paths.ts                Add claudeConfigDir(), claudeConfigFile(), hlPluginsDataDir()
packages/cli/src/lib/config.ts               Add addMcpServer(), removeMcpServer()
packages/cli/src/commands/install.ts         Extend copyPluginFiles + mergeConfig: copy MCP bundle, copy skill, merge ~/.claude.json
packages/cli/src/commands/uninstall.ts       Mirror: remove bundle, remove skill, remove mcpServers entry
packages/cli/src/commands/status.ts          Report Claude-side install state per plugin
package.json (root)                          Add @modelcontextprotocol/sdk devDep
README.md                                    Split plugin table row into two (OpenCode + Claude Code)
docs/architecture.md                         Document claudeMcp + claudeSkill fields; extend install-flow diagram
docs/adding-a-plugin.md                      Note dual-target pattern with examples
```

### Unchanged

```
packages/plugin-mmx/**                       Zero edits — the working OpenCode plugin stays as-is
```

## 6. Implementation phases

The work splits into three phases, ordered so each phase is independently shippable and demoable.

### Phase A — CLI contract + paths (foundation)

**Scope:** Extend `PluginManifest.contract` with `claudeMcp?` and `claudeSkill?`. Add the three new path helpers. No actual install behavior yet.

**Acceptance:**
- `packages/cli/src/lib/registry.ts` type-checks with the new fields
- `packages/cli/src/lib/paths.ts` exports `claudeConfigDir`, `claudeConfigFile`, `hlPluginsDataDir` — unit-tested for macOS / Linux / Windows path conventions
- `hl-plugins list` still works and shows the existing `mmx` plugin

**Why first:** every later phase depends on these types and helpers. Shipping the foundation alone is useful as a checkpoint for reviewers.

### Phase B — New package + MCP server

**Scope:** Create `packages/plugin-mmx-claude/` from scratch. The MCP server source (`claude/mcp/mmx-mcp-server.ts`) registers seven tools backed by `src/lib.ts`'s `runMmx`. The package's `package.json` declares the full `hl-plugins` contract. A `bun build` script bundles the server.

**Acceptance:**
- `bun run --filter @hl-plugins/mmx-claude build` produces `dist/mmx-mcp-server.js`
- `node test/mcp-smoke.test.ts` (run via tsx) spawns the bundle, sends a JSON-RPC `tools/list` request over stdio, and asserts all seven tool names come back
- `node test/lib.test.ts` covers suspicious-path rejection, env-var override, default dir resolution

**Why second:** this is the substantive code. Once it builds and the smoke test passes, the install side becomes mechanical.

### Phase C — Install / uninstall / status + docs

**Scope:** Wire the new contract fields into the install flow. Add `addMcpServer` / `removeMcpServer` helpers. Update status to report Claude-side state. Detection hint for `hl-plugins install mmx` on a Claude Code system. Update README, architecture.md, adding-a-plugin.md.

**Acceptance:**
- `hl-plugins install mmx-claude` on a clean Claude Code system:
  - Auto-installs Bun if missing
  - Auto-installs `mmx-cli` if missing
  - Prompts for API key (or reads `MMX_API_KEY`)
  - Copies `dist/mmx-mcp-server.js` to `~/.local/share/hl-plugins/mmx-claude/mmx-mcp-server.js`
  - Copies skill MD to `~/.claude/skills/mmx-claude/SKILL.md`
  - Merges `mcpServers.mmx-claude` into `~/.claude.json`
  - Runs `mmx quota` as the post-install smoke test
- `hl-plugins uninstall mmx-claude` reverses every step above
- `hl-plugins status mmx-claude` reports all five install points as present/missing
- `hl-plugins install mmx` on a system with `~/.claude/` but no `~/.opencode/` prints the hint and proceeds
- Typecheck, format:check, build all green
- Idempotent: re-running `install` is a no-op (same merge semantics as the OpenCode path)

**Why third:** depends on the foundation (Phase A) and the package artifact (Phase B).

## 7. Tests

| Test | Where | What it covers |
|---|---|---|
| Path helpers | `packages/cli/test/lib/paths.test.ts` | `claudeConfigDir`, `claudeConfigFile`, `hlPluginsDataDir` resolve to platform-correct paths |
| Contract types | `packages/cli/test/lib/registry.test.ts` | A `PluginManifest` with only `claudeMcp` validates; with only `opencodePlugin` validates; with both validates |
| MCP smoke | `packages/plugin-mmx-claude/test/mcp-smoke.test.ts` | Spawn bundle, JSON-RPC `tools/list`, assert seven tool names |
| `runMmx` lib | `packages/plugin-mmx-claude/test/lib.test.ts` | Suspicious-path rejection (HOME, ~/Desktop, /tmp, "."), env-var override, default dir |
| Install idempotency | manual / E2E | Re-running `hl-plugins install mmx-claude` does not duplicate config entries |

Unit tests live next to the package code. CI runs them via the existing `npm run typecheck` + a new `npm run test` script that walks the workspace.

## 8. Documentation updates

| Doc | Change |
|---|---|
| `README.md` | Split the plugin table row into two. Add a "Choosing the right package" one-liner. |
| `docs/architecture.md` | Document `claudeMcp` + `claudeSkill` fields in the contract section. Extend the install-flow diagram with a Claude Code branch. |
| `docs/adding-a-plugin.md` | Note the four contract fields (`opencodePlugin`, `opencodeSkill`, `claudeMcp`, `claudeSkill`) and that a plugin can declare any subset. Add a Claude Code example. |
| `docs/commands.md` | No change — the user-facing surface is unchanged. `hl-plugins install <name>` works for both packages. |

The new `docs/development/mmx-claude/README.md` (this file) captures the rationale and decisions for future maintainers.

## 9. Risks & open questions

| Risk | Severity | Mitigation |
|---|---|---|
| Bun is a new install requirement for Claude Code users | Medium | The `requires` entry auto-installs Bun via `curl -fsSL https://bun.sh/install \| bash`. Documented in the install output. |
| Two `mmx` entries in `hl-plugins list` | Low (cosmetic) | Acceptable — same auth, same `mmx-cli`, just two install records. |
| MCP bundle size | Low | ~100-200 KB (the `@modelcontextprotocol/sdk` pulled in). Negligible. |
| `~/.claude.json` shape changes between Claude Code versions | Low | Read the file fresh on every install/uninstall; never assume a static shape. Defensive parsing with a clear error message if the file is unrecognizable. |
| MCP tool name collisions across packages | Low | Namespaced — `mmx-claude` MCP server exposes tools as `mmx_image` etc. If a future plugin wants the same name, document the convention (prefix or namespace) and revisit. |
| Bundling drift between dev and prod | Medium | `bun build --target=bun` is the single source of truth. The `dist/` artifact is gitignored; CI builds it fresh on publish. |
| `src/lib.ts` divergence between the two packages | Low (now) | ~50 lines duplicated. Re-extract into a workspace-internal package if divergence appears. |

## 10. Out of scope (deferred)

- **Slash commands.** Not in v1. Could ship in a v2 alongside the MCP server for users who want explicit `/mmx-image <prompt>` invocation.
- **Auto-update of the MCP bundle.** The `hl-plugins update` command will need a Claude-side mirror of the OpenCode update path. Tracked separately.
- **Cross-agent state.** No shared plugin state between OpenCode and Claude Code beyond what `mmx-cli` already persists.
- **Publish to npm.** Both packages stay `private: true` until the install flow is battle-tested on a few real Claude Code installs.